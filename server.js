import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import { migratePostgresSchema } from './schema-migration.js';
import express from 'express';
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import QRCode from 'qrcode';
import { AccountError, installAccounts } from './accounts.js';
import { createPush } from './push.js';
import { EngagementError, installEngagement } from './engagement.js';
import { installCinema } from './cinema.js';
import { DirectoryError, installDirectory } from './student-directory.js';
import { GalleryError, installGallery } from './gallery.js';

export async function createApplication({ database, sendEmail } = {}) {
const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || resolve(root, 'data'));
const production = process.env.NODE_ENV === 'production';
const configuredOrigin = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
const publicOrigin = configuredOrigin ? readOrigin(configuredOrigin) : null;
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
if (production && !publicOrigin?.startsWith('https://')) {
  throw new Error('PUBLIC_URL doit indiquer le domaine HTTPS du site en production.');
}
if (production && process.env.RENDER === 'true' && !process.env.DATABASE_URL && !process.env.DATA_DIR && !database) {
  throw new Error('Configurez DATABASE_URL pour Neon, ou DATA_DIR sur un disque persistant Render.');
}

const db = database || await openDatabase({ dataDir });
await migratePostgresSchema(db);
await db.exec(`
  CREATE TABLE IF NOT EXISTS schema_settings (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS activities (
    ${db.dialect === 'postgres' ? 'sort_order BIGSERIAL,' : ''}
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    image TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK (archived IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    ${db.dialect === 'postgres' ? 'sort_order BIGSERIAL,' : ''}
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
    activityIds TEXT NOT NULL,
    voteOpen INTEGER NOT NULL CHECK (voteOpen IN (0, 1)),
    feedbackOpen INTEGER NOT NULL CHECK (feedbackOpen IN (0, 1)),
    feedbackEnabled INTEGER NOT NULL CHECK (feedbackEnabled IN (0, 1)),
    announcement TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    participant TEXT NOT NULL,
    activityId TEXT NOT NULL REFERENCES activities(id),
    optionId TEXT NOT NULL,
    optionLabel TEXT NOT NULL,
    PRIMARY KEY (sessionId, participant)
  );

  CREATE INDEX IF NOT EXISTS votes_by_option ON votes(activityId, optionId);

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    participant TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    UNIQUE (sessionId, participant)
  );

  CREATE TABLE IF NOT EXISTS guesses (
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    participant TEXT NOT NULL,
    activityId TEXT NOT NULL REFERENCES activities(id),
    PRIMARY KEY (sessionId, participant)
  );
`);

function activityFromRow(row) {
  if (!row) return null;
  const { sort_order, ...activity } = row;
  return { ...activity, options: JSON.parse(row.options), archived: Boolean(row.archived) };
}

function sessionFromRow(row) {
  if (!row) return null;
  const { createdAt, feedbackEnabled, sort_order, ...session } = row;
  return {
    ...session,
    activityIds: JSON.parse(row.activityIds),
    voteOpen: Boolean(row.voteOpen),
    feedbackOpen: Boolean(row.feedbackOpen),
    announcement: row.announcement ? JSON.parse(row.announcement) : null,
  };
}

async function activities() {
  return (await db.prepare('SELECT * FROM activities ORDER BY ' + db.orderColumn).all()).map(activityFromRow);
}

async function findActivity(id) {
  return activityFromRow(await db.prepare('SELECT * FROM activities WHERE id = ?').get(id));
}

