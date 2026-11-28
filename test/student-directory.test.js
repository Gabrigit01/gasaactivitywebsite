import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import express from 'express';
import { openDatabase } from '../database.js';
import { DirectoryError, installDirectory } from '../student-directory.js';
import { localPostgres } from './postgres-helper.js';

const capabilities = {
  owner: ['read', 'edit', 'archive'], organizer: ['read', 'edit'], viewer: ['read'],
};

for (const dialect of ['sqlite', 'postgres']) {
  test('filières et profils académiques sur ' + dialect, async t => {
    const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-directory-')) : null;
    const db = dialect === 'postgres' ? await localPostgres() : await openDatabase({ connectionString: '', dataDir: directory });
    let server;
    let module;
    let rejectAudit = false;
    await db.exec(`
      CREATE TABLE student_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
      CREATE TABLE directory_test_actions (kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL);
    `);
    for (const id of ['alice', 'bob']) {
      await db.prepare('INSERT INTO student_accounts (id,name,email) VALUES (?,?,?)').run(id, id, id + '@example.test');
    }
    const auth = {
      requireAdmin(capability) {
        return (req, res, next) => {
          const role = req.get('X-Role');
          if (!capabilities[role]) return res.status(401).json({ error: 'Connexion requise.' });
          if (!capabilities[role].includes(capability)) return res.status(403).json({ error: 'Accès refusé.' });
          req.admin = { username: role, role, capabilities: capabilities[role] };
          next();
        };
      },
      async requireStudent(req, res, next) {
        const id = req.get('X-Student');
        req.student = id && await db.prepare('SELECT * FROM student_accounts WHERE id=?').get(id);
        if (!req.student) return res.status(401).json({ error: 'Connexion requise.' });
        next();
      },
    };
    const record = async ({ kind, student, admin, detail }) => {
      if (rejectAudit) throw new Error('Échec de l’audit simulé.');
      await db.prepare('INSERT INTO directory_test_actions (kind,actor,detail) VALUES (?,?,?)')
        .run(kind, student?.id || admin.username, detail);
    };
    const start = async () => {
      const app = express();
      app.use(express.json());
      const api = express.Router();
      app.use('/api', api);
      module = await installDirectory({ api, db, auth, mutate: work => db.transaction(work), record });
      app.use((error, req, res, next) => {
        res.status(error instanceof DirectoryError ? error.status : 500).json({ error: error.message });
      });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return 'http://127.0.0.1:' + server.address().port;
    };
    const stop = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    t.after(async () => {
      if (server?.listening) await stop();
      await db.close();
      if (directory) {
        const target = resolve(directory);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('gasa-directory-'));
        await rm(target, { recursive: true, force: true });
      }
    });
    let origin = await start();
    const request = async (path, { role, student, method = 'GET', body } = {}) => {
      const response = await fetch(origin + '/api' + path, {
        method, headers: {
          ...(role ? { 'X-Role': role } : {}), ...(student ? { 'X-Student': student } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        }, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    };
    const auditCount = async () => Number((await db.prepare('SELECT COUNT(*) AS count FROM directory_test_actions').get()).count);
    let customId;

    await t.test('catalogue initial et permissions', async () => {
      const initial = await request('/programs');
      assert.equal(initial.status, 200);
      assert.deepEqual(initial.data.years, [1, 2, 3]);
      assert.deepEqual(initial.data.programs.map(item => [item.id, item.name]).sort(), [
        ['ge-si', 'GE/SI'], ['ge-sil', 'GE/SIL'], ['ge-rit', 'GE/RIT'], ['ge-ascii', 'GE/ASCII'],
      ].sort());
      assert.ok(initial.data.programs.every(item => item.archived === false));
      assert.equal((await request('/admin/programs')).status, 401);
      const viewer = await request('/admin/programs', { role: 'viewer' });
      assert.equal(viewer.status, 200);
      assert.ok(viewer.data.programs.every(item => item.studentCount === 0));
      for (const options of [{}, { role: 'viewer' }]) {
        assert.equal((await request('/admin/programs', { ...options, method: 'POST', body: { name: 'Test' } })).status,
          options.role ? 403 : 401);
      }
      assert.equal((await request('/student/academic-profile')).status, 401);
      assert.equal((await request('/student/academic-profile', { method: 'PUT', body: {} })).status, 401);
      assert.deepEqual((await request('/student/academic-profile', { student: 'alice' })).data, {
        programId: null, programName: null, studyYear: null, programArchived: null,
        updatedAt: null, firstName: null, lastName: null,
      });
    });

    await t.test('création, unicité, validation et modification atomique', async () => {
      for (const name of [undefined, '', '   ', 42, 'A'.repeat(121), 'GE\n/SI', 'GE\u0000SI', 'GE\u0085SI']) {
        assert.equal((await request('/admin/programs', { role: 'organizer', method: 'POST', body: { name } })).status, 400);
      }
      assert.equal((await request('/admin/programs', { role: 'owner', method: 'POST', body: { name: ' ge/si ' } })).status, 409);
      const created = await request('/admin/programs', { role: 'organizer', method: 'POST', body: { name: '  Nouvelle   Filière  ' } });
      assert.equal(created.status, 201);
      assert.equal(created.data.name, 'Nouvelle Filière');
      assert.equal(created.data.archived, false);
      customId = created.data.id;
      assert.equal((await request('/admin/programs', { role: 'owner', method: 'POST', body: { name: 'NOUVELLE FILIÈRE' } })).status, 409);
      const before = await auditCount();
      assert.equal((await request('/admin/programs/' + customId, {
        role: 'owner', method: 'PUT', body: { name: 'ge/sil', archived: true },
      })).status, 409);
      assert.deepEqual({ ...await db.prepare('SELECT name,archived FROM study_programs WHERE id=?').get(customId) }, {
        name: 'Nouvelle Filière', archived: 0,
      });
      assert.equal(await auditCount(), before);
      for (const archived of ['true', 1, null]) {
        assert.equal((await request('/admin/programs/' + customId, { role: 'owner', method: 'PUT', body: { archived } })).status, 400);
      }
      assert.equal((await request('/admin/programs/inconnu', { role: 'owner', method: 'PUT', body: { name: 'Absent' } })).status, 404);
      assert.equal((await request('/admin/programs/' + customId, { role: 'viewer', method: 'PUT', body: { name: 'Interdit' } })).status, 403);
      const concurrent = await Promise.all(['Informatique', 'informatique'].map(name => request('/admin/programs', {
        role: 'owner', method: 'POST', body: { name },
      })));
      assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
      rejectAudit = true;
      try {
        assert.equal((await request('/admin/programs/' + customId, { role: 'owner', method: 'PUT', body: { name: 'Annulé' } })).status, 500);
        assert.equal((await db.prepare('SELECT name FROM study_programs WHERE id=?').get(customId)).name, 'Nouvelle Filière');
      } finally { rejectAudit = false; }
    });

    await t.test('profil authentifié, année stricte et sauvegarde idempotente', async () => {
      for (const studyYear of [undefined, null, 0, 4, 1.5, '1', true]) {
        assert.equal((await request('/student/academic-profile', {
          student: 'alice', method: 'PUT', body: { programId: 'ge-si', studyYear },
        })).status, 400);
      }
      assert.equal((await request('/student/academic-profile', { student: 'alice', method: 'PUT', body: { studyYear: 1 } })).status, 400);
      assert.equal((await request('/student/academic-profile', {
        student: 'alice', method: 'PUT', body: { programId: 'inconnu', studyYear: 1 },
      })).status, 400);
      const body = { programId: 'ge-si', studyYear: 2, firstName: '  Alice  ', lastName: 'Étudiante' };
      const saved = await request('/student/academic-profile', { student: 'alice', method: 'PUT', body });
      assert.equal(saved.status, 200);
      assert.equal(saved.data.firstName, 'Alice');
      assert.equal(saved.data.lastName, 'Étudiante');
      assert.equal(saved.data.programName, 'GE/SI');
      assert.equal(saved.data.programArchived, false);
      assert.equal(saved.data.studyYear, 2);
      assert.ok(Date.parse(saved.data.updatedAt));
      const before = await auditCount();
      assert.deepEqual((await request('/student/academic-profile', { student: 'alice', method: 'PUT', body })).data, saved.data);
      assert.equal(await auditCount(), before, 'une sauvegarde identique ne crée pas un nouvel événement');
      assert.equal((await request('/student/academic-profile', {
        student: 'alice', method: 'PUT', body: { studyYear: 3, firstName: 'A\nB' },
      })).status, 400);
      assert.deepEqual((await request('/student/academic-profile', { student: 'alice' })).data, saved.data);
      const changed = await request('/student/academic-profile', { student: 'alice', method: 'PUT', body: { studyYear: 3 } });
      assert.equal(changed.data.studyYear, 3);
      assert.equal(changed.data.firstName, 'Alice');
      assert.equal((await request('/student/academic-profile', { student: 'bob' })).data.programId, null);
      const adminPrograms = (await request('/admin/programs', { role: 'viewer' })).data.programs;
      assert.equal(adminPrograms.find(item => item.id === 'ge-si').studentCount, 1);
      const events = await db.prepare('SELECT * FROM directory_test_actions WHERE kind=?').all('student.academic-update');
      assert.equal(events.length, 2);
      assert.ok(events.every(event => event.actor === 'alice' && event.detail.includes('GE/SI')));
    });

    await t.test('archivage réservé, profils conservés et restauration', async () => {
      assert.equal((await request('/admin/programs/ge-si', { role: 'organizer', method: 'PUT', body: { archived: true } })).status, 403);
      assert.equal((await request('/admin/programs/ge-si', { role: 'owner', method: 'PUT', body: { archived: true } })).status, 200);
      assert.ok(!(await request('/programs')).data.programs.some(item => item.id === 'ge-si'));
      const archivedProfile = (await request('/student/academic-profile', { student: 'alice' })).data;
      assert.equal(archivedProfile.programId, 'ge-si');
      assert.equal(archivedProfile.programArchived, true);
      assert.equal((await request('/student/academic-profile', {
        student: 'bob', method: 'PUT', body: { programId: 'ge-si', studyYear: 1 },
      })).status, 409);
      assert.equal((await request('/student/academic-profile', {
        student: 'alice', method: 'PUT', body: { programId: 'ge-si', studyYear: 1 },
      })).status, 200, 'le détenteur conserve sa filière archivée et change d’année');
      assert.equal((await request('/admin/programs/ge-si', { role: 'organizer', method: 'PUT', body: { archived: false } })).status, 403);
      assert.equal((await request('/admin/programs/ge-si', { role: 'owner', method: 'PUT', body: { archived: false } })).status, 200);
      assert.equal((await request('/student/academic-profile', {
        student: 'bob', method: 'PUT', body: { programId: 'ge-si', studyYear: 1 },
      })).status, 200);
      assert.equal((await request('/admin/programs/ge-si', { role: 'owner', method: 'PUT', body: { archived: true } })).status, 200);
      assert.equal((await request('/admin/programs', { role: 'viewer' })).data.programs.find(item => item.id === 'ge-si').studentCount, 2);
      const before = await auditCount();
      assert.equal((await request('/admin/programs/ge-si', { role: 'owner', method: 'PUT', body: { archived: true } })).status, 200);
      assert.equal(await auditCount(), before);
    });

    await t.test('profil et audit participent à la transaction de l’inscription', async () => {
      const before = await auditCount();
      await assert.rejects(db.transaction(async () => {
        const student = { id: 'registration-rollback', name: 'Test', email: 'rollback@example.test' };
        await db.prepare('INSERT INTO student_accounts (id,name,email) VALUES (?,?,?)').run(student.id, student.name, student.email);
        await module.saveAcademicProfile(student.id, { programId: 'ge-sil', studyYear: 2 }, student);
        throw new Error('Inscription annulée.');
      }), /Inscription annulée/);
      assert.equal(await db.prepare('SELECT id FROM student_accounts WHERE id=?').get('registration-rollback'), undefined);
      assert.equal(await db.prepare('SELECT student_id FROM academic_profiles WHERE student_id=?').get('registration-rollback'), undefined);
      assert.equal(await auditCount(), before);
      rejectAudit = true;
      try {
        assert.equal((await request('/student/academic-profile', {
          student: 'alice', method: 'PUT', body: { programId: 'ge-sil', studyYear: 2 },
        })).status, 500);
        const profile = await module.readAcademicProfile('alice');
        assert.equal(profile.programId, 'ge-si');
        assert.equal(profile.studyYear, 1);
      } finally { rejectAudit = false; }
    });

    await t.test('le redémarrage ne réinitialise pas le catalogue', async () => {
      assert.equal((await request('/admin/programs/ge-sil', {
        role: 'organizer', method: 'PUT', body: { name: 'Filière renommée' },
      })).status, 200);
      await db.prepare('DELETE FROM study_programs WHERE id=?').run('ge-ascii');
      await stop();
      origin = await start();
      const programs = (await request('/admin/programs', { role: 'viewer' })).data.programs;
      assert.equal(programs.find(item => item.id === 'ge-si').archived, true);
      assert.equal(programs.find(item => item.id === 'ge-si').studentCount, 2);
      assert.equal(programs.find(item => item.id === 'ge-sil').name, 'Filière renommée');
      assert.ok(programs.some(item => item.id === customId));
      assert.ok(!programs.some(item => item.id === 'ge-ascii'), 'le seed ne recrée pas les données après sa migration');
      assert.equal((await module.readAcademicProfile('alice')).programArchived, true);
      const events = await db.prepare("SELECT * FROM directory_test_actions WHERE kind LIKE 'admin.program-%'").all();
      assert.ok(events.some(event => event.kind === 'admin.program-create' && event.actor === 'organizer' && event.detail === 'Nouvelle Filière'));
      assert.ok(events.some(event => event.kind === 'admin.program-update' && event.actor === 'owner' && event.detail === 'GE/SI'));
    });
  });
}
