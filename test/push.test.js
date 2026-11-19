import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { createPush } from '../push.js';
import { localPostgres } from './postgres-helper.js';

function keyPair() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return key;
}

async function eventually(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(description);
}

test('PostgreSQL preserves subscriptions, confidential notices and delivery retries', { timeout: 30000 }, async t => {
  const db = await localPostgres();
  const vapid = keyPair();
  const recipient = keyPair();
  const env = {
    VAPID_SUBJECT: 'mailto:campus@example.test',
    VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
  };
  const sent = [];
  const releases = [];
  let phase = 'success';
  const push = await createPush({
    db,
    env,
    async send(subscription, payload) {
      const notice = JSON.parse(payload);
      sent.push({ subscription, notice });
      if (phase === 'retry') {
        const error = new Error('Simulated unavailable push provider');
        error.statusCode = 503;
        error.headers = { 'retry-after': '60' };
        throw error;
      }
      if (phase === 'pending') await new Promise(resolve => releases.push(resolve));
    },
  });
  const app = express();
  app.use(express.json());
  push.mount(app);
  const server = createServer(app);
  t.after(async () => {
    releases.forEach(resolve => resolve());
    await push.stop();
    if (server.listening) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    await db.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/postgres-local-test',
    keys: {
      p256dh: recipient.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };

  await t.test('Express routes register a device and reject conflicting keys', async () => {
    const config = await request('GET', '/push/config');
    assert.deepEqual(config.body, { enabled: true, publicKey: env.VAPID_PUBLIC_KEY });
    assert.equal((await request('POST', '/push/subscriptions', subscription)).status, 201);
    assert.equal((await request('POST', '/push/subscriptions', subscription)).status, 200);
    const conflict = await request('POST', '/push/subscriptions', {
      ...subscription,
      keys: { ...subscription.keys, auth: randomBytes(16).toString('base64url') },
    });
    assert.equal(conflict.status, 409);
    const saved = await db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
    assert.equal(saved.auth, subscription.keys.auth);
    assert(Number.isSafeInteger(saved.subscribedAt));
  });

  await t.test('Surprise notices hide the answer and preserve the scheduled reveal', async () => {
    const now = Date.now();
    const session = {
      id: 'mystery-session', status: 'published', voteOpen: false, feedbackOpen: false,
      announcement: {
        activityId: 'confidential-activity-answer', mode: 'surprise', hint: 'Un indice public',
        date: new Date(now + 3600000).toISOString(),
        revealAt: new Date(now + 600000).toISOString(),
      },
    };
    await db.transaction(() => push.noteSession(session));
    const reveal = await db.prepare('SELECT * FROM push_events WHERE sessionId = ? AND kind = ?')
      .get(session.id, 'reveal');
    assert.equal(reveal.availableAt, Date.parse(session.announcement.revealAt));
    assert.equal(reveal.dispatched, 0);
    const notices = await db.prepare('SELECT payload FROM push_events WHERE sessionId = ?').all(session.id);
    assert.equal(notices.length, 2);
    assert(notices.every(row => !row.payload.includes('confidential-activity-answer')));
    await push.syncScheduledReveals([session]);
    assert.equal((await db.prepare('SELECT id FROM push_events WHERE sessionId = ? AND kind = ?')
      .get(session.id, 'reveal')).id, reveal.id);
    await db.transaction(() => push.noteSession({ ...session, status: 'archived' }, session));
    assert.equal((await db.prepare('SELECT * FROM push_events WHERE sessionId = ?').all(session.id)).length, 0);
    assert.equal((await db.prepare('SELECT * FROM push_deliveries WHERE eventId = ?').all(reveal.id)).length, 0);
  });

  await t.test('Transient provider failures persist their retry and complete on the next attempt', async () => {
    phase = 'retry';
    const session = { id: 'retry-session', status: 'published', voteOpen: true, feedbackOpen: false, announcement: null };
    await db.transaction(() => push.noteSession(session));
    const event = await db.prepare('SELECT id FROM push_events WHERE sessionId = ?').get(session.id);
    const firstAttemptAt = Date.now();
    push.wake();
    const delivery = await eventually(async () => {
      const row = await db.prepare('SELECT * FROM push_deliveries WHERE eventId = ?').get(event.id);
      return row?.attempts === 1 ? row : null;
    }, 'A failed provider request must leave a persisted retry');
    assert(delivery.nextAttemptAt >= firstAttemptAt + 60000);
    assert.equal(sent.filter(item => item.notice.tag === event.id).length, 1);
    phase = 'success';
    await db.prepare('UPDATE push_deliveries SET nextAttemptAt = ? WHERE eventId = ?')
      .run(Date.now() - 1, event.id);
    push.wake();
    await eventually(async () => !(await db.prepare('SELECT 1 FROM push_events WHERE id = ?').get(event.id)),
      'Successful delivery must remove the completed outbox event');
    assert.equal(sent.filter(item => item.notice.tag === event.id).length, 2);
  });

  await t.test('Shutdown waits for the transport and retains unfinished work for restart', async () => {
    phase = 'pending';
    const session = { id: 'shutdown-session', status: 'published', voteOpen: true, feedbackOpen: false, announcement: null };
    await db.transaction(() => push.noteSession(session));
    const event = await db.prepare('SELECT id FROM push_events WHERE sessionId = ?').get(session.id);
    push.wake();
    await eventually(() => releases.length > 0, 'The mock transport must start before shutdown');
    let finished = false;
    const stopping = push.stop().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(finished, false);
    releases.forEach(resolve => resolve());
    await stopping;
    assert.equal(finished, true);
    assert(await db.prepare('SELECT 1 FROM push_deliveries WHERE eventId = ?').get(event.id));
  });
});