async function findSession(id) {
  return sessionFromRow(await db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
}

async function writeActivity(activity) {
  await db.prepare(`
    INSERT INTO activities (id, name, description, image, question, options, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
      name=excluded.name, description=excluded.description, image=excluded.image,
      question=excluded.question, options=excluded.options, archived=excluded.archived
  `).run(activity.id, activity.name, activity.description, activity.image, activity.question,
    JSON.stringify(activity.options), Number(activity.archived));
}

async function updateActivity(activity, previous) {
  if (!activity.archived || previous.archived) {
    await writeActivity(activity);
    return;
  }

  await db.transaction(async () => {
    await writeActivity(activity);
    const sessions = await db.prepare("SELECT * FROM sessions WHERE status = 'published' AND voteOpen = 1").all();
    const active = new Set((await activities()).filter(item => !item.archived).map(item => item.id));
    for (const session of sessions) {
      if (!JSON.parse(session.activityIds).some(id => active.has(id))) {
        await db.prepare('UPDATE sessions SET voteOpen = 0 WHERE id = ?').run(session.id);
      }
    }
  });
}

async function writeSession(session) {
  await db.prepare(`
    INSERT INTO sessions (id, title, description, status, activityIds, voteOpen, feedbackOpen,
      feedbackEnabled, announcement, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
      title=excluded.title, description=excluded.description, status=excluded.status,
      activityIds=excluded.activityIds, voteOpen=excluded.voteOpen, feedbackOpen=excluded.feedbackOpen,
      feedbackEnabled=CASE WHEN sessions.feedbackEnabled = 1 OR excluded.feedbackEnabled = 1 THEN 1 ELSE 0 END,
      announcement=excluded.announcement
  `).run(session.id, session.title, session.description, session.status, JSON.stringify(session.activityIds),
    Number(session.voteOpen), Number(session.feedbackOpen), Number(session.feedbackOpen),
    session.announcement ? JSON.stringify(session.announcement) : null, Date.now());
}

async function seed() {
  const initialActivities = [
    ['cinema', 'Cinéma', 'Une projection suivie d’un échange entre étudiants.', 'cinema.jpg',
      'Quel genre de film aimeriez-vous voir ?', ['Documentaire & innovation', 'Biopic & entrepreneuriat', 'Histoire & société']],
    ['conference', 'Conférence & débat', 'Des idées à découvrir et à débattre avec le campus.', 'conference.jpeg',
      'Quel thème souhaitez-vous aborder ?', ['Intelligence artificielle & métiers', 'Entrepreneuriat étudiant au Bénin', 'Engagement citoyen']],
    ['hackathon', 'Hackathon campus', 'Un défi créatif et technique à relever en équipe.', 'hackathon.jpg',
      'Quel défi technique souhaitez-vous relever ?', ['Application pour la vie sur le campus', 'Inclusion financière', 'Gestion des déchets à Cotonou']],
    ['tenutradi', 'Tenue traditionnelle', 'Une journée pour célébrer les cultures du campus.', 'tenutradi.jpg',
      'Quel format vous ferait le plus envie ?', ['Défilé de tenues traditionnelles', 'Atelier sur les styles et textiles', 'Exposition photo et témoignages']],
    ['sport', 'Tournoi sportif', 'Une compétition amicale entre étudiants.', 'sport.jpg',
      'Quelle discipline souhaitez-vous mettre à l’honneur ?', ['Football', 'Basketball 3x3', 'Volleyball mixte']],
    ['scene', 'Scène ouverte', 'Le micro et la scène aux talents du campus.', 'scene.jpg',
      'Quel format artistique souhaitez-vous voir ?', ['Chant, rap & slam', 'Humour & improvisation', 'Danse & chorégraphie']],
    ['culinaire', 'Foire culinaire', 'Des spécialités à découvrir et à partager.', 'culinaire.jpg',
      'Quel format aimeriez-vous pour la foire ?', ['Dégustation de plats béninois', 'Concours de cuisine étudiante', 'Ateliers de recettes en équipe']],
  ];
  await db.transaction(async () => {
    await db.prepare("INSERT INTO schema_settings (name, value) VALUES ('seed', 0) ON CONFLICT (name) DO NOTHING").run();
    const marker = await db.prepare("SELECT value FROM schema_settings WHERE name = 'seed'"
      + (db.dialect === 'postgres' ? ' FOR UPDATE' : '')).get();
    const legacySeeded = db.dialect === 'sqlite' && (await db.prepare('PRAGMA user_version').get()).user_version > 0;
    const existingData = await db.prepare('SELECT 1 FROM activities LIMIT 1').get()
      || await db.prepare('SELECT 1 FROM sessions LIMIT 1').get();
    if (marker.value === 0 && !legacySeeded && !existingData) {
      for (const [id, name, description, file, question, labels] of initialActivities) {
        const options = labels.map((label, index) => ({ id: `option-${index + 1}`, label }));
        await writeActivity({ id, name, description, image: `/images/${file}`, question, options, archived: false });
      }
      await writeSession({
        id: 'projection-campus', title: 'Projection campus',
        description: 'Retour sur la dernière projection du campus.',
        status: 'published', activityIds: [], voteOpen: false, feedbackOpen: true, announcement: null,
      });
      await writeSession({
        id: 'prochaine-seance', title: 'La prochaine séance',
        description: 'Choisissez une activité, puis précisez le format que vous aimeriez.',
        status: 'published', activityIds: initialActivities.map(([id]) => id),
        voteOpen: true, feedbackOpen: false, announcement: null,
      });
    }
    await db.prepare("UPDATE schema_settings SET value = 1 WHERE name = 'seed'").run();
    if (db.dialect === 'sqlite') await db.exec('PRAGMA user_version = 1');
  });
}

await seed();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireThat(condition, status, message) {
  if (!condition) throw new RequestError(status, message);
}

const idPattern = /^[a-zA-Z0-9-]{1,80}$/;

function readOrigin(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch {
    // L’erreur est commune à tous les formats d’origine invalides.
  }
  throw new Error('Indiquez une origine HTTP(S) sans chemin, par exemple https://activites.example.org.');
}

function readText(value, field, max, required = true) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '';
  requireThat(!required || text !== '', 400, `Renseignez ${field}.`);
  requireThat(text.length <= max, 400, `${field} ne doit pas dépasser ${max} caractères.`);
  return text;
}

function readBoolean(value, field, fallback) {
  if (value === undefined) return fallback;
  requireThat(typeof value === 'boolean', 400, `${field} doit être activé ou désactivé.`);
  return value;
}

