import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openDatabase } from '../database.js';
import { installSessionFields, sessionPhase } from '../session-management.js';
import { localPostgres } from './postgres-helper.js';

test('classement par jour à Porto-Novo, autour de minuit et indépendamment de l’heure', () => {
  const now = Date.parse('2026-11-28T23:30:00.000Z'); // 29 novembre, 00 h 30 à Porto-Novo.
  for (const date of ['2026-11-28T23:00:00.000Z', '2026-11-29T22:59:59.999Z', '2026-11-29T12:00:00+01:00']) {
    assert.equal(sessionPhase({ announcement: { date } }, now), 'current', date);
  }
  assert.equal(sessionPhase({ announcement: { date: '2026-11-28T22:59:59.999Z' } }, now), 'past');
  assert.equal(sessionPhase({ announcement: { date: '2026-11-29T23:00:00.000Z' } }, now), 'upcoming');
  assert.equal(sessionPhase({ announcement: JSON.stringify({ date: '2026-11-29T12:00:00+01:00' }) }, now), 'current');
  assert.equal(sessionPhase({ announcement: { date: '2026-11-29T00:00:00+01:00' } }, Date.parse('2026-11-28T22:59:59.999Z')), 'upcoming');
});

test('priorité des phases explicites et des séances archivées', () => {
  const now = Date.parse('2026-11-28T12:00:00.000Z');
  for (const phase of ['upcoming', 'current', 'past']) {
    assert.equal(sessionPhase({ phase, status: 'draft', feedbackOpen: true, announcement: { date: '2020-01-01T00:00:00.000Z' } }, now), phase);
    assert.equal(sessionPhase({ phase, status: 'archived', voteOpen: true }, now), 'past');
  }
  assert.equal(sessionPhase({ phase: 'current', archived: true }), 'past');
  assert.equal(sessionPhase({ phase: 'invalid', announcement: { date: '2099-01-01T00:00:00.000Z' } }, now), 'upcoming');
  assert.equal(sessionPhase({ phase: 'CURRENT', status: 'draft' }, now), 'upcoming');
  assert.equal(sessionPhase({ phase: 'past' }), 'past', 'la date courante par défaut ne remplace pas une phase explicite');
});

test('fallbacks historiques, annonces absentes ou invalides', () => {
  assert.equal(sessionPhase({ feedbackOpen: true, voteOpen: false }), 'past');
  assert.equal(sessionPhase({ feedbackOpen: 1, voteOpen: 0 }), 'past');
  assert.equal(sessionPhase({ status: 'draft', feedbackOpen: true, voteOpen: false }), 'past');
  assert.equal(sessionPhase({ status: 'draft' }), 'upcoming');
  assert.equal(sessionPhase({ voteOpen: true, feedbackOpen: true }), 'upcoming');
  assert.equal(sessionPhase({ status: 'published', voteOpen: false, feedbackOpen: false }), 'current');
  assert.equal(sessionPhase({ announcement: { date: 'pas une date' }, voteOpen: true }), 'upcoming');
  assert.equal(sessionPhase({ announcement: '{invalid', feedbackOpen: true }), 'past');
  assert.equal(sessionPhase({ announcement: { date: '2099-01-01T00:00:00.000Z' } }, NaN), 'current');
  assert.equal(sessionPhase(null), 'current');
});

for (const dialect of ['sqlite', 'postgres']) {
  test('migration des séances idempotente avec clé étrangère sur ' + dialect, async t => {
    const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-session-fields-')) : null;
    const db = dialect === 'postgres' ? await localPostgres() : await openDatabase({ connectionString: '', dataDir: directory });
    t.after(async () => {
      await db.close();
      if (directory) {
        const target = resolve(directory);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('gasa-session-fields-'));
        await rm(target, { recursive: true, force: true });
      }
    });
    await db.exec(`CREATE TABLE activities (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL);
      INSERT INTO activities (id) VALUES ('cinema');
      INSERT INTO sessions (id,title,status) VALUES ('legacy','Séance conservée','published');`);
    await installSessionFields(db);
    assert.deepEqual({ ...await db.prepare('SELECT * FROM sessions WHERE id=?').get('legacy') }, {
      id: 'legacy', title: 'Séance conservée', status: 'published', phase: null, activity_id: null,
    });
    await db.prepare('UPDATE sessions SET phase=?,activity_id=? WHERE id=?').run('past', 'cinema', 'legacy');
    const before = { ...await db.prepare('SELECT * FROM sessions WHERE id=?').get('legacy') };
    await installSessionFields(db);
    await installSessionFields(db);
    assert.deepEqual({ ...await db.prepare('SELECT * FROM sessions WHERE id=?').get('legacy') }, before);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).count), 1, 'aucune séance artificielle ajoutée');
    await assert.rejects(db.prepare('UPDATE sessions SET activity_id=? WHERE id=?').run('inexistante', 'legacy'));
    assert.deepEqual({ ...await db.prepare('SELECT * FROM sessions WHERE id=?').get('legacy') }, before);

    await db.exec('DROP TABLE sessions; CREATE TABLE sessions (id TEXT PRIMARY KEY,phase TEXT)');
    await db.prepare('INSERT INTO sessions (id,phase) VALUES (?,?)').run('partial', 'upcoming');
    await installSessionFields(db);
    assert.deepEqual({ ...await db.prepare('SELECT * FROM sessions WHERE id=?').get('partial') }, {
      id: 'partial', phase: 'upcoming', activity_id: null,
    }, 'une migration partielle conserve la phase existante');
  });
}
