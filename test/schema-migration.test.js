import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../server.js';
import { migratePostgresSchema } from '../schema-migration.js';
import { localPostgres } from './postgres-helper.js';

const legacyColumns = {
  sessions: ['activityIds', 'voteOpen', 'feedbackOpen', 'feedbackEnabled', 'createdAt'],
  votes: ['sessionId', 'activityId', 'optionId', 'optionLabel'],
  feedback: ['sessionId', 'createdAt'],
  guesses: ['sessionId', 'activityId'],
  push_subscriptions: ['subscribedAt', 'expiresAt'],
  push_events: ['sessionId', 'availableAt', 'expiresAt'],
  push_deliveries: ['eventId', 'nextAttemptAt'],
};

const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const snakeCase = value => value.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());

function configureEnvironment(t) {
  const overrides = {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', TRUST_PROXY: '',
    PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', RENDER: '',
    ADMIN_OWNER_USERNAME: 'migration-owner', ADMIN_OWNER_PASSWORD: 'migration-owner-password-2026',
    ADMIN_ORGANIZER_USERNAME: 'migration-editor', ADMIN_ORGANIZER_PASSWORD: 'migration-editor-password-2026',
    ADMIN_VIEWER_USERNAME: 'migration-viewer', ADMIN_VIEWER_PASSWORD: 'migration-viewer-password-2026',
    STUDENT_SIGNUP_CODE: '', VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
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

async function columnNames(db) {
  return db.prepare(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position
  `).all();
}

for (const [format, legacyName] of [
  ['minuscules', value => value.toLowerCase()],
  ['snake_case', snakeCase],
]) {
  test('migration PostgreSQL des colonnes ' + format + ' sans perte de données', async t => {
    const environment = configureEnvironment(t);
    const db = await localPostgres();
    let application;
    const start = async () => {
      application = await createApplication({ database: { ...db, close: async () => {} } });
      if (!application.server.listening) await once(application.server, 'listening');
      return 'http://127.0.0.1:' + application.server.address().port;
    };
    t.after(async () => {
      await application?.close();
      await db.close();
    });

    await start();
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM activities').get()).count, 7);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).count, 2);
    await application.close();

    const options = [{ id: 'choix-conserve', label: 'Une option personnalisée conservée' }];
    const announcement = {
      activityId: 'cinema', mode: 'normal', location: 'Salle personnalisée',
      date: '2099-12-01T12:00:00.000Z', hint: '', revealAt: null,
    };
    await db.prepare('UPDATE activities SET name = ?, options = ? WHERE id = ?')
      .run('Cinéma personnalisé', JSON.stringify(options), 'cinema');
    await db.prepare(`
      UPDATE sessions SET title = ?, description = ?, activityIds = ?, announcement = ?,
        voteOpen = 0, feedbackOpen = 1, feedbackEnabled = 1 WHERE id = ?
    `).run('Séance personnalisée', 'Description conservée', JSON.stringify(['cinema']),
      JSON.stringify(announcement), 'prochaine-seance');
    await db.prepare('INSERT INTO votes (sessionId, participant, activityId, optionId, optionLabel) VALUES (?, ?, ?, ?, ?)')
      .run('prochaine-seance', 'participant-historique', 'cinema', options[0].id, options[0].label);
    await db.prepare('INSERT INTO feedback (id, sessionId, participant, rating, comment, createdAt, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('avis-historique', 'prochaine-seance', 'participant-historique', 5, 'Un avis à conserver', '2026-11-19T10:00:00.000Z', 1);
    await db.prepare('INSERT INTO guesses (sessionId, participant, activityId) VALUES (?, ?, ?)')
      .run('prochaine-seance', 'participant-historique', 'cinema');
    const expectedActivity = await db.prepare('SELECT id, name, description, image, question, options, archived FROM activities WHERE id = ?').get('cinema');
    const expectedSession = await db.prepare('SELECT id, title, description, status, activityIds, voteOpen, feedbackOpen, feedbackEnabled, announcement, createdAt FROM sessions WHERE id = ?').get('prochaine-seance');
    const expectedVotes = await db.prepare('SELECT * FROM votes').all();
    const expectedFeedback = await db.prepare('SELECT * FROM feedback').all();
    const expectedGuesses = await db.prepare('SELECT * FROM guesses').all();

    // Simulate a local import from before quoted identifiers and ordering existed.
    await db.prepare("DELETE FROM schema_settings WHERE name = 'seed'").run();
    await db.exec('ALTER TABLE activities DROP COLUMN sort_order; ALTER TABLE sessions DROP COLUMN sort_order');
    for (const [table, columns] of Object.entries(legacyColumns)) {
      for (const column of columns) {
        await db.exec(`ALTER TABLE ${identifier(table)} RENAME COLUMN ${identifier(column)} TO ${identifier(legacyName(column))}`);
      }
    }

    let origin = await start();
    const verify = async () => {
      const health = await fetch(origin + '/healthz');
      assert.equal(health.status, 200);
      const homeResponse = await fetch(origin + '/api/home');
      assert.equal(homeResponse.status, 200);
      const home = await homeResponse.json();
      assert.equal(home.poll.title, expectedSession.title);
      assert.equal(home.poll.open, false);
      assert.equal(home.poll.activities.length, 1);
      assert.deepEqual(home.poll.activities[0].options, options);
      assert.equal(home.announcement.location, announcement.location);

      assert.deepEqual(await db.prepare('SELECT id, name, description, image, question, options, archived FROM activities WHERE id = ?').get('cinema'), expectedActivity);
      assert.deepEqual(await db.prepare('SELECT id, title, description, status, activityIds, voteOpen, feedbackOpen, feedbackEnabled, announcement, createdAt FROM sessions WHERE id = ?').get('prochaine-seance'), expectedSession);
      assert.deepEqual(await db.prepare('SELECT * FROM votes').all(), expectedVotes);
      assert.deepEqual(await db.prepare('SELECT * FROM feedback').all(), expectedFeedback);
      assert.deepEqual(await db.prepare('SELECT * FROM guesses').all(), expectedGuesses);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM activities').get()).count, 7);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).count, 2);
      assert.equal((await db.prepare("SELECT value FROM schema_settings WHERE name = 'seed'").get()).value, 1);
      const columns = await columnNames(db);
      for (const [table, expected] of Object.entries(legacyColumns)) {
        const present = columns.filter(column => column.table_name === table).map(column => column.column_name);
        for (const column of expected) {
          assert.ok(present.includes(column), table + '.' + column + ' est disponible');
          assert.ok(!present.includes(legacyName(column)), table + '.' + legacyName(column) + ' a été renommée');
        }
      }
    };
    await verify();

    const login = await fetch(origin + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: environment.ADMIN_OWNER_USERNAME, password: environment.ADMIN_OWNER_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const resultsResponse = await fetch(origin + '/api/admin/sessions/prochaine-seance/results', { headers: { Cookie: cookie } });
    assert.equal(resultsResponse.status, 200);
    const results = await resultsResponse.json();
    assert.equal(results.votes.reduce((sum, activity) => sum + activity.count, 0), 1);
    assert.equal(results.feedback[0].comment, 'Un avis à conserver');
    assert.equal(results.feedback[0].hidden, true);
    assert.equal(results.guesses, 1);

    // Ordering must remain usable both for imported records and later inserts.
    for (const [table, fields] of [
      ['activities', 'name, description, image, question, options, archived'],
      ['sessions', 'title, description, status, activityIds, voteOpen, feedbackOpen, feedbackEnabled, announcement, createdAt'],
    ]) {
      const before = (await db.prepare('SELECT MAX(sort_order) AS value FROM ' + table).get()).value;
      const missing = await db.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE sort_order IS NULL').get();
      assert.equal(missing.count, 0);
      await db.prepare(`INSERT INTO ${table} (id, ${fields}) SELECT ?, ${fields} FROM ${table} LIMIT 1`).run('insertion-apres-migration');
      const inserted = await db.prepare('SELECT sort_order FROM ' + table + ' WHERE id = ?').get('insertion-apres-migration');
      assert.ok(inserted.sort_order > before);
      await db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run('insertion-apres-migration');
    }
    await assert.rejects(db.prepare('INSERT INTO votes (sessionId, participant, activityId, optionId, optionLabel) VALUES (?, ?, ?, ?, ?)')
      .run('prochaine-seance', 'participant-historique', 'cinema', options[0].id, options[0].label), /duplicate key/i);
    await assert.rejects(db.prepare('INSERT INTO guesses (sessionId, participant, activityId) VALUES (?, ?, ?)')
      .run('prochaine-seance', 'nouveau-participant', 'activite-inexistante'), /foreign key/i);

    const firstColumns = await columnNames(db);
    await application.close();
    origin = await start();
    await verify();
    assert.deepEqual(await columnNames(db), firstColumns, 'le second démarrage ne modifie plus le schéma');
  });
}

test('une ambiguïté de colonnes PostgreSQL interrompt la migration sans changement', async t => {
  const db = await localPostgres();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY);
    CREATE TABLE votes (
      "sessionid" TEXT, participant TEXT, "activityid" TEXT,
      "optionId" TEXT, option_id TEXT, "optionlabel" TEXT
    );
    INSERT INTO activities (id) VALUES ('conserve');
    INSERT INTO votes ("sessionid", participant, "activityid", "optionId", option_id, "optionlabel")
    VALUES ('seance', 'participant', 'conserve', 'camel', 'snake', 'Réponse conservée');
  `);
  const beforeColumns = await columnNames(db);
  const beforeVotes = await db.prepare('SELECT * FROM votes').all();
  await assert.rejects(migratePostgresSchema(db), /colonnes ambiguës pour votes\.optionId/);
  assert.deepEqual(await columnNames(db), beforeColumns);
  assert.deepEqual(await db.prepare('SELECT * FROM votes').all(), beforeVotes);
  assert.deepEqual(await db.prepare('SELECT * FROM activities').all(), [{ id: 'conserve' }]);
});

test('une panne pendant les renommages PostgreSQL annule les modifications précédentes', async t => {
  const db = await localPostgres();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE votes (
      "sessionid" TEXT, participant TEXT, "activityid" TEXT,
      "optionid" TEXT, "optionlabel" TEXT
    );
    INSERT INTO votes VALUES ('seance', 'participant', 'activite', 'option', 'Réponse conservée');
  `);
  const beforeColumns = await columnNames(db);
  const beforeVotes = await db.prepare('SELECT * FROM votes').all();
  let renames = 0;
  const interrupted = {
    ...db,
    async exec(sql) {
      if (sql.includes('RENAME COLUMN') && ++renames === 2) throw new Error('panne DDL simulée');
      return db.exec(sql);
    },
  };
  await assert.rejects(migratePostgresSchema(interrupted), /panne DDL simulée/);
  assert.equal(renames, 2, 'la panne survient après un premier renommage réussi');
  assert.deepEqual(await columnNames(db), beforeColumns);
  assert.deepEqual(await db.prepare('SELECT * FROM votes').all(), beforeVotes);
});