function readImage(value) {
  const text = readText(value, 'l’image', 1000, false);
  if (!text) return '/images/im5.jpeg';
  try {
    const url = new URL(text, 'http://local.invalid');
    if ((text.startsWith('/images/') || /^\/media\/images\/[a-f0-9-]{36}$/.test(text)) && url.origin === 'http://local.invalid'
      && (url.pathname.startsWith('/images/') || url.pathname.startsWith('/media/images/')) && !url.search && !url.hash) return url.pathname;
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    // L’erreur est commune aux URL non autorisées.
  }
  throw new RequestError(400, 'Importez une image, choisissez une image du site ou indiquez une URL HTTPS.');
}

async function readActivity(body, existing) {
  const { options, name, description, image, question, archived } = { ...existing, ...body };
  requireThat(Array.isArray(options) && options.length >= 2 && options.length <= 8,
    400, 'Ajoutez entre 2 et 8 réponses au sondage de l’activité.');
  const choices = options.map(option => ({
    id: option?.id || randomUUID(),
    label: readText(option?.label, 'le libellé de chaque réponse', 120),
  }));
  requireThat(choices.every(({ id }) => typeof id === 'string' && idPattern.test(id))
    && new Set(choices.map(({ id }) => id)).size === choices.length, 400, 'Identifiants de réponse invalides.');
  requireThat(new Set(choices.map(({ label }) => label.toLocaleLowerCase('fr'))).size === choices.length,
    400, 'Les réponses du sondage doivent être différentes.');
  const currentLabels = new Map(existing?.options.map(({ id, label }) => [id, label]));
  const hadAnotherLabel = db.prepare(`
    SELECT 1 FROM votes WHERE activityId = ? AND optionId = ? AND optionLabel <> ? LIMIT 1
  `);
  const stableChoices = existing ? await Promise.all(choices.map(async choice => {
    const currentLabel = currentLabels.get(choice.id);
    const changedLabel = currentLabel !== undefined && currentLabel !== choice.label;
    const reusedId = currentLabel === undefined && await hadAnotherLabel.get(existing.id, choice.id, choice.label);
    return changedLabel || reusedId ? { ...choice, id: randomUUID() } : choice;
  })) : choices;
  return {
    id: existing?.id || randomUUID(),
    name: readText(name, 'le nom de l’activité', 90),
    description: readText(description, 'la description', 350, false),
    image: readImage(image),
    question: readText(question, 'la question du sondage', 160),
    options: stableChoices,
    archived: readBoolean(archived, 'L’archivage', false),
  };
}

function readDate(value, field) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)), 400, `Indiquez une date et une heure valides pour ${field}.`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  requireThat(year >= 1000 && day <= lastDay, 400, `Indiquez une date valide pour ${field}.`);
  return new Date(value).toISOString();
}

async function readAnnouncement(announcement) {
  if (!announcement) return null;
  const { activityId, date, location, mode, hint, revealAt } = announcement;
  requireThat(typeof activityId === 'string' && idPattern.test(activityId)
    && await findActivity(activityId), 400, 'Choisissez une activité existante pour l’annonce.');
  requireThat(['normal', 'surprise'].includes(mode), 400, 'Choisissez le mode de l’annonce.');
  return {
    activityId,
    date: readDate(date, 'la séance'),
    location: readText(location, 'le lieu', 180),
    mode,
    hint: mode === 'surprise' ? readText(hint, 'l’indice', 300, false) : '',
    revealAt: mode === 'surprise' && revealAt ? readDate(revealAt, 'la révélation') : null,
  };
}

async function readSession(body, existing) {
  const { status, activityIds, title, description, voteOpen, feedbackOpen, announcement } = {
    status: 'draft', activityIds: [], ...existing, ...body,
  };
  requireThat(['draft', 'published', 'archived'].includes(status), 400, 'Statut de séance invalide.');
  requireThat(Array.isArray(activityIds) && activityIds.length <= 30
    && activityIds.every(id => typeof id === 'string' && idPattern.test(id)),
    400, 'Choisissez des activités existantes.');
  const available = new Map((await activities()).map(activity => [activity.id, activity]));
  const selected = activityIds.map(id => available.get(id));
  requireThat(selected.every(Boolean), 400, 'Choisissez des activités existantes.');
  const open = readBoolean(voteOpen, 'Le vote', false);
  const ids = [...new Set(activityIds)];
  if (open && status === 'published') {
    requireThat(selected.some(activity => !activity.archived),
      400, 'Ajoutez au moins une activité active pour ouvrir le vote.');
  }
  return {
    id: existing?.id || randomUUID(),
    title: readText(title, 'le titre de la séance', 120),
    description: readText(description, 'la description', 500, false),
    status,
    activityIds: ids,
    voteOpen: open,
    feedbackOpen: readBoolean(feedbackOpen, 'Les avis', false),
    announcement: await readAnnouncement(announcement),
  };
}

const app = express();
app.disable('x-powered-by');
app.disable('etag');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (production && req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': req.query.reset ? 'no-referrer' : 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; form-action 'self'",
  });
  next();
});

const api = express.Router();
app.use('/api', api);

