import { createECDH, createHash, ECDH, randomUUID } from 'node:crypto';
import { getVapidHeaders, sendNotification } from 'web-push';

const noticeLifetime = 24 * 60 * 60 * 1000;
const maximumAttempts = 5;
const hour = 60 * 60 * 1000;

const messages = {
  vote: ['Un nouveau sondage est ouvert', 'Choisis la prochaine activité du campus.', 'vote'],
  feedback: ['Ton avis compte', 'Partage ton retour sur la séance.', 'avis'],
  announcement: ['Une activité a été annoncée', 'Consulte les informations de la prochaine séance.', 'annonce'],
  surprise: ['Une activité mystère arrive', 'Découvre l’indice et propose ta réponse.', 'annonce'],
  reveal: ['L’activité mystère est révélée', 'Découvre l’activité retenue pour la prochaine séance.', 'annonce'],
};

function pushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.pathname === '/') return null;

  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com'
    || host === 'updates.push.services.mozilla.com'
    || host === 'push.services.mozilla.com'
    || host.endsWith('.push.apple.com')
    || host.endsWith('.notify.windows.com');
  return allowed ? url.href : null;
}

function base64Key(value, bytes) {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value) || value.length > 100) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value ? decoded : null;
}

function readSubscription(value) {
  const endpoint = pushEndpoint(value?.endpoint);
  const publicKey = base64Key(value?.keys?.p256dh, 65);
  const auth = base64Key(value?.keys?.auth, 16);
  const expiresAt = value?.expirationTime ?? null;
  if (!endpoint || !publicKey || publicKey[0] !== 4 || !auth
    || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0))) return null;
  try {
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    return null;
  }
  return { endpoint, p256dh: value.keys.p256dh, auth: value.keys.auth, expiresAt };
}

function availableAnnouncement(session, now) {
  if (session?.status !== 'published' || !session.announcement) return null;
  return Date.parse(session.announcement.date) > now ? session.announcement : null;
}

function announcementKey(announcement) {
  return announcement && JSON.stringify([
    announcement.activityId, announcement.date, announcement.location,
    announcement.mode, announcement.hint, announcement.revealAt,
  ]);
}

function revealTime(announcement, now) {
  if (announcement?.mode !== 'surprise' || !announcement.revealAt) return null;
  const time = Date.parse(announcement.revealAt);
  return Number.isFinite(time) && time > now ? time : null;
}

function retryAt(error, attempts, now) {
  const header = error.headers?.['retry-after'];
  const delay = typeof header !== 'string' ? 0
    : /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return now + Math.max(30000 * 2 ** attempts, Math.min(hour, delay || 0));
}

