import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import express from 'express';
import { AccountError, installAccounts } from '../accounts.js';
import { openDatabase } from '../database.js';
import { localPostgres } from './postgres-helper.js';

const oldPassword = 'ancien-mot-de-passe-2026';
const newPassword = 'nouveau-mot-de-passe-2026';
const finalPassword = 'dernier-mot-de-passe-2026';
const email = 'etudiant@example.test';
const environment = {
  ADMIN_OWNER_USERNAME: 'owner-test', ADMIN_OWNER_PASSWORD: 'owner-password-test-2026',
  ADMIN_ORGANIZER_USERNAME: 'organizer-test', ADMIN_ORGANIZER_PASSWORD: 'organizer-password-test-2026',
  ADMIN_VIEWER_USERNAME: 'viewer-test', ADMIN_VIEWER_PASSWORD: 'viewer-password-test-2026',
  ADMIN_PASSWORD: '', STUDENT_SIGNUP_CODE: '',
  SMTP_HOST: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: '',
};
let previousEnvironment;
test.before(() => {
  previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
});
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function client(origin, cookies = new Map(), extraHeaders = {}) {
  return {
    cookies,
    async request(route, body) {
      const options = {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      };
      // Undici normalizes Host; native HTTP is required to actually send a forged Host.
      const response = extraHeaders.host ? await new Promise((resolve, reject) => {
        const outgoing = httpRequest(origin + '/api/' + route, { method: options.method, headers: options.headers }, incoming => {
          const chunks = [];
          incoming.on('data', chunk => chunks.push(chunk));
          incoming.on('error', reject);
          incoming.on('end', () => resolve({
            status: incoming.statusCode,
            headers: {
              get: key => incoming.headers[key.toLowerCase()],
              getSetCookie: () => incoming.headers['set-cookie'] || [],
            },
            json: async () => JSON.parse(Buffer.concat(chunks).toString()),
          }));
        });
        outgoing.on('error', reject);
        outgoing.end(options.body);
      }) : await fetch(origin + '/api/' + route, options);
      for (const cookie of response.headers.getSetCookie()) {
        const [key, ...value] = cookie.split(';')[0].split('=');
        cookies.set(key, value.join('='));
      }
      return { status: response.status, data: await response.json(), headers: response.headers };
    },
  };
}