api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const knownOrigins = [publicOrigin, requestOrigin(req)].filter(Boolean);
  requireThat(req.get('sec-fetch-site') !== 'cross-site' && (!origin || knownOrigins.includes(origin)),
    403, 'Requête refusée. Ouvrez le formulaire depuis le site.');
  next();
});
api.use(express.json({ limit: '64kb' }));

function requestOrigin(req) {
  try {
    return readOrigin(`${req.protocol}://${req.get('host')}`);
  } catch {
    return null;
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function readCookie(req, name) {
  const cookie = req.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(cookie) ? cookie : null;
}


function legacyParticipant(req) {
  const token = readCookie(req, 'gasa_participant');
  return token ? digest(token).toString('hex') : null;
}

async function migrateBrowserResponses(req, res, student) {
  const previous = legacyParticipant(req);
  if (!previous) return;
  await mutate(async () => {
    for (const table of ['votes', 'feedback', 'guesses']) {
      const migrated = await db.prepare(`UPDATE ${table} AS legacy SET participant = ? WHERE participant = ? AND NOT EXISTS (
        SELECT 1 FROM ${table} AS current_response
        WHERE current_response.sessionId = legacy.sessionId AND current_response.participant = ?
      ) RETURNING sessionId`).all('student:' + student.id, previous, 'student:' + student.id);
      for (const row of migrated) {
        await db.prepare('UPDATE user_actions SET student_id=?,actor_name=?,actor_email=? WHERE id=? AND student_id IS NULL')
          .run(student.id, student.name, student.email, `historique-${table}-${row.sessionId}-${previous}`);
      }
    }
  });
  res.clearCookie('gasa_participant', { httpOnly: true, sameSite: 'lax', secure: production || req.secure, path: '/' });
}

let engagement;
let directory;
const auth = await installAccounts({ api, db, production, publicOrigin, sendEmail,
  onStudentRegistered: (student, body) => body.programId !== undefined || body.studyYear !== undefined
    ? directory.saveAcademicProfile(student.id, body, student) : undefined,
  onStudentAuthenticated: migrateBrowserResponses,
  onAccountEvent: event => engagement?.recordAccountEvent(event) });
directory = await installDirectory({ api, db, auth, mutate, record: event => engagement?.record(event) });
engagement = await installEngagement({ app, api, db, auth, mutate });
await installGallery({ app, api, db, auth, mutate, record: engagement.record });
const cinema = await installCinema({ api, db, auth, publicOrigin, mutate, onChange: event => engagement.record(event) });
const push = await createPush({ db });
push.mount(api);
await push.syncScheduledReveals((await db.prepare("SELECT * FROM sessions WHERE status = 'published'").all()).map(sessionFromRow));
api.use('/admin', auth.requireAdmin('read'));

function requireArchivePermission(req) {
  requireThat(req.admin.capabilities.includes('archive'), 403, 'Cette action est réservée au responsable du comité.');
}

// Serialize application edits with responses, including across PostgreSQL connections.
// This keeps a closed poll from accepting a response while an admin edit commits.
async function mutate(work) {
  return db.transaction(async () => {
    await db.prepare("SELECT value FROM schema_settings WHERE name = 'seed'"
      + (db.dialect === 'postgres' ? ' FOR UPDATE' : '')).get();
    return work();
  });
}

async function saveSessionAndNotice(session, previous = null) {
  await db.transaction(async () => {
    await writeSession(session);
    await push.noteSession(session, previous);
  });
}

api.get('/admin/dashboard', async (req, res) => {
  const sessions = (await db.prepare('SELECT * FROM sessions ORDER BY createdAt DESC, ' + db.orderColumn + ' DESC')
    .all()).map(sessionFromRow);
  for (const session of sessions) session.cinema = await cinema.readForSession(session.id);
  res.json({ activities: await activities(), sessions, publicUrl: publicOrigin || requestOrigin(req) });
});

api.post('/admin/activities', auth.requireAdmin('edit'), async (req, res) => {
  const activity = await mutate(async () => {
    const value = await readActivity(req.body);
    if (value.archived) requireArchivePermission(req);
    await writeActivity(value);
    await engagement.record({ kind: 'admin.activity-create', admin: req.admin, detail: value.name });
    return value;
  });
  res.status(201).json(activity);
});

api.put('/admin/activities/:id', auth.requireAdmin('edit'), async (req, res) => {
  const activity = await mutate(async () => {
    const existing = await findActivity(req.params.id);
    requireThat(existing, 404, 'Activité introuvable.');
    const value = await readActivity(req.body, existing);
    if (value.archived || existing.archived) requireArchivePermission(req);
    await updateActivity(value, existing);
    await engagement.record({ kind: 'admin.activity-update', admin: req.admin, detail: value.name });
    return value;
  });
  res.json(activity);
});

api.post('/admin/sessions', auth.requireAdmin('edit'), async (req, res) => {
  const clip = req.body?.cinema !== undefined ? await cinema.validateCinema(req.body.cinema) : undefined;
  const session = await mutate(async () => {
    const value = await readSession(req.body);
    if (value.status === 'archived') requireArchivePermission(req);
    await saveSessionAndNotice(value);
    if (clip !== undefined) await cinema.persistCinema(value.id, clip);
    await engagement.record({ kind: 'admin.session-create', admin: req.admin, session: value, detail: value.status });
    value.cinema = await cinema.readForSession(value.id);
    return value;
  });
  push.wake();
  res.status(201).json(session);
});

async function sessionOr404(id) {
  const session = await findSession(id);
  requireThat(session, 404, 'Séance introuvable.');
  return session;
}

api.put('/admin/sessions/:id', auth.requireAdmin('edit'), async (req, res) => {
  const clip = req.body?.cinema !== undefined ? await cinema.validateCinema(req.body.cinema) : undefined;
  const session = await mutate(async () => {
    const previous = await sessionOr404(req.params.id);
    const value = await readSession(req.body, previous);
    if (value.status === 'archived' || previous.status === 'archived'
      || (previous.status === 'published' && value.status === 'draft')) requireArchivePermission(req);
    await saveSessionAndNotice(value, previous);
    if (clip !== undefined) await cinema.persistCinema(value.id, clip);
    await engagement.record({ kind: 'admin.session-update', admin: req.admin, session: value, detail: value.status });
    value.cinema = await cinema.readForSession(value.id);
    return value;
  });
  push.wake();
  res.json(session);
});

async function listedActivities(session) {
  return (await Promise.all(session.activityIds.map(findActivity))).filter(activity => activity && !activity.archived);
}

async function allowedGuesses() {
  return (await activities()).map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

function announcementIsRevealed(announcement) {
  return announcement.mode === 'normal'
    || Boolean(announcement.revealAt && Date.parse(announcement.revealAt) <= Date.now());
}

async function hasResponded(table, sessionId, voter) {
  if (!voter) return false;
  const statements = {
    votes: 'SELECT 1 FROM votes WHERE sessionId = ? AND participant = ?',
    feedback: 'SELECT 1 FROM feedback WHERE sessionId = ? AND participant = ?',
    guesses: 'SELECT 1 FROM guesses WHERE sessionId = ? AND participant = ?',
  };
  return Boolean(await db.prepare(statements[table]).get(sessionId, voter));
}

api.get('/home', async (req, res) => {
  const sessionId = req.query.session;
  const scoped = sessionId !== undefined;
  requireThat(!scoped || (typeof sessionId === 'string' && idPattern.test(sessionId)), 400, 'Séance invalide.');
  const rows = scoped
    ? await db.prepare("SELECT * FROM sessions WHERE status = 'published' AND id = ?").all(sessionId)
    : await db.prepare("SELECT * FROM sessions WHERE status = 'published' ORDER BY createdAt DESC, " + db.orderColumn + ' DESC').all();
  const sessions = rows.map(sessionFromRow);
  const available = new Map((await activities()).map(activity => [activity.id, activity]));
  const activeBySession = new Map(sessions.map(session => [session.id,
    session.activityIds.map(id => available.get(id)).filter(activity => activity && !activity.archived)]));
  const vote = sessions.find(session => session.voteOpen && activeBySession.get(session.id).length > 0)
    || sessions.find(session => session.activityIds.length > 0);
  const feedbackRows = rows.filter(row => row.feedbackEnabled);
  const feedback = sessionFromRow(feedbackRows.find(row => row.feedbackOpen) || feedbackRows[0]);
  const now = Date.now();
  // Les séances sont déjà triées de la plus récente à la plus ancienne en cas d’égalité.
  const announced = sessions.filter(session => session.announcement);
  const event = scoped ? announced[0] : announced
    .filter(session => Date.parse(session.announcement.date) >= now)
    .sort((first, second) => Date.parse(first.announcement.date) - Date.parse(second.announcement.date))[0];
  const student = await auth.student(req, res);
  const voter = student ? 'student:' + student.id : null;
  let publicAnnouncement = null;
  if (event) {
    const announcement = event.announcement;
    const revealed = announcementIsRevealed(announcement);
    const activity = revealed ? await findActivity(announcement.activityId) : null;
    publicAnnouncement = {
      id: event.id, title: revealed ? event.title : 'Activité mystère', date: announcement.date,
      location: announcement.location, mode: announcement.mode, revealed, hint: announcement.hint,
      revealAt: announcement.revealAt,
      activity: activity ? { id: activity.id, name: activity.name, description: activity.description, image: activity.image } : null,
      choices: revealed ? [] : await allowedGuesses(),
      responded: await hasResponded('guesses', event.id, voter),
    };
  }
  const pollActivities = vote ? activeBySession.get(vote.id) : [];
  const voteIsMystery = vote?.announcement && !announcementIsRevealed(vote.announcement);
  const feedbackIsMystery = feedback?.announcement && !announcementIsRevealed(feedback.announcement);
  res.json({
    poll: vote ? {
      id: vote.id, title: voteIsMystery ? 'Activité mystère' : vote.title,
      description: voteIsMystery ? '' : vote.description, open: vote.voteOpen && pollActivities.length > 0,
      activities: pollActivities, responded: await hasResponded('votes', vote.id, voter),
    } : null,
    feedback: feedback ? {
      id: feedback.id, title: feedbackIsMystery ? 'Activité mystère' : feedback.title, open: feedback.feedbackOpen,
      responded: await hasResponded('feedback', feedback.id, voter),
    } : null,
    announcement: publicAnnouncement,
  });
});

async function publishedSession(id) {
  const session = await sessionOr404(id);
  requireThat(session.status === 'published', 404, 'Cette séance n’est pas disponible.');
  return session;
}

api.post('/sessions/:id/vote', auth.requireStudent, async (req, res) => {
  await mutate(async () => {
  const session = await publishedSession(req.params.id);
  requireThat(session.voteOpen, 409, 'Le vote est fermé.');
  const activity = (await listedActivities(session)).find(item => item.id === req.body?.activityId);
  const option = activity?.options.find(item => item.id === req.body?.optionId);
  requireThat(option, 400, 'Choisissez une activité et une réponse valides.');
  const result = await db.prepare(`
    INSERT INTO votes (sessionId, participant, activityId, optionId, optionLabel,created_at)
    VALUES (?, ?, ?, ?, ?,?) ON CONFLICT (sessionId, participant) DO NOTHING
  `).run(session.id, 'student:' + req.student.id, activity.id, option.id, option.label, new Date().toISOString());
  requireThat(result.changes > 0, 409, 'Votre vote a déjà été enregistré.');
  await engagement.record({ kind: 'vote', student: req.student, session, detail: `${activity.name} · ${option.label}` });
  });
  res.status(201).json({ ok: true });
});

api.post('/sessions/:id/feedback', auth.requireStudent, async (req, res) => {
  await mutate(async () => {
  const session = await publishedSession(req.params.id);
  requireThat(session.feedbackOpen, 409, 'La collecte des avis est fermée.');
  const rating = req.body?.rating;
  const comment = readText(req.body?.comment, 'le commentaire', 1200, false);
  requireThat(Number.isInteger(rating) && rating >= 1 && rating <= 5, 400, 'Choisissez une note de 1 à 5.');
  const result = await db.prepare(`
    INSERT INTO feedback (id, sessionId, participant, rating, comment, createdAt)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sessionId, participant) DO NOTHING
  `).run(randomUUID(), session.id, 'student:' + req.student.id, rating, comment, new Date().toISOString());
  requireThat(result.changes > 0, 409, 'Votre avis a déjà été enregistré.');
  await engagement.record({ kind: 'feedback', student: req.student, session, detail: `${rating}/5 · ${comment}` });
  });
  res.status(201).json({ ok: true });
});

api.post('/sessions/:id/guess', auth.requireStudent, async (req, res) => {
  await mutate(async () => {
  const session = await publishedSession(req.params.id);
  requireThat(session.announcement?.mode === 'surprise' && !announcementIsRevealed(session.announcement),
    409, 'Les propositions sont fermées.');
  const activityId = req.body?.activityId;
  requireThat((await allowedGuesses()).some(activity => activity.id === activityId), 400, 'Choisissez une activité proposée.');
  const result = await db.prepare(`
    INSERT INTO guesses (sessionId, participant, activityId,created_at)
    VALUES (?, ?, ?,?) ON CONFLICT (sessionId, participant) DO NOTHING
  `).run(session.id, 'student:' + req.student.id, activityId, new Date().toISOString());
  requireThat(result.changes > 0, 409, 'Votre proposition a déjà été enregistrée.');
  await engagement.record({ kind: 'guess', student: req.student, session, detail: (await findActivity(activityId)).name });
  });
  res.status(201).json({ ok: true });
});

async function resultsFor(session, includeIdentity = false) {
  const grouped = await db.prepare(`
    SELECT activityId, optionId, MIN(optionLabel) AS optionLabel, COUNT(*) AS count FROM votes
    WHERE sessionId = ? GROUP BY activityId, optionId
  `).all(session.id);
  const ids = new Set([...session.activityIds, ...grouped.map(vote => vote.activityId)]);
  const votes = await Promise.all([...ids].map(async activityId => {
    const activity = await findActivity(activityId);
    const options = new Map(activity.options.map(({ id, label }) => [id, { id, label, count: 0 }]));
    let count = 0;
    for (const vote of grouped.filter(row => row.activityId === activityId)) {
      const label = options.get(vote.optionId)?.label || vote.optionLabel;
      options.set(vote.optionId, { id: vote.optionId, label, count: vote.count });
      count += vote.count;
    }
    return { activityId, name: activity.name, count, options: [...options.values()] };
  }));
  const feedback = (await db.prepare(`
    SELECT f.id, f.rating, f.comment, f.createdAt, f.hidden
    ${includeIdentity ? ',p.id AS studentId,p.name,p.email' : ''}
    FROM feedback f ${includeIdentity ? "LEFT JOIN student_accounts p ON f.participant='student:'||p.id" : ''}
    WHERE f.sessionId = ? ORDER BY f.createdAt DESC
  `).all(session.id)).map(item => ({ ...item, hidden: Boolean(item.hidden) }));
  const guesses = (await db.prepare('SELECT COUNT(*) AS count FROM guesses WHERE sessionId = ?').get(session.id)).count;
  const responses = includeIdentity ? await db.prepare(`SELECT kind,actor_name AS name,actor_email AS email,
    created_at AS createdAt,detail FROM user_actions WHERE session_id=? AND kind IN ('vote','feedback','guess')
    ORDER BY CASE WHEN created_at IS NULL THEN 1 ELSE 0 END,created_at DESC`).all(session.id) : [];
  return { votes, feedback, guesses, responses };
}

api.get('/admin/sessions/:id/results', async (req, res) => {
  res.json(await resultsFor(await sessionOr404(req.params.id), req.admin.capabilities.includes('trace')));
});

api.put('/admin/sessions/:id/feedback/:feedbackId', auth.requireAdmin('moderate'), async (req, res) => {
  const hidden = readBoolean(req.body?.hidden, 'La visibilité', undefined);
  requireThat(hidden !== undefined, 400, 'Choisissez de masquer ou de rétablir l’avis.');
  const result = await db.prepare('UPDATE feedback SET hidden = ? WHERE sessionId = ? AND id = ?')
    .run(Number(hidden), req.params.id, req.params.feedbackId);
  requireThat(result.changes > 0, 404, 'Avis introuvable.');
  await engagement.record({ kind: 'admin.feedback-moderation', admin: req.admin,
    session: await sessionOr404(req.params.id), detail: hidden ? 'Avis masqué' : 'Avis rétabli' });
  res.json({ hidden });
});

api.get('/admin/sessions/:id/qr/:kind', auth.requireAdmin('share'), async (req, res) => {
  const session = await sessionOr404(req.params.id);
  const { kind } = req.params;
  requireThat(['vote', 'avis', 'annonce'].includes(kind), 404, 'Parcours introuvable.');
  let baseUrl = publicOrigin || requestOrigin(req);
  if (req.query.baseUrl !== undefined) {
    try {
      requireThat(typeof req.query.baseUrl === 'string' && req.query.baseUrl.length <= 1000, 400, 'Adresse invalide.');
      baseUrl = readOrigin(req.query.baseUrl);
    } catch {
      throw new RequestError(400, 'Indiquez une origine HTTP(S) sans chemin, par exemple https://activites.example.org.');
    }
  }
  requireThat(baseUrl, 400, 'Indiquez une adresse publique pour créer le QR code.');
  const url = new URL('/', baseUrl);
  url.search = new URLSearchParams({ vue: kind, seance: session.id }).toString();
  const png = await QRCode.toBuffer(url.href, { type: 'png', width: 800, margin: 3, errorCorrectionLevel: 'M' });
  res.attachment(`gasa-${kind}-${session.id}.png`).send(png);
});

const timeFormat = new Intl.DateTimeFormat('fr-BJ', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Porto-Novo',
});

function exportSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(([header, width]) => ({ header, width }));
  sheet.addRows(rows);
  const header = sheet.getRow(1);
  header.height = 22;
  header.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111B32' } };
  for (let index = 1; index <= columns.length; index += 1) {
    sheet.getColumn(index).alignment = { vertical: 'top', wrapText: true };
  }
  return sheet;
}

async function summaries(session, results) {
  const total = results.votes.reduce((sum, item) => sum + item.count, 0);
  const rows = [
    ['Séance', session.title],
    ['Votes enregistrés', total],
    ['Avis reçus', results.feedback.length],
    ['Propositions mystère', results.guesses],
  ];
  if (results.feedback.length > 0) {
    const rating = results.feedback.reduce((sum, item) => sum + item.rating, 0) / results.feedback.length;
    rows.push(['Note moyenne sur 5', Math.round(rating * 100) / 100]);
  }
  if (session.announcement) {
    const { activityId, date, location } = session.announcement;
    rows.push(['Activité retenue', (await findActivity(activityId))?.name || ''], ['Date', timeFormat.format(new Date(date))],
      ['Lieu', location]);
  }
  return rows;
}

async function exportExcel(session, results) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'UATM GASA';
  exportSheet(workbook, 'Synthèse', [['Indicateur', 29], ['Valeur', 50]], await summaries(session, results));
  exportSheet(workbook, 'Activités', [['Activité', 34], ['Votes', 14]],
    results.votes.map(activity => [activity.name, activity.count]));
  exportSheet(workbook, 'Réponses', [['Activité', 34], ['Réponse', 56], ['Votes', 14]],
    results.votes.flatMap(activity => activity.options.map(option => [activity.name, option.label, option.count])));
  exportSheet(workbook, 'Avis', [['Date', 22], ['Note sur 5', 14], ['Commentaire', 74], ['Statut', 15]],
    results.feedback.map(item => [timeFormat.format(new Date(item.createdAt)), item.rating, item.comment, item.hidden ? 'Masqué' : 'Visible']));
  exportSheet(workbook, 'Participations', [['Nom', 30], ['E-mail', 38], ['Action', 22], ['Date', 28], ['Réponse', 74]],
    results.responses.map(item => [item.name, item.email, item.kind, item.createdAt ? timeFormat.format(new Date(item.createdAt)) : 'Date historique inconnue', item.detail]));
  return workbook.xlsx.writeBuffer();
}