async function installPushSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      subscribedat BIGINT NOT NULL,
      expiresat BIGINT
    );

    CREATE TABLE IF NOT EXISTS push_events (
      id TEXT PRIMARY KEY,
      sessionid TEXT NOT NULL,
      kind TEXT NOT NULL,
      availableat BIGINT NOT NULL,
      expiresat BIGINT NOT NULL,
      payload TEXT NOT NULL,
      dispatched INTEGER NOT NULL DEFAULT 0,
      UNIQUE (sessionid, kind)
    );

    CREATE TABLE IF NOT EXISTS push_deliveries (
      eventid TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
      nextattemptat BIGINT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (eventid, endpoint)
    );

    CREATE INDEX IF NOT EXISTS push_deliveries_queue
      ON push_deliveries(nextattemptat);

    CREATE INDEX IF NOT EXISTS push_deliveries_endpoint
      ON push_deliveries(endpoint);
  `);
}

export async function createPush({ pool, env = process.env, send = sendNotification }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('createPush attend un pool PostgreSQL compatible avec pg.');
  }

  const { VAPID_SUBJECT: subject, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = env;
  const enabled = Boolean(subject && publicKey && privateKey);
  if (!enabled && (subject || publicKey || privateKey)) {
    throw new Error('Configurez VAPID_SUBJECT, VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY ensemble.');
  }
  if (enabled) {
    getVapidHeaders('https://fcm.googleapis.com', subject, publicKey, privateKey, 'aes128gcm');
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (!pair.getPublicKey().equals(Buffer.from(publicKey, 'base64url'))) {
      throw new Error('Les deux clés VAPID doivent provenir de la même paire.');
    }
  }

  await installPushSchema(pool);

  const signedHeaders = new Map();
  let running = false;
  let stopped = false;
  let immediate;
  let timer;

  async function deleteEvent(sessionId, kind, queryable = pool) {
    await queryable.query(
      'DELETE FROM push_events WHERE sessionid = $1 AND kind = $2',
      [sessionId, kind],
    );
  }

  async function deleteAllForSession(sessionId, queryable = pool) {
    await queryable.query('DELETE FROM push_events WHERE sessionid = $1', [sessionId]);
  }

  async function enqueue(sessionId, kind, at, message, until = at + noticeLifetime, queryable = pool) {
    const [title, body, view] = messages[message];
    const tag = randomUUID();
    const url = '/?' + new URLSearchParams({ vue: view, seance: sessionId });
    await deleteEvent(sessionId, kind, queryable);
    await queryable.query(
      `INSERT INTO push_events
         (id, sessionid, kind, availableat, expiresat, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tag, sessionId, kind, at, Math.min(at + noticeLifetime, until), JSON.stringify({ title, body, url, tag })],
    );
  }

  async function planReveal(session, announcement, now, queryable = pool) {
    const at = revealTime(announcement, now);
    if (at === null) return;
    const result = await queryable.query(
      'SELECT availableat FROM push_events WHERE sessionid = $1 AND kind = $2',
      [session.id, 'reveal'],
    );
    if (result.rows[0] && Number(result.rows[0].availableat) === at) return;
    await enqueue(session.id, 'reveal', at, 'reveal', Math.max(at + hour, Date.parse(announcement.date)), queryable);
  }

  async function syncScheduledReveals(sessions) {
    if (!enabled) return;
    const now = Date.now();
    for (const session of sessions) {
      await planReveal(session, availableAnnouncement(session, now), now);
    }
    wake();
  }

  async function noteSession(session, previous = null, queryable = pool) {
    if (!enabled) return;
    const now = Date.now();
    const wasPublished = previous?.status === 'published';

    if (session.status !== 'published') {
      await deleteAllForSession(session.id, queryable);
      return;
    }

    for (const [kind, property] of [['vote', 'voteOpen'], ['feedback', 'feedbackOpen']]) {
      if (!session[property]) {
        await deleteEvent(session.id, kind, queryable);
      } else if (!wasPublished || !previous[property]) {
        await enqueue(session.id, kind, now, kind, undefined, queryable);
      }
    }

    const announcement = availableAnnouncement(session, now);
    const oldAnnouncement = availableAnnouncement(previous, now);
    if (!announcement) {
      await deleteEvent(session.id, 'announcement', queryable);
      await deleteEvent(session.id, 'reveal', queryable);
    } else {
      const changed = announcementKey(announcement) !== announcementKey(oldAnnouncement);
      const mystery = announcement.mode === 'surprise'
        && (!announcement.revealAt || revealTime(announcement, now) !== null);
      if (changed) {
        const endAt = Date.parse(announcement.date);
        await enqueue(
          session.id,
          'announcement',
          now,
          mystery ? 'surprise' : 'announcement',
          endAt,
          queryable,
        );
        await deleteEvent(session.id, 'reveal', queryable);
      }
      await planReveal(session, announcement, now, queryable);
    }
    wake();
  }

  async function mount(api) {
    api.get('/push/config', (_req, res) => {
      res.json({ enabled, publicKey: enabled ? publicKey : null });
    });

    api.post('/push/subscriptions', async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Les notifications ne sont pas configurées.' });
      const subscription = readSubscription(req.body);
      const now = Date.now();
      if (!subscription || (subscription.expiresAt !== null && subscription.expiresAt <= now)) {
        return res.status(400).json({ error: 'Cet abonnement aux notifications est invalide ou expiré.' });
      }

      const { endpoint, p256dh, auth, expiresAt } = subscription;
      const existingResult = await pool.query(
        'SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = $1',
        [endpoint],
      );
      const existing = existingResult.rows[0];
      if (existing && (existing.p256dh !== p256dh || existing.auth !== auth)) {
        return res.status(409).json({ error: 'Cet abonnement a changé. Réactive les notifications sur cet appareil.' });
      }

      await pool.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, subscribedat, expiresat)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET expiresat = EXCLUDED.expiresat`,
        [endpoint, p256dh, auth, now, expiresAt],
      );
      return res.status(existing ? 200 : 201).json({ ok: true });
    });

    api.delete('/push/subscriptions', async (req, res) => {
      const subscription = readSubscription(req.body);
      if (!subscription) return res.status(400).json({ error: 'Cet abonnement aux notifications est invalide.' });
      await pool.query(
        'DELETE FROM push_subscriptions WHERE endpoint = $1 AND p256dh = $2 AND auth = $3',
        [subscription.endpoint, subscription.p256dh, subscription.auth],
      );
      return res.json({ ok: true });
    });
  }

  function headersFor(endpoint) {
    const origin = new URL(endpoint).origin;
    const now = Date.now();
    const cached = signedHeaders.get(origin);
    if (cached?.refreshAt > now) return cached.headers;
    const headers = getVapidHeaders(origin, subject, publicKey, privateKey, 'aes128gcm');
    if (signedHeaders.size >= 128) signedHeaders.delete(signedHeaders.keys().next().value);
    signedHeaders.set(origin, { headers, refreshAt: now + 6 * hour });
    return headers;
  }

  async function deliver(entry) {
    const { eventid: eventId, endpoint } = entry;
    const pending = await pool.query(
      'SELECT 1 FROM push_deliveries WHERE eventid = $1 AND endpoint = $2',
      [eventId, endpoint],
    );
    if (pending.rowCount === 0) return;

    if (!pushEndpoint(endpoint)) {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
      return;
    }

    try {
      await send({ endpoint, keys: { auth: entry.auth, p256dh: entry.p256dh } }, entry.payload, {
        TTL: Math.max(1, Math.ceil((Number(entry.expiresat) - Date.now()) / 1000)),
        urgency: 'normal',
        topic: createHash('sha256').update(eventId).digest('base64url').slice(0, 32),
        timeout: 8000,
        headers: headersFor(endpoint),
        vapidDetails: null,
      });
      if (!stopped) {
        await pool.query(
          'DELETE FROM push_deliveries WHERE eventid = $1 AND endpoint = $2',
          [eventId, endpoint],
        );
      }
    } catch (error) {
      if (stopped) return;
      const status = error.statusCode;
      if (status === 404 || status === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
        return;
      }
      const attempts = Number(entry.attempts) + 1;
      const transient = status === undefined || status === 408 || status === 429 || status >= 500;
      const later = retryAt(error, Number(entry.attempts), Date.now());
      if (transient && attempts < maximumAttempts && later < Number(entry.expiresat)) {
        await pool.query(
          'UPDATE push_deliveries SET attempts = $1, nextattemptat = $2 WHERE eventid = $3 AND endpoint = $4',
          [attempts, later, eventId, endpoint],
        );
      } else {
        await pool.query(
          'DELETE FROM push_deliveries WHERE eventid = $1 AND endpoint = $2',
          [eventId, endpoint],
        );
      }
    }
  }

  async function drain() {
    if (!enabled || running || stopped) return;
    running = true;
    let client;
    try {
      const now = Date.now();
      await pool.query('DELETE FROM push_subscriptions WHERE expiresat IS NOT NULL AND expiresat <= $1', [now]);
      await pool.query('DELETE FROM push_events WHERE expiresat <= $1', [now]);

      client = await pool.connect();
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO push_deliveries (eventid, endpoint, nextattemptat)
           SELECT e.id, s.endpoint, e.availableat
           FROM push_events AS e
           JOIN push_subscriptions AS s ON s.subscribedat <= e.availableat
           WHERE e.dispatched = 0 AND e.availableat <= $1 AND e.expiresat > $2
           ON CONFLICT (eventid, endpoint) DO NOTHING`,
          [now, now],
        );
        await client.query(
          'UPDATE push_events SET dispatched = 1 WHERE dispatched = 0 AND availableat <= $1 AND expiresat > $2',
          [now, now],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
        client = null;
      }

      const result = await pool.query(
        `SELECT d.eventid, d.endpoint, d.attempts, s.p256dh, s.auth,
                e.expiresat, e.payload
         FROM push_deliveries AS d
         JOIN push_events AS e ON e.id = d.eventid
         JOIN push_subscriptions AS s ON s.endpoint = d.endpoint
         WHERE d.nextattemptat <= $1 AND e.expiresat > $2
         ORDER BY d.nextattemptat
         LIMIT 12`,
        [now, now],
      );
      const entries = result.rows;
      await Promise.allSettled(entries.map(deliver));
      if (stopped) return;

      await pool.query(
        `DELETE FROM push_events AS e
         WHERE e.dispatched = 1
           AND NOT EXISTS (
             SELECT 1 FROM push_deliveries AS d WHERE d.eventid = e.id
           )`,
      );
      if (entries.length === 12) wake();
    } finally {
      if (client) client.release();
      running = false;
    }
  }

  function wake() {
    if (!enabled || stopped || immediate) return;
    immediate = setImmediate(() => {
      immediate = undefined;
      drain().catch((error) => {
        console.error('Impossible de traiter la file de notifications :', error);
      });
    });
    immediate.unref();
  }

  if (enabled) {
    timer = setInterval(wake, 2000);
    timer.unref();
    wake();
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    clearImmediate(immediate);
  }

  return { mount, noteSession, syncScheduledReveals, stop };
}
