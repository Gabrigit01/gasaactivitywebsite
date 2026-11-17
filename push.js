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
  if (announcement?.mode !== 'surprise') return null;
  const time = Date.parse(announcement.revealAt);
  return time > now ? time : null;
}

function retryAt(error, attempts, now) {
  const header = error.headers?.['retry-after'];
  const delay = typeof header !== 'string' ? 0
    : /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return now + Math.max(30000 * 2 ** attempts, Math.min(hour, delay || 0));
}

export function createPush({ db, env = process.env, send = sendNotification }) {
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
  const signedHeaders = new Map();

  db.exec(
    'CREATE TABLE IF NOT EXISTS push_subscriptions (' +
    'endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, subscribedAt INTEGER NOT NULL, expiresAt INTEGER);' +
    'CREATE TABLE IF NOT EXISTS push_events (' +
    'id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, kind TEXT NOT NULL, availableAt INTEGER NOT NULL,' +
    'expiresAt INTEGER NOT NULL, payload TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, UNIQUE (sessionId, kind));' +
    'CREATE TABLE IF NOT EXISTS push_deliveries (' +
    'eventId TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,' +
    'endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,' +
    'nextAttemptAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (eventId, endpoint));' +
    'CREATE INDEX IF NOT EXISTS push_deliveries_queue ON push_deliveries(nextAttemptAt);' +
    'CREATE INDEX IF NOT EXISTS push_deliveries_endpoint ON push_deliveries(endpoint);'
  );

  const getSubscription = db.prepare('SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ?');
  const addSubscription = db.prepare(
    'INSERT INTO push_subscriptions (endpoint, p256dh, auth, subscribedAt, expiresAt) VALUES (?, ?, ?, ?, ?)' +
    ' ON CONFLICT(endpoint) DO UPDATE SET expiresAt = excluded.expiresAt');
  const removeSubscription = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const unsubscribe = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND p256dh = ? AND auth = ?');
  const deleteAllForSession = db.prepare('DELETE FROM push_events WHERE sessionId = ?');
  const deleteEvent = db.prepare('DELETE FROM push_events WHERE sessionId = ? AND kind = ?');
  const findEvent = db.prepare('SELECT availableAt FROM push_events WHERE sessionId = ? AND kind = ?');
  const addEvent = db.prepare('INSERT INTO push_events (id, sessionId, kind, availableAt, expiresAt, payload) VALUES (?, ?, ?, ?, ?, ?)');
  const expireSubscriptions = db.prepare('DELETE FROM push_subscriptions WHERE expiresAt <= ?');
  const expireEvents = db.prepare('DELETE FROM push_events WHERE expiresAt <= ?');
  const dispatch = db.prepare(
    'INSERT OR IGNORE INTO push_deliveries (eventId, endpoint, nextAttemptAt)' +
    ' SELECT e.id, s.endpoint, e.availableAt FROM push_events e JOIN push_subscriptions s ON s.subscribedAt <= e.availableAt' +
    ' WHERE e.dispatched = 0 AND e.availableAt <= ? AND e.expiresAt > ?');
  const markDispatched = db.prepare('UPDATE push_events SET dispatched = 1 WHERE dispatched = 0 AND availableAt <= ? AND expiresAt > ?');
  const readyDeliveries = db.prepare(
    'SELECT d.eventId, d.endpoint, d.attempts, s.p256dh, s.auth, e.expiresAt, e.payload FROM push_deliveries d' +
    ' JOIN push_events e ON e.id = d.eventId JOIN push_subscriptions s ON s.endpoint = d.endpoint' +
    ' WHERE d.nextAttemptAt <= ? AND e.expiresAt > ? ORDER BY d.nextAttemptAt LIMIT 12');
  const deliveryStillPending = db.prepare('SELECT 1 FROM push_deliveries WHERE eventId = ? AND endpoint = ?');
  const finish = db.prepare('DELETE FROM push_deliveries WHERE eventId = ? AND endpoint = ?');
  const retry = db.prepare('UPDATE push_deliveries SET attempts = ?, nextAttemptAt = ? WHERE eventId = ? AND endpoint = ?');
  const pruneDispatched = db.prepare(
    'DELETE FROM push_events WHERE dispatched = 1 AND NOT EXISTS (SELECT 1 FROM push_deliveries WHERE eventId = push_events.id)');

  let running = false;
  let stopped = false;
  let immediate;
  let timer;

  function mount(api) {
    api.get('/push/config', (_req, res) => res.json({ enabled, publicKey: enabled ? publicKey : null }));
    api.post('/push/subscriptions', (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Les notifications ne sont pas configurées.' });
      const subscription = readSubscription(req.body);
      const now = Date.now();
      if (!subscription || (subscription.expiresAt !== null && subscription.expiresAt <= now)) {
        return res.status(400).json({ error: 'Cet abonnement aux notifications est invalide ou expiré.' });
      }
      const { endpoint, p256dh, auth, expiresAt } = subscription;
      const existing = getSubscription.get(endpoint);
      if (existing && (existing.p256dh !== p256dh || existing.auth !== auth)) {
        return res.status(409).json({ error: 'Cet abonnement a changé. Réactive les notifications sur cet appareil.' });
      }
      addSubscription.run(endpoint, p256dh, auth, now, expiresAt);
      return res.status(existing ? 200 : 201).json({ ok: true });
    });
    api.delete('/push/subscriptions', (req, res) => {
      const subscription = readSubscription(req.body);
      if (!subscription) return res.status(400).json({ error: 'Cet abonnement aux notifications est invalide.' });
      unsubscribe.run(subscription.endpoint, subscription.p256dh, subscription.auth);
      return res.json({ ok: true });
    });
  }

  function enqueue(sessionId, kind, at, message, until = at + noticeLifetime) {
    const [title, body, view] = messages[message];
    const tag = randomUUID();
    const url = '/?' + new URLSearchParams({ vue: view, seance: sessionId });
    deleteEvent.run(sessionId, kind);
    addEvent.run(tag, sessionId, kind, at, Math.min(at + noticeLifetime, until), JSON.stringify({ title, body, url, tag }));
  }

  function planReveal(session, announcement, now) {
    const at = revealTime(announcement, now);
    if (at === null) return;
    const existing = findEvent.get(session.id, 'reveal');
    if (existing?.availableAt === at) return;
    enqueue(session.id, 'reveal', at, 'reveal', Math.max(at + hour, Date.parse(announcement.date)));
  }

  function syncScheduledReveals(sessions) {
    if (!enabled) return;
    const now = Date.now();
    for (const session of sessions) planReveal(session, availableAnnouncement(session, now), now);
    wake();
  }

  function noteSession(session, previous = null) {
    if (!enabled) return;
    const now = Date.now();
    const wasPublished = previous?.status === 'published';
    if (session.status !== 'published') {
      deleteAllForSession.run(session.id);
      return;
    }
    for (const [kind, property] of [['vote', 'voteOpen'], ['feedback', 'feedbackOpen']]) {
      if (!session[property]) deleteEvent.run(session.id, kind);
      else if (!wasPublished || !previous[property]) enqueue(session.id, kind, now, kind);
    }

    const announcement = availableAnnouncement(session, now);
    const oldAnnouncement = availableAnnouncement(previous, now);
    if (!announcement) {
      deleteEvent.run(session.id, 'announcement');
      deleteEvent.run(session.id, 'reveal');
    } else {
      const changed = announcementKey(announcement) !== announcementKey(oldAnnouncement);
      const mystery = announcement.mode === 'surprise' && (!announcement.revealAt || revealTime(announcement, now) !== null);
      if (changed) {
        enqueue(session.id, 'announcement', now, mystery ? 'surprise' : 'announcement', Date.parse(announcement.date));
        deleteEvent.run(session.id, 'reveal');
      }
      planReveal(session, announcement, now);
    }
    wake();
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
    const { eventId, endpoint } = entry;
    if (!deliveryStillPending.get(eventId, endpoint)) return;
    if (!pushEndpoint(endpoint)) {
      removeSubscription.run(endpoint);
      return;
    }
    try {
      await send({ endpoint, keys: { auth: entry.auth, p256dh: entry.p256dh } }, entry.payload, {
        TTL: Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)),
        urgency: 'normal',
        topic: createHash('sha256').update(eventId).digest('base64url').slice(0, 32),
        timeout: 8000,
        headers: headersFor(endpoint),
        vapidDetails: null,
      });
      if (!stopped) finish.run(eventId, endpoint);
    } catch (error) {
      if (stopped) return;
      const status = error.statusCode;
      if (status === 404 || status === 410) {
        removeSubscription.run(endpoint);
        return;
      }
      const attempts = entry.attempts + 1;
      const transient = status === undefined || status === 408 || status === 429 || status >= 500;
      const later = retryAt(error, entry.attempts, Date.now());
      if (transient && attempts < maximumAttempts && later < entry.expiresAt) {
        retry.run(attempts, later, eventId, endpoint);
      } else {
        finish.run(eventId, endpoint);
      }
    }
  }

  async function drain() {
    if (!enabled || running || stopped) return;
    running = true;
    try {
      const now = Date.now();
      expireSubscriptions.run(now);
      expireEvents.run(now);
      db.exec('BEGIN');
      try {
        dispatch.run(now, now);
        markDispatched.run(now, now);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const entries = readyDeliveries.all(now, now);
      await Promise.allSettled(entries.map(deliver));
      if (stopped) return;
      pruneDispatched.run();
      if (entries.length === 12) wake();
    } finally {
      running = false;
    }
  }

  function wake() {
    if (!enabled || stopped || immediate) return;
    immediate = setImmediate(() => {
      immediate = undefined;
      drain().catch(() => console.error('Impossible de traiter la file de notifications.'));
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