function reportText(text, heading) {
  return new Paragraph({ text, heading, spacing: { after: 110 } });
}

async function exportWord(session, results) {
  const paragraphs = [reportText(session.title, HeadingLevel.TITLE), reportText('Bilan de la vie étudiante · UATM GASA')];
  if (session.description) paragraphs.push(reportText(session.description));
  for (const [label, value] of (await summaries(session, results)).slice(1)) {
    paragraphs.push(reportText(`${label} : ${value}`));
  }
  paragraphs.push(reportText('Votes par activité', HeadingLevel.HEADING_1));
  if (!results.votes.length) paragraphs.push(reportText('Aucune activité proposée.'));
  for (const item of results.votes) {
    paragraphs.push(reportText(`${item.name} — ${item.count}`, HeadingLevel.HEADING_2));
    for (const option of item.options) paragraphs.push(reportText(`${option.label} : ${option.count}`));
  }
  paragraphs.push(reportText('Avis sur la séance', HeadingLevel.HEADING_1));
  if (!results.feedback.length) paragraphs.push(reportText('Aucun avis reçu.'));
  for (const item of results.feedback) {
    const status = item.hidden ? ' · Masqué' : '';
    paragraphs.push(reportText(`${item.rating}/5 · ${timeFormat.format(new Date(item.createdAt))}${status}`, HeadingLevel.HEADING_2));
    if (item.comment) {
      for (const line of item.comment.split(/\r?\n/)) paragraphs.push(reportText(line));
    }
  }
  paragraphs.push(reportText('Traçabilité des participations', HeadingLevel.HEADING_1));
  for (const item of results.responses) paragraphs.push(reportText(`${item.name} · ${item.email} · ${item.kind} · ${item.createdAt ? timeFormat.format(new Date(item.createdAt)) : 'Date historique inconnue'} · ${item.detail}`));
  return Packer.toBuffer(new Document({ creator: 'UATM GASA', title: session.title, sections: [{ children: paragraphs }] }));
}