async function fixture(t, dialect, options = {}) {
  const { beforeInstall, wrapDatabase, ...accountOptions } = options;
  const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-password-test-')) : null;
  const db = dialect === 'sqlite' ? await openDatabase({ connectionString: '', dataDir: directory }) : await localPostgres();
  await beforeInstall?.(db);
  const api = express.Router();
  const messages = [];
  const events = [];
  const auth = await installAccounts({
    api, db: wrapDatabase ? wrapDatabase(db) : db, production: true, publicOrigin: 'https://campus.example.test',
    sendEmail: async message => { messages.push(message); },
    onAccountEvent: async event => { events.push(event); },
    ...accountOptions,
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api', api);
  app.use((error, _req, res, _next) => {
    res.status(error instanceof AccountError ? error.status : 500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await auth.close();
    await db.close();
    if (directory?.startsWith(join(tmpdir(), 'gasa-password-test-'))) await rm(directory, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function mail(index) {
    const deadline = Date.now() + 5000;
    while (!messages[index] && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(messages[index], 'message reçu par le transport injecté');
    const url = new URL(messages[index].text.match(/https?:\/\/\S+/)[0]);
    return { message: messages[index], url, token: url.searchParams.get('reset') };
  }
  return { db, auth, messages, events, mail, client: (...args) => client(origin, ...args) };
}

for (const dialect of ['sqlite', 'postgres']) {
  test('récupération et changement de mot de passe : ' + dialect, async t => {
    const f = await fixture(t, dialect);
    const first = f.client();
    const second = f.client();
    const visitor = f.client(new Map(), { host: 'attacker.example.test' });
    assert.equal((await first.request('student/session')).data.passwordRecoveryEnabled, true);
    assert.equal((await first.request('student/register', { email, name: 'Étudiant Test', password: oldPassword })).status, 201);
    const created = await f.db.prepare('SELECT created_at FROM student_accounts WHERE email = ?').get(email);
    assert.ok(Number.isFinite(Date.parse(created.created_at)));
    assert.equal((await second.request('student/login', { email, password: oldPassword })).status, 200);
    const unknown = await visitor.request('student/password/forgot', { email: 'absent@example.test' });
    const known = await visitor.request('student/password/forgot', { email });
    assert.equal(known.status, 202);
    assert.deepEqual(known.data, unknown.data, 'aucune énumération des comptes');
    const reset = await f.mail(0);
    assert.equal(reset.url.origin, 'https://campus.example.test', 'le Host reçu ne contrôle pas le lien');
    assert.match(reset.token, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(known.data).includes(reset.token), false);
    const stored = await f.db.prepare('SELECT * FROM student_password_resets').all();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].token_hash, createHash('sha256').update(reset.token).digest('hex'));
    assert.ok(stored[0].expires_at > Date.now() + 29 * 60_000);
    assert.ok(stored[0].expires_at <= Date.now() + 30 * 60_000);
    assert.equal((await visitor.request('student/password/reset', { token: reset.token, password: 'court' })).status, 400);
    assert.equal((await visitor.request('student/password/reset', { token: 'malforme', password: newPassword })).status, 400);
    const attempts = await Promise.all([newPassword, finalPassword].map(password =>
      visitor.request('student/password/reset', { token: reset.token, password })));
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 400], 'un seul usage même en concurrence');
    const acceptedPassword = attempts[0].status === 200 ? newPassword : finalPassword;
    assert.equal((await visitor.request('student/password/reset', { token: reset.token, password: newPassword })).status, 400);
    assert.equal((await first.request('student/session')).data.authenticated, false);
    assert.equal((await second.request('student/session')).data.authenticated, false);
    assert.equal((await first.request('student/login', { email, password: oldPassword })).status, 401);
    assert.equal((await first.request('student/login', { email, password: acceptedPassword })).status, 200);
    assert.equal((await second.request('student/login', { email, password: acceptedPassword })).status, 200);
    assert.equal((await visitor.request('student/password/change', { currentPassword: acceptedPassword, password: newPassword })).status, 401);
    assert.equal((await first.request('student/password/change', { currentPassword: 'incorrect', password: newPassword })).status, 401);
    assert.equal((await first.request('student/password/change', { currentPassword: acceptedPassword, password: 'court' })).status, 400);
    assert.equal((await first.request('student/session')).data.authenticated, true, 'échec sans révoquer la session');
    assert.equal((await visitor.request('student/password/forgot', { email })).status, 202);
    const pendingReset = await f.mail(1);
    assert.equal((await first.request('student/password/change', { currentPassword: acceptedPassword, password: finalPassword })).status, 200);
    assert.equal((await first.request('student/session')).data.authenticated, false);
    assert.equal((await second.request('student/session')).data.authenticated, false);
    assert.equal((await visitor.request('student/password/reset', { token: pendingReset.token, password: newPassword })).status, 400,
      'le changement invalide aussi les anciens liens');
    assert.equal((await first.request('student/login', { email, password: finalPassword })).status, 200);
    assert.equal((await first.request('student/logout', {})).status, 200);
    assert.ok(f.events.some(event => event.kind === 'student.register'));
    assert.ok(f.events.some(event => event.kind === 'student.password-reset'));
    assert.ok(f.events.some(event => event.kind === 'student.password-change'));
    assert.ok(f.events.some(event => event.kind === 'student.logout'));
    assert.ok(f.events.every(event => Object.keys(event).sort().join(',') === 'email,kind,name,studentId'));
    assert.equal((await visitor.request('student/password/forgot', { email })).status, 202);
    const expired = await f.mail(2);
    await f.db.prepare('UPDATE student_password_resets SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await visitor.request('student/password/reset', { token: expired.token, password: newPassword })).status, 400);
    const limited = await visitor.request('student/password/forgot', { email });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });

  test('récupération indisponible et origine HTTPS obligatoire : ' + dialect, async t => {
    const disabled = await fixture(t, dialect, { sendEmail: undefined });
    const visitor = disabled.client();
    assert.equal((await visitor.request('student/session')).data.passwordRecoveryEnabled, false);
    for (const address of [email, 'absent@example.test']) {
      const response = await visitor.request('student/password/forgot', { email: address });
      assert.equal(response.status, 503);
      assert.match(response.data.error, /responsable/);
    }
    const unsafe = await fixture(t, dialect, { publicOrigin: 'http://campus.example.test' });
    assert.equal((await unsafe.client().request('student/password/forgot', { email })).status, 503);
    assert.equal(unsafe.messages.length, 0);
    const local = await fixture(t, dialect, { production: false, publicOrigin: undefined });
    const forgedHost = local.client(new Map(), { host: 'attacker.example.test', 'x-forwarded-proto': 'https' });
    assert.equal((await forgedHost.request('student/password/forgot', { email })).status, 503,
      'sans origine configurée, même un Host HTTPS est refusé hors loopback');
    assert.equal((await local.client().request('student/password/forgot', { email })).status, 202);
    assert.equal(local.messages.length, 0);
  });

  test('migration historique et connexion concurrente au reset : ' + dialect, async t => {
    let interceptLogin = false;
    let resumeLogin;
    const pausedLogin = new Promise(resolve => { resumeLogin = resolve; });
    let reportRead;
    const credentialsRead = new Promise(resolve => { reportRead = resolve; });
    const f = await fixture(t, dialect, {
      beforeInstall: async db => {
        await db.exec(`CREATE TABLE student_accounts (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          salt BLOB NOT NULL, password_hash BLOB NOT NULL
        )`);
        await db.prepare('INSERT INTO student_accounts (id, email, name, salt, password_hash) VALUES (?, ?, ?, ?, ?)')
          .run('historical-student', 'historique@example.test', 'Compte historique', Buffer.alloc(16), Buffer.alloc(32));
      },
      wrapDatabase: db => ({
        ...db,
        prepare(sql) {
          const statement = db.prepare(sql);
          if (sql !== 'SELECT * FROM student_accounts WHERE email = ?') return statement;
          return { ...statement, async get(...values) {
            const row = await statement.get(...values);
            if (interceptLogin) {
              interceptLogin = false;
              reportRead();
              await pausedLogin;
            }
            return row;
          } };
        },
      }),
    });
    const visitor = f.client();
    assert.equal((await visitor.request('student/register', { email, name: 'Étudiant Migré', password: oldPassword })).status, 201);
    const account = await f.db.prepare('SELECT created_at FROM student_accounts WHERE email = ?').get(email);
    assert.ok(Number.isFinite(Date.parse(account.created_at)), 'colonne ajoutée à une ancienne base');
    assert.equal((await f.db.prepare('SELECT created_at FROM student_accounts WHERE id = ?').get('historical-student')).created_at, null,
      'aucune date d’inscription inventée pour les anciens comptes');
    assert.equal((await visitor.request('student/password/forgot', { email })).status, 202);
    assert.equal((await visitor.request('student/password/forgot', { email })).status, 202);
    const reset = await f.mail(0);
    const secondReset = await f.mail(1);
    interceptLogin = true;
    const login = f.client().request('student/login', { email, password: oldPassword });
    await credentialsRead;
    try {
      const resetResults = await Promise.all([reset.token, secondReset.token].map(token =>
        f.client().request('student/password/reset', { token, password: newPassword })));
      assert.deepEqual(resetResults.map(result => result.status).sort(), [200, 400], 'un reset invalide aussi les autres liens concurrents');
    } finally {
      resumeLogin();
    }
    assert.equal((await login).status, 401, 'une connexion ayant lu l’ancien hash ne recrée pas une session');
    assert.equal((await f.db.prepare('SELECT * FROM student_auth_sessions').all()).length, 0);
  });
}
