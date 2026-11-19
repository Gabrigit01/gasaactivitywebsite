import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createApplication } from '../server.js';
import { openDatabase, postgresDatabase } from '../database.js';
import { localPostgres } from './postgres-helper.js';

function client(origin, cookies = new Map()) {
  return {
    cookies,
    async request(path, { method = 'GET', body } = {}) {
      const response = await fetch(origin + path, {
        method,
        headers: {
          'X-Forwarded-Proto': 'https',
          Origin: 'https://test-gasa.onrender.com',
          Cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; '),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [name, ...value] = cookie.split(';')[0].split('=');
        cookies.set(name, value.join('='));
      }
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data, headers: response.headers };
    },
  };
}

for (const dialect of ['sqlite', 'postgres']) {
  test('parcours étudiants et comité sur ' + dialect, async t => {
    const overrides = {
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', TRUST_PROXY: '1',
      PUBLIC_URL: '', RENDER_EXTERNAL_URL: 'https://test-gasa.onrender.com',
      ADMIN_OWNER_USERNAME: 'test-owner', ADMIN_OWNER_PASSWORD: 'test-owner-password-2026',
      ADMIN_ORGANIZER_USERNAME: 'test-editor', ADMIN_ORGANIZER_PASSWORD: 'test-editor-password-2026',
      ADMIN_VIEWER_USERNAME: 'test-viewer', ADMIN_VIEWER_PASSWORD: 'test-viewer-password-2026',
      STUDENT_SIGNUP_CODE: '', VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
    };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-db-test-')) : null;
    const db = dialect === 'postgres' ? await localPostgres() : await openDatabase({ connectionString: '', dataDir: directory });
    let application;
    const start = async () => {
      application = await createApplication({ database: { ...db, close: async () => {} } });
      if (!application.server.listening) await once(application.server, 'listening');
      return 'http://127.0.0.1:' + application.server.address().port;
    };
    t.after(async () => {
      await application?.close();
      await db.close();
      if (directory && directory.startsWith(join(tmpdir(), 'gasa-db-test-'))) await rm(directory, { recursive: true, force: true });
    });
    let origin = await start();
    const visitor = client(origin);
    assert.equal((await visitor.request('/healthz')).status, 200);
    let home = (await visitor.request('/api/home')).data;
    assert.equal(home.poll.activities.length, 7);
    assert.equal(home.poll.responded, false);
    assert.equal((await visitor.request('/api/admin/dashboard')).status, 401);
    assert.equal((await visitor.request('/api/sessions/prochaine-seance/vote', { method: 'POST', body: {} })).status, 401);

    const token = randomBytes(32).toString('hex');
    const legacy = createHash('sha256').update(token).digest('hex');
    visitor.cookies.set('gasa_participant', token);
    await db.prepare('INSERT INTO votes (sessionId, participant, activityId, optionId, optionLabel) VALUES (?, ?, ?, ?, ?)')
      .run('prochaine-seance', legacy, 'cinema', 'option-1', 'Documentaire & innovation');
    assert.equal((await visitor.request('/api/home')).data.poll.responded, false, 'un invité ne reçoit pas une confirmation historique');
    const register = await visitor.request('/api/student/register', {
      method: 'POST', body: { name: 'Étudiant Test', email: 'student-test@example.test', password: 'student-test-password-2026' },
    });
    assert.equal(register.status, 201);
    assert.ok(register.headers.getSetCookie().some(cookie => cookie.includes('__Host-gasa_student=') && cookie.includes('Secure') && cookie.includes('HttpOnly')));
    assert.equal((await visitor.request('/api/home')).data.poll.responded, true, 'migration après connexion seulement');
    assert.equal((await visitor.request('/api/sessions/projection-campus/feedback', {
      method: 'POST', body: { rating: 4, comment: 'Très bonne séance de test.' },
    })).status, 201);
    const second = client(origin);
    assert.equal((await second.request('/api/student/register', {
      method: 'POST', body: { name: 'Autre Étudiant', email: 'second-test@example.test', password: 'second-test-password-2026' },
    })).status, 201);
    const simultaneous = await Promise.all([1, 2].map(() => second.request('/api/sessions/prochaine-seance/vote', {
      method: 'POST', body: { activityId: 'cinema', optionId: 'option-1' },
    })));
    assert.deepEqual(simultaneous.map(result => result.status).sort(), [201, 409]);

    const admins = {};
    for (const [role, username, password] of [
      ['owner', overrides.ADMIN_OWNER_USERNAME, overrides.ADMIN_OWNER_PASSWORD],
      ['editor', overrides.ADMIN_ORGANIZER_USERNAME, overrides.ADMIN_ORGANIZER_PASSWORD],
      ['viewer', overrides.ADMIN_VIEWER_USERNAME, overrides.ADMIN_VIEWER_PASSWORD],
    ]) {
      admins[role] = client(origin);
      assert.equal((await admins[role].request('/api/admin/login', { method: 'POST', body: { username, password } })).status, 200);
      assert.equal((await admins[role].request('/api/admin/dashboard')).status, 200);
    }
    const owner = admins.owner;
    const announcement = {
      activityId: 'cinema', mode: 'surprise', hint: 'Un indice de test.', location: 'Campus',
      date: new Date(Date.now() + 86_400_000).toISOString(), revealAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    assert.equal((await admins.viewer.request('/api/admin/sessions/prochaine-seance', { method: 'PUT', body: { title: 'Interdit' } })).status, 403);
    assert.equal((await admins.editor.request('/api/admin/sessions/prochaine-seance', { method: 'PUT', body: { status: 'archived' } })).status, 403);
    assert.equal((await owner.request('/api/admin/sessions/prochaine-seance', { method: 'PUT', body: { title: 'Cinéma confidentiel', announcement } })).status, 200);
    home = (await second.request('/api/home')).data;
    assert.equal(home.announcement.revealed, false);
    assert.equal(home.announcement.activity, null);
    assert.equal(home.announcement.title, 'Activité mystère');
    assert.equal(home.poll.title, 'Activité mystère');
    assert.equal((await second.request('/api/sessions/prochaine-seance/guess', { method: 'POST', body: { activityId: 'cinema' } })).status, 201);
    const results = (await owner.request('/api/admin/sessions/prochaine-seance/results')).data;
    assert.equal(results.votes.reduce((sum, item) => sum + item.count, 0), 2);
    assert.equal(results.guesses, 1);
    const feedback = (await owner.request('/api/admin/sessions/projection-campus/results')).data.feedback[0];
    assert.equal(feedback.rating, 4);
    assert.equal((await admins.editor.request('/api/admin/sessions/projection-campus/feedback/' + feedback.id, { method: 'PUT', body: { hidden: true } })).status, 200);
    assert.equal((await admins.viewer.request('/api/admin/sessions/prochaine-seance/export/xlsx')).status, 403);
    const exported = await owner.request('/api/admin/sessions/prochaine-seance/export/xlsx');
    assert.equal(exported.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.data);
    assert.ok(workbook.getWorksheet('Synthèse').getSheetValues().some(row => row?.[1] === 'Activité retenue' && row?.[2] === 'Cinéma'));
    assert.equal((await owner.request('/api/admin/sessions/prochaine-seance/export/docx')).data.subarray(0, 2).toString(), 'PK');
    assert.deepEqual((await owner.request('/api/admin/sessions/prochaine-seance/qr/vote')).data.subarray(0, 4), Buffer.from([137, 80, 78, 71]));
    assert.equal((await owner.request('/api/admin/sessions/prochaine-seance', { method: 'PUT', body: { voteOpen: false } })).status, 200);
    const closed = await second.request('/api/sessions/prochaine-seance/vote', { method: 'POST', body: { activityId: 'cinema', optionId: 'option-1' } });
    assert.equal(closed.status, 409);
    assert.match(closed.data.error, /fermé/);
    assert.equal((await owner.request('/api/admin/sessions/prochaine-seance', { method: 'PUT', body: { voteOpen: true } })).status, 200);
    const allActivities = (await owner.request('/api/admin/dashboard')).data.activities;
    const archived = await Promise.all(allActivities.map(activity => owner.request('/api/admin/activities/' + activity.id, {
      method: 'PUT', body: { archived: true },
    })));
    assert.ok(archived.every(result => result.status === 200));
    assert.equal((await second.request('/api/home')).data.poll.open, false, 'archivages simultanés ferment le dernier choix');
    assert.equal((await owner.request('/api/admin/sessions/prochaine-seance', { method: 'PUT', body: { voteOpen: true } })).status, 400);
    const snapshot = new Map(second.cookies);
    await application.close();
    origin = await start();
    const restored = client(origin, snapshot);
    assert.equal((await restored.request('/api/student/session')).data.authenticated, true, 'session conservée après redémarrage');
    assert.equal((await restored.request('/api/home')).data.poll.responded, true);
    assert.equal((await restored.request('/api/student/logout', { method: 'POST', body: {} })).status, 200);
    assert.equal((await client(origin, snapshot).request('/api/student/session')).data.authenticated, false);
    assert.equal((await restored.request('/api/home')).data.poll.responded, false);
    const adminAfterRestart = client(origin, new Map(owner.cookies));
    const dashboard = (await adminAfterRestart.request('/api/admin/dashboard')).data;
    assert.equal(dashboard.activities.length, 7, 'redémarrage sans réinitialisation des données');
  });
}

test('libération du client PostgreSQL si BEGIN échoue', async () => {
  let releases = 0;
  const db = postgresDatabase({
    connect: async () => ({ query: async () => { throw new Error('déconnexion simulée'); }, release: () => { releases++; } }),
  });
  await assert.rejects(db.transaction(async () => {}));
  assert.equal(releases, 1);
});