api.get('/admin/sessions/:id/export/:format', auth.requireAdmin('export'), async (req, res) => {
  const session = await sessionOr404(req.params.id);
  const { format } = req.params;
  requireThat(['xlsx', 'docx'].includes(format), 404, 'Format d’export introuvable.');
  const results = await resultsFor(session, true);
  const report = format === 'xlsx' ? await exportExcel(session, results) : await exportWord(session, results);
  res.attachment(`gasa-bilan-${session.id}.${format}`).send(Buffer.from(report));
});

api.use((_req, res) => {
  res.status(404).json({ error: 'Ressource introuvable.' });
});

app.get('/healthz', async (_req, res) => {
  try {
    await db.prepare('SELECT 1').get();
    res.json({ ok: true, version: '2026.11.28.2' });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.get('/service-worker.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(resolve(root, 'service-worker.js'));
});
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').sendFile(resolve(root, 'manifest.webmanifest'));
});
app.use('/images', express.static(resolve(root, 'images')));
app.use('/videos', express.static(resolve(root, 'videos')));
app.get(['/', '/index.html', '/mainpage.html'], (_req, res) => res.sendFile(resolve(root, 'index.html')));
app.get(['/admin', '/admin.html'], (_req, res) => res.sendFile(resolve(root, 'admin.html')));
for (const file of ['style.css', 'student-themes.css', 'student-polls.css', 'script.js', 'student-interface.js', 'account-recovery.css', 'priority-survey.js', 'priority-survey.css', 'student-cinema.js', 'student-cinema.css', 'admin.css', 'admin.js']) {
  app.get(`/${file}`, (_req, res) => res.sendFile(resolve(root, file)));
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof RequestError || error instanceof AccountError || error instanceof EngagementError || error instanceof DirectoryError || error instanceof GalleryError) return res.status(error.status).json({ error: error.message });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Le contenu est trop volumineux.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Le formulaire est invalide.' });
  if (error.status === 404) return res.status(404).json({ error: 'Ressource introuvable.' });
  console.error(`${req.method} ${req.path}`, error.code || error.name || 'Erreur serveur');
  return res.status(500).json({ error: 'Une erreur est survenue. Réessayez dans un instant.' });
});

const server = app.listen(port, host, () => {
  console.log(`GASA Activités · http://${host}:${server.address().port}`);
});
let closing;
function close() {
  return closing ||= (async () => {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await auth.close();
    await push.stop();
    await db.close();
  })();
}
return { app, server, db, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const application = await createApplication();
  const shutdown = () => {
    const deadline = setTimeout(() => process.exit(1), 20_000);
    deadline.unref();
    application.close().then(() => clearTimeout(deadline), () => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
