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

function client(origin, cookies = new Map()) {
  return {
    cookies,
    async request(path, { method = 'GET', body, raw, contentType } = {}) {
      const response = await fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; '),
          ...(raw !== undefined ? { 'Content-Type': contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
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

function configureEnvironment(t) {
  const overrides = {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', TRUST_PROXY: '',
    PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', RENDER: '', DATABASE_URL: '',
    ADMIN_OWNER_USERNAME: 'engagement-owner', ADMIN_OWNER_PASSWORD: 'engagement-owner-password-2026',
    ADMIN_ORGANIZER_USERNAME: 'engagement-organizer', ADMIN_ORGANIZER_PASSWORD: 'engagement-organizer-password-2026',
    ADMIN_VIEWER_USERNAME: 'engagement-viewer', ADMIN_VIEWER_PASSWORD: 'engagement-viewer-password-2026',
    STUDENT_SIGNUP_CODE: '', VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
    SMTP_HOST: '', SMTP_FROM: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASSWORD: '',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return overrides;
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwSpn2H4QZYAwASOwIrfM45AsAAAAASUVORK5CYII=', 'base64');
const firstIdentity = { name: 'Alex Engagement', email: 'alex-engagement@example.test', password: 'alex-engagement-password-2026' };
const secondIdentity = { name: 'Claire Engagement', email: 'claire-engagement@example.test', password: 'claire-engagement-password-2026' };

for (const dialect of ['sqlite', 'postgres']) {
  test('sondage prioritaire, traçabilité et images sur ' + dialect, async t => {
    const environment = configureEnvironment(t);
    const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-engagement-')) : null;
    const db = dialect === 'postgres' ? await localPostgres() : await openDatabase({ connectionString: '', dataDir: directory });
    let application;
    let mailAttempts = 0;
    const start = async () => {
      application = await createApplication({ database: { ...db, close: async () => {} }, sendEmail: async () => { mailAttempts++; } });
      if (!application.server.listening) await once(application.server, 'listening');
      return 'http://127.0.0.1:' + application.server.address().port;
    };
    t.after(async () => {
      await application?.close();
      await db.close();
      if (directory) {
        const target = resolve(directory);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('gasa-engagement-'));
        await rm(target, { recursive: true, force: true });
      }
    });
    let origin = await start();
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
    let survey;

    await t.test('collecte authentifiée, consentement et unicité concurrente', async () => {
      const initial = await visitor.request('/api/priority-survey');
      assert.equal(initial.status, 200);
      assert.equal(initial.data.survey.status, 'active');
      assert.equal(initial.data.responded, false);
      assert.equal(initial.data.response, null);
      survey = initial.data.survey;
      const answer = { surveyId: survey.id, frequency: 'weekly', weekday: 'friday' };
      assert.equal((await visitor.request('/api/priority-survey/responses', { method: 'POST', body: answer })).status, 401);
      assert.equal((await viewer.request('/api/admin/priority-survey', { method: 'PUT', body: { status: 'paused' } })).status, 403);
      assert.equal((await owner.request('/api/admin/priority-survey', {
        method: 'PUT', body: { collectBirthdate: true, birthdatePurpose: '' },
      })).status, 400);
      assert.equal((await owner.request('/api/admin/priority-survey')).data.collectBirthdate, true, 'la configuration refusée est annulée');
      const configured = await owner.request('/api/admin/priority-survey', {
        method: 'PUT', body: { collectBirthdate: true, birthdatePurpose: 'Organiser les anniversaires des étudiants qui donnent leur accord.' },
      });
      assert.equal(configured.status, 200);
      survey = configured.data;
      assert.equal(survey.collectBirthdate, true);
      assert.equal((await first.request('/api/student/register', { method: 'POST', body: firstIdentity })).status, 201);
      assert.equal((await second.request('/api/student/register', { method: 'POST', body: secondIdentity })).status, 201);
      assert.equal((await second.request('/api/priority-survey/birthdate', {
        method: 'POST', body: { surveyId: survey.id, birthdate: '2003-04-18', birthdateConsent: true, birthdatePurpose: survey.birthdatePurpose },
      })).status, 409, 'le partage de la date nécessite une participation préalable au sondage');
      for (const invalid of [
        { birthdate: '2025-02-29', birthdateConsent: true },
        { birthdate: '2099-01-01', birthdateConsent: true },
        { birthdate: '2004-02-29' },
        { birthdate: '2004-02-29', birthdateConsent: false },
      ]) {
        assert.equal((await first.request('/api/priority-survey/responses', {
          method: 'POST', body: { ...answer, birthdatePurpose: survey.birthdatePurpose, ...invalid },
        })).status, 400);
      }
      const formerPurpose = survey.birthdatePurpose;
      const changedPurpose = await owner.request('/api/admin/priority-survey', {
        method: 'PUT', body: { birthdatePurpose: formerPurpose + ' Ce choix reste facultatif.' },
      });
      assert.equal(changedPurpose.status, 200);
      survey = changedPurpose.data;
      assert.equal((await first.request('/api/priority-survey/responses', {
        method: 'POST', body: { ...answer, birthdate: '2004-02-29', birthdateConsent: true, birthdatePurpose: formerPurpose },
      })).status, 409, 'la finalité modifiée impose un nouvel accord avant toute sauvegarde');
      assert.equal((await first.request('/api/priority-survey')).data.responded, false);
      const concurrent = await Promise.all([1, 2].map(() => first.request('/api/priority-survey/responses', {
        method: 'POST', body: { ...answer, birthdate: '2004-02-29', birthdateConsent: true, birthdatePurpose: survey.birthdatePurpose },
      })));
      assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409]);
      const recorded = (await first.request('/api/priority-survey')).data;
      assert.equal(recorded.responded, true);
      assert.equal(recorded.response.frequency, 'weekly');
      assert.equal(recorded.response.weekday, 'friday');
      assert.ok(Number.isFinite(Date.parse(recorded.response.createdAt)));
      assert.equal((await visitor.request('/api/priority-survey')).data.responded, false, 'un visiteur ne reçoit pas la réponse d’un autre étudiant');
      assert.equal((await owner.request('/api/admin/priority-survey', { method: 'PUT', body: { status: 'paused' } })).status, 200);
      assert.equal((await second.request('/api/priority-survey/responses', { method: 'POST', body: answer })).status, 409);
      assert.equal((await visitor.request('/api/priority-survey')).data.survey.status, 'paused');
      assert.equal((await owner.request('/api/admin/priority-survey', { method: 'PUT', body: { status: 'active' } })).status, 200);
      assert.equal((await second.request('/api/priority-survey/responses', {
        method: 'POST', body: { ...answer, frequency: 'fortnightly', weekday: 'saturday' },
      })).status, 201, 'la date de naissance reste facultative');
    });

    await t.test('partage facultatif de la date de naissance après la réponse', async () => {
      const before = (await second.request('/api/priority-survey')).data;
      assert.equal(before.responded, true);
      assert.equal(before.birthdateProvided, false);
      const profile = { surveyId: survey.id, birthdate: '2003-04-18', birthdateConsent: true, birthdatePurpose: survey.birthdatePurpose };
      assert.equal((await visitor.request('/api/priority-survey/birthdate', { method: 'POST', body: profile })).status, 401);
      assert.equal((await owner.request('/api/admin/priority-survey', { method: 'PUT', body: { status: 'paused' } })).status, 200);
      assert.equal((await second.request('/api/priority-survey/birthdate', { method: 'POST', body: profile })).status, 409);
      assert.equal((await second.request('/api/priority-survey')).data.birthdateProvided, false, 'une collecte en pause ne crée aucun profil');
      assert.equal((await owner.request('/api/admin/priority-survey', { method: 'PUT', body: { status: 'active' } })).status, 200);
      assert.equal((await second.request('/api/priority-survey/birthdate', { method: 'POST', body: profile })).status, 201);
      const after = (await second.request('/api/priority-survey')).data;
      assert.equal(after.responded, true);
      assert.equal(after.birthdateProvided, true);
      assert.deepEqual(after.response, before.response, 'la date de naissance ne modifie pas la réponse au sondage');
      assert.equal((await owner.request('/api/admin/priority-survey/results')).data.total, 2);
      const trace = (await organizer.request('/api/admin/trace?kind=student.birthdate-share&q=claire-engagement')).data;
      assert.equal(trace.total, 1);
      assert.equal(trace.items[0].email, secondIdentity.email);
      assert.ok(Number.isFinite(Date.parse(trace.items[0].createdAt)));
      assert.equal(trace.items[0].detail.includes('2003-04-18'), false, 'l’historique ne divulgue pas la date de naissance');
    });

    await t.test('résultats et annuaire selon les trois rôles', async () => {
      for (const [role, admin] of Object.entries(admins)) {
        const result = await admin.request('/api/admin/priority-survey/results');
        assert.equal(result.status, 200);
        assert.equal(result.data.total, 2);
        assert.equal(result.data.frequency.find(item => item.value === 'weekly').count, 1);
        assert.equal(result.data.frequency.find(item => item.value === 'fortnightly').count, 1);
        assert.equal(result.data.weekdays.find(item => item.value === 'friday').count, 1);
        assert.equal(result.data.weekdays.find(item => item.value === 'saturday').count, 1);
        if (role === 'viewer') {
          assert.deepEqual(result.data.responses, []);
          const serialized = JSON.stringify(result.data);
          for (const value of [firstIdentity.name, firstIdentity.email, secondIdentity.email, '2004-02-29', '2003-04-18']) assert.equal(serialized.includes(value), false);
          assert.equal((await admin.request('/api/admin/trace')).status, 403);
          assert.equal((await admin.request('/api/admin/students')).status, 403);
          continue;
        }
        const alex = result.data.responses.find(item => item.email === firstIdentity.email);
        const claire = result.data.responses.find(item => item.email === secondIdentity.email);
        assert.equal(alex.name, firstIdentity.name);
        assert.ok(Number.isFinite(Date.parse(alex.createdAt)));
        const students = await admin.request('/api/admin/students?q=alex-engagement&page=1');
        assert.equal(students.status, 200);
        assert.equal(students.data.total, 1);
        assert.equal(students.data.items[0].email, firstIdentity.email);
        assert.ok(Number.isFinite(Date.parse(students.data.items[0].createdAt)));
        const secondStudent = await admin.request('/api/admin/students?q=claire-engagement&page=1');
        assert.equal(secondStudent.status, 200);
        assert.equal(secondStudent.data.total, 1);
        if (role === 'owner') {
          assert.equal(alex.birthdate, '2004-02-29');
          assert.equal(alex.birthdatePurpose, survey.birthdatePurpose);
          assert.ok(Number.isFinite(Date.parse(alex.consentedAt)));
          assert.equal(students.data.items[0].birthdate, '2004-02-29');
          assert.equal(claire.birthdate, '2003-04-18');
          assert.equal(claire.birthdatePurpose, survey.birthdatePurpose);
          assert.ok(Number.isFinite(Date.parse(claire.consentedAt)));
          assert.equal(secondStudent.data.items[0].birthdate, '2003-04-18');
        } else {
          for (const item of [...result.data.responses, ...students.data.items, ...secondStudent.data.items]) {
            for (const key of ['birthdate', 'birthdatePurpose', 'consentedAt']) assert.equal(Object.hasOwn(item, key), false);
          }
        }
      }
      assert.equal((await owner.request('/api/admin/priority-survey', { method: 'PUT', body: { status: 'closed' } })).status, 200);
      assert.equal((await first.request('/api/priority-survey/responses', {
        method: 'POST', body: { surveyId: survey.id, frequency: 'weekly', weekday: 'friday' },
      })).status, 409);
      assert.equal((await owner.request('/api/admin/priority-survey/results')).data.total, 2, 'arrêter conserve les participations');
    });

    await t.test('identité et date des votes dans l’historique et les résultats de séance', async () => {
      const dashboard = (await owner.request('/api/admin/dashboard')).data;
      const activity = dashboard.activities.find(item => item.id === 'cinema');
      const before = Date.now();
      assert.equal((await first.request('/api/sessions/prochaine-seance/vote', {
        method: 'POST', body: { activityId: activity.id, optionId: activity.options[0].id },
      })).status, 201);
      const trace = await organizer.request('/api/admin/trace?sessionId=prochaine-seance&kind=vote&q=alex-engagement&page=1');
      assert.equal(trace.status, 200);
      assert.equal(trace.data.total, 1);
      const item = trace.data.items[0];
      assert.equal(item.name, firstIdentity.name);
      assert.equal(item.email, firstIdentity.email);
      assert.equal(item.kind, 'vote');
      assert.equal(item.sessionId, 'prochaine-seance');
      assert.equal(item.sessionTitle, dashboard.sessions.find(session => session.id === 'prochaine-seance').title);
      assert.match(item.detail, new RegExp(activity.name));
      assert.ok(Date.parse(item.createdAt) >= before && Date.parse(item.createdAt) <= Date.now());
      const results = (await owner.request('/api/admin/sessions/prochaine-seance/results')).data;
      assert.equal(results.responses.length, 1);
      assert.equal(results.responses[0].name, firstIdentity.name);
      assert.equal(results.responses[0].email, firstIdentity.email);
      assert.equal(results.responses[0].createdAt, item.createdAt);
      const aggregate = (await viewer.request('/api/admin/sessions/prochaine-seance/results')).data;
      assert.equal(aggregate.votes.reduce((total, vote) => total + vote.count, 0), 1);
      assert.deepEqual(aggregate.responses, []);
      assert.equal(JSON.stringify(aggregate).includes(firstIdentity.email), false);
      const priorityTrace = (await owner.request('/api/admin/trace?kind=priority-survey&q=alex-engagement')).data;
      assert.equal(priorityTrace.total, 1, 'une soumission concurrente crée une seule trace');
      assert.equal(priorityTrace.items[0].email, firstIdentity.email);
      const feedbackSession = dashboard.sessions.find(session => session.feedbackOpen && session.status === 'published');
      assert.equal((await first.request('/api/sessions/'+feedbackSession.id+'/feedback', {
        method:'POST',body:{rating:4,comment:'Très bonne séance, merci au comité.'},
      })).status,201);
      const namedFeedback = (await organizer.request('/api/admin/sessions/'+feedbackSession.id+'/results')).data.feedback[0];
      assert.equal(namedFeedback.name,firstIdentity.name);
      assert.equal(namedFeedback.email,firstIdentity.email);
      assert.equal(namedFeedback.studentId, (await first.request('/api/student/session')).data.student.id);
      const anonymousFeedback = (await viewer.request('/api/admin/sessions/'+feedbackSession.id+'/results')).data.feedback[0];
      assert.equal('email' in anonymousFeedback,false);
      assert.equal('name' in anonymousFeedback,false);
    });

    await t.test('exports propriétaires exploitables et refusés aux autres rôles', async () => {
      for (const prefix of ['/api/admin/priority-survey', '/api/admin/sessions/prochaine-seance']) {
        for (const format of ['xlsx', 'docx']) {
          for (const admin of [organizer, viewer]) assert.equal((await admin.request(prefix + '/export/' + format)).status, 403);
          const exported = await owner.request(prefix + '/export/' + format);
          assert.equal(exported.status, 200);
          assert.equal(exported.data.subarray(0, 2).toString(), 'PK');
          assert.match(exported.headers.get('content-disposition'), /attachment/);
          if (format === 'xlsx') {
            const book = new ExcelJS.Workbook();
            await book.xlsx.load(exported.data);
            const values = JSON.stringify(book.worksheets.map(sheet => sheet.getSheetValues()));
            assert.ok(values.includes(firstIdentity.name));
            assert.ok(values.includes(firstIdentity.email));
            if (prefix.includes('priority-survey')) {
              assert.ok(values.includes('2004-02-29'));
              assert.ok(values.includes('2003-04-18'));
              assert.ok(values.includes(survey.birthdatePurpose));
              assert.ok(values.includes('Chaque semaine'));
            }
          }
        }
      }
    });

    await t.test('images binaires validées, limitées, publiques et conservées au redémarrage', async () => {
      const upload = (admin, bytes, contentType = 'image/png') => admin.request('/api/admin/uploads/images', {
        method: 'POST', raw: bytes, contentType,
      });
      assert.equal((await upload(visitor, png)).status, 401);
      assert.equal((await upload(viewer, png)).status, 403);
      assert.equal((await upload(owner, png, 'image/jpeg')).status, 400, 'la signature PNG ne peut pas être présentée comme JPEG');
      assert.equal((await upload(owner, Buffer.from('ceci ne contient aucune image JPEG'), 'image/jpeg')).status, 400);
      assert.equal((await upload(owner, png.subarray(0, 24))).status, 400, 'une signature PNG valide ne suffit pas pour un fichier corrompu');
      assert.equal((await upload(owner, Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(30)]), 'image/jpeg')).status, 400);
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
      png.copy(oversized);
      assert.equal((await upload(owner, oversized)).status, 413);
      const uploaded = await upload(organizer, png);
      assert.equal(uploaded.status, 201);
      assert.match(uploaded.data.url, /^\/media\/images\/[a-f0-9-]{36}$/);
      const imageUrl = uploaded.data.url;
      assert.equal((await owner.request('/api/admin/activities/cinema', { method: 'PUT', body: { image: imageUrl } })).status, 200);
      const image = await visitor.request(imageUrl);
      assert.equal(image.status, 200);
      assert.match(image.headers.get('content-type'), /^image\/webp/);
      assert.match(image.headers.get('cache-control'), /public.*immutable/);
      assert.equal(image.data.toString('ascii', 0, 4), 'RIFF');
      assert.equal(image.data.toString('ascii', 8, 12), 'WEBP');
      assert.equal((await visitor.request('/api/home')).data.poll.activities.find(item => item.id === 'cinema').image, imageUrl);
      const ownerCookies = new Map(owner.cookies);
      await application.close();
      origin = await start();
      const restoredPublic = client(origin);
      const restoredImage = await restoredPublic.request(imageUrl);
      assert.equal(restoredImage.status, 200);
      assert.deepEqual(restoredImage.data, image.data);
      const restoredOwner = client(origin, ownerCookies);
      assert.equal((await restoredOwner.request('/api/admin/dashboard')).data.activities.find(item => item.id === 'cinema').image, imageUrl);
      assert.equal((await restoredOwner.request('/api/admin/priority-survey/results')).data.total, 2);
      assert.equal(mailAttempts, 0);
    });
  });
}
