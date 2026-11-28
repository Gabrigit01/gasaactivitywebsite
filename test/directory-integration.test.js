import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { createApplication } from '../server.js';
import { openDatabase } from '../database.js';
import { localPostgres } from './postgres-helper.js';

function configureEnvironment(t) {
  const values = {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', TRUST_PROXY: '',
    PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', RENDER: '', DATABASE_URL: '',
    ADMIN_OWNER_USERNAME: 'directory-owner', ADMIN_OWNER_PASSWORD: 'directory-owner-password-2026',
    ADMIN_ORGANIZER_USERNAME: 'directory-organizer', ADMIN_ORGANIZER_PASSWORD: 'directory-organizer-password-2026',
    ADMIN_VIEWER_USERNAME: 'directory-viewer', ADMIN_VIEWER_PASSWORD: 'directory-viewer-password-2026',
    STUDENT_SIGNUP_CODE: '', VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
    SMTP_HOST: '', SMTP_FROM: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASSWORD: '',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return values;
}

function client(origin, cookies = new Map()) {
  return {
    cookies,
    async request(path, { method = 'GET', body } = {}) {
      const response = await fetch(origin + path, {
        method,
        headers: { Origin: origin, Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
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

const alice = { name: 'Alice Directory', firstName: 'Alice', lastName: 'Directory',
  email: 'alice-directory@example.test', password: 'alice-directory-password-2026', programId: 'ge-si', studyYear: 1 };
const bruno = { name: 'Bruno Directory', firstName: 'Bruno', lastName: 'Directory',
  email: 'bruno-directory@example.test', password: 'bruno-directory-password-2026', programId: 'ge-sil', studyYear: 2 };

for (const dialect of ['sqlite', 'postgres']) {
  test('annuaire intégré et récupération manuelle sur ' + dialect, async t => {
    const environment = configureEnvironment(t);
    const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-directory-integration-')) : null;
    const db = dialect === 'postgres' ? await localPostgres() : await openDatabase({ connectionString: '', dataDir: directory });
    let application;
    t.after(async () => {
      await application?.close();
      await db.close();
      if (directory) {
        const target = resolve(directory);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('gasa-directory-integration-'));
        await rm(target, { recursive: true, force: true });
      }
    });
    // No email transport is injected: SMTP is deliberately disabled throughout this test.
    application = await createApplication({ database: { ...db, close: async () => {} } });
    if (!application.server.listening) await once(application.server, 'listening');
    const origin = 'http://127.0.0.1:' + application.server.address().port;
    const visitor = client(origin);
    const admins = {};
    for (const [role, username, password] of [
      ['owner', environment.ADMIN_OWNER_USERNAME, environment.ADMIN_OWNER_PASSWORD],
      ['organizer', environment.ADMIN_ORGANIZER_USERNAME, environment.ADMIN_ORGANIZER_PASSWORD],
      ['viewer', environment.ADMIN_VIEWER_USERNAME, environment.ADMIN_VIEWER_PASSWORD],
    ]) {
      admins[role] = client(origin);
      assert.equal((await admins[role].request('/api/admin/login', { method: 'POST', body: { username, password } })).status, 200);
    }
    const { owner, organizer, viewer } = admins;
    const first = client(origin);
    const second = client(origin);
    const otherSession = client(origin);
    let studentId;

    await t.test('inscription académique atomique et activité du compte', async () => {
      const invalid = await first.request('/api/student/register', { method: 'POST', body: { ...alice, programId: 'programme-inexistant' } });
      assert.equal(invalid.status, 400);
      assert.equal((await first.request('/api/student/session')).data.authenticated, false);
      assert.equal((await owner.request('/api/admin/students?q=' + encodeURIComponent(alice.email))).data.total, 0,
        'une filière refusée annule aussi la création du compte');
      const registered = await first.request('/api/student/register', { method: 'POST', body: alice });
      assert.equal(registered.status, 201, 'la même adresse reste disponible après annulation');
      studentId = registered.data.student.id;
      assert.equal((await second.request('/api/student/register', { method: 'POST', body: bruno })).status, 201);
      const profile = await first.request('/api/student/academic-profile');
      assert.equal(profile.status, 200);
      assert.equal(profile.data.firstName, alice.firstName);
      assert.equal(profile.data.lastName, alice.lastName);
      assert.equal(profile.data.programId, 'ge-si');
      assert.equal(profile.data.programName, 'GE/SI');
      assert.equal(profile.data.studyYear, 1);
      assert.equal((await otherSession.request('/api/student/login', {
        method: 'POST', body: { email: alice.email, password: alice.password },
      })).status, 200);
      const home = (await first.request('/api/home')).data;
      const activity = home.poll.activities[0];
      assert.equal((await first.request('/api/sessions/' + home.poll.id + '/vote', {
        method: 'POST', body: { activityId: activity.id, optionId: activity.options[0].id },
      })).status, 201);
      assert.equal((await first.request('/api/sessions/projection-campus/feedback', {
        method: 'POST', body: { rating: 5, comment: 'Un retour pour vérifier l’annuaire intégré.' },
      })).status, 201);
      const configured = await owner.request('/api/admin/priority-survey', { method: 'PUT',
        body: { collectBirthdate: true, birthdatePurpose: 'Préparer les publications d’anniversaire des étudiants volontaires.' } });
      assert.equal(configured.status, 200);
      const survey = configured.data;
      assert.equal((await first.request('/api/priority-survey/responses', {
        method: 'POST', body: { surveyId: survey.id, frequency: 'weekly', weekday: 'friday' },
      })).status, 201);
      assert.equal((await first.request('/api/priority-survey/birthdate', { method: 'POST', body: {
        surveyId: survey.id, birthdate: '2003-04-18', birthdateConsent: true,
        birthdatePurpose: survey.birthdatePurpose, publicationConsent: true,
      } })).status, 201);
    });

    await t.test('annuaire filtré, confidentialité et export correspondant', async () => {
      assert.equal((await visitor.request('/api/admin/students')).status, 401);
      assert.equal((await viewer.request('/api/admin/students')).status, 403);
      for (const [role, admin] of [['owner', owner], ['organizer', organizer]]) {
        const list = await admin.request('/api/admin/students?q=alice-directory');
        assert.equal(list.status, 200);
        assert.equal(list.data.total, 1);
        const student = list.data.items[0];
        assert.equal(student.id, studentId);
        assert.equal(student.name, alice.name);
        assert.equal(student.firstName, alice.firstName);
        assert.equal(student.lastName, alice.lastName);
        assert.equal(student.email, alice.email);
        assert.equal(student.programId, 'ge-si');
        assert.equal(student.programName, 'GE/SI');
        assert.equal(student.studyYear, 1);
        assert.deepEqual(student.counts, { votes: 1, feedback: 1, logins: 1 });
        assert.ok(Number.isFinite(Date.parse(student.lastLoginAt)));
        if (role === 'owner') {
          assert.equal(student.birthdate, '2003-04-18');
          assert.equal(student.publicationConsent, true);
          assert.ok(Number.isFinite(Date.parse(student.consentedAt)));
        } else {
          for (const key of ['birthdate', 'birthdatePurpose', 'consentedAt', 'publicationConsent']) assert.equal(Object.hasOwn(student, key), false);
        }
      }
      for (const [query, email] of [
        ['programId=ge-si&studyYear=1', alice.email], ['programId=ge-sil&studyYear=2', bruno.email],
        ['birthMonth=4&publicationConsent=true', alice.email],
      ]) {
        const result = await owner.request('/api/admin/students?' + query);
        assert.equal(result.status, 200);
        assert.equal(result.data.total, 1);
        assert.equal(result.data.items[0].email, email);
      }
      for (const query of ['programId=ge-si&studyYear=2', 'birthMonth=10', 'from=2099-01-01']) {
        assert.equal((await owner.request('/api/admin/students?' + query)).data.total, 0);
      }
      const today = new Date().toISOString().slice(0, 10);
      assert.equal((await owner.request('/api/admin/students?from=' + today + '&to=' + today)).data.total, 2);
      assert.equal((await owner.request('/api/admin/students?studyYear=4')).status, 400);
      assert.equal((await owner.request('/api/admin/students?birthMonth=13')).status, 400);
      assert.equal((await organizer.request('/api/admin/students?birthMonth=4')).status, 403, 'le filtrage ne permet pas de déduire une date privée');
      assert.equal((await organizer.request('/api/admin/students?publicationConsent=true')).status, 403);
      const page2 = (await owner.request('/api/admin/students?page=2')).data;
      assert.equal(page2.total, 2);
      assert.equal(page2.page, 2);
      assert.deepEqual(page2.items, []);
      const exported = await owner.request('/api/admin/students/export/xlsx?programId=ge-si&studyYear=1&birthMonth=4');
      assert.equal(exported.status, 200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(exported.data);
      const sheet = book.getWorksheet('Étudiants');
      assert.equal(sheet.rowCount, 2);
      const cells = JSON.stringify(sheet.getSheetValues());
      assert.ok(cells.includes(alice.email));
      assert.ok(cells.includes('GE/SI'));
      assert.ok(cells.includes('2003-04-18'));
      assert.equal(cells.includes(bruno.email), false);
      for (const admin of [organizer, viewer]) assert.equal((await admin.request('/api/admin/students/export/xlsx')).status, 403);
    });

    await t.test('fiche étudiante et historique réellement paginé', async () => {
      // Real profile edits populate more than one history page without password hashing or synthetic SQL fixtures.
      for (let index = 0; index < 42; index++) {
        assert.equal((await first.request('/api/student/academic-profile', {
          method: 'PUT', body: { studyYear: index % 2 === 0 ? 2 : 1 },
        })).status, 200);
      }
      const firstPage = await owner.request('/api/admin/students/' + studentId + '?page=1');
      assert.equal(firstPage.status, 200);
      assert.equal(firstPage.data.student.birthdate, '2003-04-18');
      assert.equal(firstPage.data.student.publicationConsent, true);
      assert.equal(firstPage.data.student.studyYear, 1);
      assert.ok(firstPage.data.total > firstPage.data.pageSize);
      assert.equal(firstPage.data.actions.length, firstPage.data.pageSize);
      const secondPage = await owner.request('/api/admin/students/' + studentId + '?page=2');
      assert.equal(secondPage.status, 200);
      assert.equal(secondPage.data.total, firstPage.data.total);
      assert.equal(secondPage.data.actions.length, firstPage.data.total - firstPage.data.pageSize);
      const ids = new Set(firstPage.data.actions.map(action => action.id));
      assert.ok(secondPage.data.actions.every(action => !ids.has(action.id)));
      const actions = [...firstPage.data.actions, ...secondPage.data.actions];
      for (const kind of ['student.register', 'student.login', 'student.academic-update', 'vote', 'feedback', 'priority-survey']) {
        assert.ok(actions.some(action => action.kind === kind), 'historique contient ' + kind);
      }
      assert.ok(actions.every(action => Number.isFinite(Date.parse(action.createdAt))));
      const restricted = await organizer.request('/api/admin/students/' + studentId);
      assert.equal(restricted.status, 200);
      assert.equal(restricted.data.student.email, alice.email);
      for (const key of ['birthdate', 'birthdatePurpose', 'consentedAt', 'publicationConsent']) assert.equal(Object.hasOwn(restricted.data.student, key), false);
      assert.equal((await viewer.request('/api/admin/students/' + studentId)).status, 403);
      assert.equal((await owner.request('/api/admin/students/inexistant')).status, 404);
    });

    await t.test('lien manuel sans SMTP, usage unique et révocation des anciennes sessions', async () => {
      const system = await owner.request('/api/admin/system-status');
      assert.equal(system.status, 200);
      assert.equal(system.data.passwordRecovery.enabled, false);
      assert.ok(system.data.passwordRecovery.missing.includes('SMTP_HOST'));
      assert.ok(system.data.passwordRecovery.missing.includes('SMTP_FROM'));
      assert.equal((await organizer.request('/api/admin/system-status')).status, 403);
      assert.equal((await viewer.request('/api/admin/system-status')).status, 403);
      assert.equal((await visitor.request('/api/student/password/forgot', { method: 'POST', body: { email: alice.email } })).status, 503);
      const path = '/api/admin/students/' + studentId + '/password-reset';
      assert.equal((await visitor.request(path, { method: 'POST', body: {} })).status, 401);
      for (const admin of [organizer, viewer]) assert.equal((await admin.request(path, { method: 'POST', body: {} })).status, 403);
      const before = Date.now();
      const reset = await owner.request(path, { method: 'POST', body: {} });
      assert.equal(reset.status, 201);
      const url = new URL(reset.data.url);
      assert.equal(url.origin, origin);
      const token = url.searchParams.get('reset');
      assert.match(token, /^[a-f0-9]{64}$/);
      assert.ok(Date.parse(reset.data.expiresAt) >= before + 30 * 60_000);
      assert.ok(Date.parse(reset.data.expiresAt) <= Date.now() + 30 * 60_000);
      assert.match(reset.headers.get('cache-control'), /no-store/);
      const newPassword = 'nouveau-password-directory-2026';
      const invalid = await visitor.request('/api/student/password/reset', { method: 'POST', body: { token: 'f'.repeat(64), password: newPassword } });
      assert.ok([400, 403].includes(invalid.status));
      assert.equal((await visitor.request('/api/student/password/reset', { method: 'POST', body: { token, password: newPassword } })).status, 200);
      for (const browser of [first, otherSession]) assert.equal((await browser.request('/api/student/session')).data.authenticated, false);
      const reused = await visitor.request('/api/student/password/reset', { method: 'POST', body: { token, password: newPassword } });
      assert.ok([400, 403].includes(reused.status));
      assert.equal((await visitor.request('/api/student/login', { method: 'POST', body: { email: alice.email, password: alice.password } })).status, 401);
      const restored = await visitor.request('/api/student/login', { method: 'POST', body: { email: alice.email, password: newPassword } });
      assert.equal(restored.status, 200);
      assert.equal(restored.data.student.id, studentId);
      const audit = await owner.request('/api/admin/trace?kind=admin.password-link&q=alice-directory');
      assert.equal(audit.status, 200);
      assert.equal(audit.data.total, 1);
      assert.equal(JSON.stringify(audit.data).includes(token), false, 'le jeton de récupération n’est pas écrit dans l’historique');
    });
  });
}
