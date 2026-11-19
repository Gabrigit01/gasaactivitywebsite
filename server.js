import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import QRCode from 'qrcode';
import { pool } from './config/database.js';
import { AccountError, installAccounts } from './accounts.js';
import { createPush } from './push.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const production = process.env.NODE_ENV === 'production';
const publicOrigin = process.env.PUBLIC_URL ? readOrigin(process.env.PUBLIC_URL) : null;
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);

if (production && !publicOrigin?.startsWith('https://')) {
  throw new Error('PUBLIC_URL doit indiquer le domaine HTTPS du site en production.');
}

// Le schéma métier principal. Les colonnes camelCase du schéma SQLite
// sont ici écrites en minuscules, conformément au comportement PostgreSQL.
await pool.query(`
  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    image TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK (archived IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
    activityids TEXT NOT NULL,
    voteopen INTEGER NOT NULL CHECK (voteopen IN (0, 1)),
    feedbackopen INTEGER NOT NULL CHECK (feedbackopen IN (0, 1)),
    feedbackenabled INTEGER NOT NULL CHECK (feedbackenabled IN (0, 1)),
    announcement TEXT,
    createdat BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    sessionid TEXT NOT NULL REFERENCES sessions(id),
    participant TEXT NOT NULL,
    activityid TEXT NOT NULL REFERENCES activities(id),
    optionid TEXT NOT NULL,
    optionlabel TEXT NOT NULL,
    PRIMARY KEY (sessionid, participant)
  );

  CREATE INDEX IF NOT EXISTS votes_by_option ON votes(activityid, optionid);

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    sessionid TEXT NOT NULL REFERENCES sessions(id),
    participant TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL,
    createdat TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    UNIQUE (sessionid, participant)
  );

  CREATE TABLE IF NOT EXISTS guesses (
    sessionid TEXT NOT NULL REFERENCES sessions(id),
    participant TEXT NOT NULL,
    activityid TEXT NOT NULL REFERENCES activities(id),
    PRIMARY KEY (sessionid, participant)
  );
`);

function activityFromRow(row) {
  return row ? {
    ...row,
    options: JSON.parse(row.options),
    archived: Boolean(row.archived),
  } : null;
}

function sessionFromRow(row) {
  if (!row) return null;
  const { createdat, feedbackenabled, ...session } = row;
  return {
    ...session,
    activityIds: JSON.parse(row.activityids),
    voteOpen: Boolean(row.voteopen),
    feedbackOpen: Boolean(row.feedbackopen),
    announcement: row.announcement ? JSON.parse(row.announcement) : null,
  };
}

async function activities(queryable = pool) {
  // PostgreSQL ne possède pas de rowid équivalent à SQLite.
  // Le tri par nom fournit un ordre stable.
  const result = await queryable.query('SELECT * FROM activities ORDER BY name, id');
  return result.rows.map(activityFromRow);
}

async function findActivity(id, queryable = pool) {
  const result = await queryable.query('SELECT * FROM activities WHERE id = $1', [id]);
  return activityFromRow(result.rows[0]);
}

async function findSession(id, queryable = pool) {
  const result = await queryable.query('SELECT * FROM sessions WHERE id = $1', [id]);
  return sessionFromRow(result.rows[0]);
}

async function writeActivity(activity, queryable = pool) {
  await queryable.query(`
    INSERT INTO activities (id, name, description, image, question, options, archived)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      image = EXCLUDED.image,
      question = EXCLUDED.question,
      options = EXCLUDED.options,
      archived = EXCLUDED.archived
  `, [
    activity.id,
    activity.name,
    activity.description,
    activity.image,
    activity.question,
    JSON.stringify(activity.options),
    Number(activity.archived),
  ]);
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Échec du rollback PostgreSQL :', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateActivity(activity, previous) {
  if (!activity.archived || previous.archived) {
    await writeActivity(activity);
    return;
  }

  await withTransaction(async (client) => {
    await writeActivity(activity, client);
    const [sessionResult, activeResult] = await Promise.all([
      client.query("SELECT id, activityids FROM sessions WHERE status = 'published' AND voteopen = 1"),
      client.query('SELECT id FROM activities WHERE archived = 0'),
    ]);
    const activeIds = new Set(activeResult.rows.map((row) => row.id));

    for (const row of sessionResult.rows) {
      const ids = JSON.parse(row.activityids);
      if (!ids.some((id) => activeIds.has(id))) {
        await client.query('UPDATE sessions SET voteopen = 0 WHERE id = $1', [row.id]);
      }
    }
  });
}

async function writeSession(session, queryable = pool) {
  await queryable.query(`
    INSERT INTO sessions (
      id, title, description, status, activityids, voteopen, feedbackopen,
      feedbackenabled, announcement, createdat
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      activityids = EXCLUDED.activityids,
      voteopen = EXCLUDED.voteopen,
      feedbackopen = EXCLUDED.feedbackopen,
      feedbackenabled = GREATEST(sessions.feedbackenabled, EXCLUDED.feedbackenabled),
      announcement = EXCLUDED.announcement
  `, [
    session.id,
    session.title,
    session.description,
    session.status,
    JSON.stringify(session.activityIds),
    Number(session.voteOpen),
    Number(session.feedbackOpen),
    Number(session.feedbackOpen),
    session.announcement ? JSON.stringify(session.announcement) : null,
    Date.now(),
  ]);
}

async function seed() {
  const state = await pool.query(`
    SELECT
      EXISTS (SELECT 1 FROM activities) AS has_activities,
      EXISTS (SELECT 1 FROM sessions) AS has_sessions
  `);
  if (state.rows[0].has_activities || state.rows[0].has_sessions) return;

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

  await withTransaction(async (client) => {
    for (const [id, name, description, file, question, labels] of initialActivities) {
      const options = labels.map((label, index) => ({ id: `option-${index + 1}`, label }));
      await writeActivity({
        id, name, description, image: `/images/${file}`, question, options, archived: false,
      }, client);
    }

    await writeSession({
      id: 'projection-campus',
      title: 'Projection campus',
      description: 'Retour sur la dernière projection du campus.',
      status: 'published',
      activityIds: [],
      voteOpen: false,
      feedbackOpen: true,
      announcement: null,
    }, client);

    await writeSession({
      id: 'prochaine-seance',
      title: 'La prochaine séance',
      description: 'Choisissez une activité, puis précisez le format que vous aimeriez.',
      status: 'published',
      activityIds: initialActivities.map(([id]) => id),
      voteOpen: true,
      feedbackOpen: false,
      announcement: null,
    }, client);
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
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
    : '';
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
    if (text.startsWith('/images/') && url.origin === 'http://local.invalid'
      && url.pathname.startsWith('/images/') && !url.search && !url.hash) return url.pathname;
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    // L’erreur est commune aux URL non autorisées.
  }
  throw new RequestError(400, 'Choisissez une image du dossier /images/ ou une URL HTTPS.');
}

async function readActivity(body, existing) {
  const { options, name, description, image, question, archived } = { ...existing, ...body };
  requireThat(Array.isArray(options) && options.length >= 2 && options.length <= 8,
    400, 'Ajoutez entre 2 et 8 réponses au sondage de l’activité.');
  const choices = options.map((option) => ({
    id: option?.id || randomUUID(),
    label: readText(option?.label, 'le libellé de chaque réponse', 120),
  }));
  requireThat(choices.every(({ id }) => typeof id === 'string' && idPattern.test(id))
    && new Set(choices.map(({ id }) => id)).size === choices.length,
  400, 'Identifiants de réponse invalides.');
  requireThat(new Set(choices.map(({ label }) => label.toLocaleLowerCase('fr'))).size === choices.length,
    400, 'Les réponses du sondage doivent être différentes.');

  const currentLabels = new Map((existing?.options || []).map(({ id, label }) => [id, label]));
  const stableChoices = [];
  for (const choice of choices) {
    const currentLabel = currentLabels.get(choice.id);
    const changedLabel = currentLabel !== undefined && currentLabel !== choice.label;
    let reusedId = false;
    if (existing && currentLabel === undefined) {
      const historical = await pool.query(`
        SELECT 1 FROM votes
        WHERE activityid = $1 AND optionid = $2 AND optionlabel <> $3
        LIMIT 1
      `, [existing.id, choice.id, choice.label]);
      reusedId = historical.rowCount > 0;
    }
    stableChoices.push(changedLabel || reusedId ? { ...choice, id: randomUUID() } : choice);
  }

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
  requireThat(typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)),
  400, `Indiquez une date et une heure valides pour ${field}.`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  requireThat(year >= 1000 && day <= lastDay, 400, `Indiquez une date valide pour ${field}.`);
  return new Date(value).toISOString();
}

async function readAnnouncement(announcement) {
  if (!announcement) return null;
  const { activityId, date, location, mode, hint, revealAt } = announcement;
  requireThat(typeof activityId === 'string' && idPattern.test(activityId)
    && await findActivity(activityId),
  400, 'Choisissez une activité existante pour l’annonce.');
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
  const {
    status, activityIds, title, description, voteOpen, feedbackOpen, announcement,
  } = { status: 'draft', activityIds: [], ...existing, ...body };

  requireThat(['draft', 'published', 'archived'].includes(status), 400, 'Statut de séance invalide.');
  requireThat(Array.isArray(activityIds) && activityIds.length <= 30
    && activityIds.every((id) => typeof id === 'string' && idPattern.test(id)),
  400, 'Choisissez des activités existantes.');
  const ids = [...new Set(activityIds)];
  if (ids.length) {
    const result = await pool.query('SELECT id FROM activities WHERE id = ANY($1::text[])', [ids]);
    requireThat(result.rowCount === ids.length, 400, 'Choisissez des activités existantes.');
  }

  const open = readBoolean(voteOpen, 'Le vote', false);
  if (open && status === 'published' && ids.length) {
    const result = await pool.query(
      'SELECT 1 FROM activities WHERE id = ANY($1::text[]) AND archived = 0 LIMIT 1', [ids],
    );
    requireThat(result.rowCount > 0, 400,
      'Ajoutez au moins une activité active pour ouvrir le vote.');
  } else if (open && status === 'published') {
    requireThat(false, 400, 'Ajoutez au moins une activité active pour ouvrir le vote.');
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
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; form-action 'self'",
  });
  next();
});

const api = express.Router();
app.use('/api', api);

function requestOrigin(req) {
  try {
    return readOrigin(`${req.protocol}://${req.get('host')}`);
  } catch {
    return null;
  }
}

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

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function readCookie(req, name) {
  const cookie = req.get('cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(cookie) ? cookie : null;
}

function legacyParticipant(req) {
  const token = readCookie(req, 'gasa_participant');
  return token ? digest(token).toString('hex') : null;
}

async function migrateBrowserResponses(req, res, student) {
  const previous = legacyParticipant(req);
  if (!previous) return;
  await withTransaction(async (client) => {
    const tables = [
      ['votes', 'sessionid'],
      ['feedback', 'sessionid'],
      ['guesses', 'sessionid'],
    ];
    for (const [table, sessionColumn] of tables) {
      await client.query(`
        UPDATE ${table} AS old
        SET participant = $1
        WHERE old.participant = $2
          AND NOT EXISTS (
            SELECT 1 FROM ${table} AS current
            WHERE current.${sessionColumn} = old.${sessionColumn}
              AND current.participant = $1
          )
      `, ['student:' + student.id, previous]);
    }
  });
  res.clearCookie('gasa_participant', {
    httpOnly: true,
    sameSite: 'lax',
    secure: production || req.secure,
    path: '/',
  });
}

const auth = await installAccounts({
  api,
  pool,
  production,
  onStudentAuthenticated: migrateBrowserResponses,
});
const push = await createPush({ pool });
await push.mount(api);
const scheduledSessions = await pool.query("SELECT * FROM sessions WHERE status = 'published'");
await push.syncScheduledReveals(scheduledSessions.rows.map(sessionFromRow));
api.use('/admin', auth.requireAdmin('read'));

function requireArchivePermission(req) {
  requireThat(req.admin.capabilities.includes('archive'), 403,
    'Cette action est réservée au responsable du comité.');
}

async function saveSessionAndNotice(session, previous = null) {
  await withTransaction(async (client) => {
    await writeSession(session, client);
    await push.noteSession(session, previous, client);
  });
}

api.get('/admin/dashboard', async (req, res) => {
  const result = await pool.query('SELECT * FROM sessions ORDER BY createdat DESC, id DESC');
  const sessions = result.rows.map(sessionFromRow);
  res.json({ activities: await activities(), sessions, publicUrl: publicOrigin || requestOrigin(req) });
});

api.post('/admin/activities', auth.requireAdmin('edit'), async (req, res) => {
  const activity = await readActivity(req.body);
  if (activity.archived) requireArchivePermission(req);
  await writeActivity(activity);
  res.status(201).json(activity);
});

api.put('/admin/activities/:id', auth.requireAdmin('edit'), async (req, res) => {
  const existing = await findActivity(req.params.id);
  requireThat(existing, 404, 'Activité introuvable.');
  const activity = await readActivity(req.body, existing);
  if (activity.archived || existing.archived) requireArchivePermission(req);
  await updateActivity(activity, existing);
  res.json(activity);
});

api.post('/admin/sessions', auth.requireAdmin('edit'), async (req, res) => {
  const session = await readSession(req.body);
  if (session.status === 'archived') requireArchivePermission(req);
  await saveSessionAndNotice(session);
  res.status(201).json(session);
});

async function sessionOr404(id) {
  const session = await findSession(id);
  requireThat(session, 404, 'Séance introuvable.');
  return session;
}

api.put('/admin/sessions/:id', auth.requireAdmin('edit'), async (req, res) => {
  const previous = await sessionOr404(req.params.id);
  const session = await readSession(req.body, previous);
  if (session.status === 'archived' || previous.status === 'archived'
    || (previous.status === 'published' && session.status === 'draft')) {
    requireArchivePermission(req);
  }
  await saveSessionAndNotice(session, previous);
  res.json(session);
});

async function listedActivities(session) {
  if (!session.activityIds.length) return [];
  const result = await pool.query(
    'SELECT * FROM activities WHERE id = ANY($1::text[]) AND archived = 0',
    [session.activityIds],
  );
  const byId = new Map(result.rows.map((row) => [row.id, activityFromRow(row)]));
  return session.activityIds.map((id) => byId.get(id)).filter(Boolean);
}

async function allowedGuesses() {
  const items = (await activities()).map(({ id, name }) => ({ id, name }));
  return items.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

function announcementIsRevealed(announcement) {
  return announcement.mode === 'normal'
    || Boolean(announcement.revealAt && Date.parse(announcement.revealAt) <= Date.now());
}

async function hasResponded(table, sessionId, voter) {
  if (!voter) return false;
  const statements = {
    votes: 'SELECT 1 FROM votes WHERE sessionid = $1 AND participant = $2',
    feedback: 'SELECT 1 FROM feedback WHERE sessionid = $1 AND participant = $2',
    guesses: 'SELECT 1 FROM guesses WHERE sessionid = $1 AND participant = $2',
  };
  const sql = statements[table];
  if (!sql) throw new Error('Table de réponse non autorisée.');
  const result = await pool.query(sql, [sessionId, voter]);
  return result.rowCount > 0;
}

api.get('/home', async (req, res) => {
  const sessionId = req.query.session;
  const scoped = sessionId !== undefined;
  requireThat(!scoped || (typeof sessionId === 'string' && idPattern.test(sessionId)), 400, 'Séance invalide.');

  const result = scoped
    ? await pool.query("SELECT * FROM sessions WHERE status = 'published' AND id = $1", [sessionId])
    : await pool.query("SELECT * FROM sessions WHERE status = 'published' ORDER BY createdat DESC, id DESC");
  const rows = result.rows;
  const sessions = rows.map(sessionFromRow);
  const activityLists = await Promise.all(sessions.map(listedActivities));
  const activitiesBySession = new Map(sessions.map((session, index) => [session.id, activityLists[index]]));
  const vote = sessions.find((session) => session.voteOpen && activitiesBySession.get(session.id).length > 0)
    || sessions.find((session) => session.activityIds.length > 0);
  const feedbackRows = rows.filter((row) => Boolean(row.feedbackenabled));
  const feedback = sessionFromRow(feedbackRows.find((row) => Boolean(row.feedbackopen)) || feedbackRows[0]);
  const now = Date.now();
  const announced = sessions.filter((session) => session.announcement);
  const event = scoped ? announced[0] : announced
    .filter((session) => Date.parse(session.announcement.date) >= now)
    .sort((first, second) => Date.parse(first.announcement.date) - Date.parse(second.announcement.date))[0];
  const student = await auth.student(req, res);
  const voter = student ? 'student:' + student.id : null;
  let publicAnnouncement = null;

  if (event) {
    const announcement = event.announcement;
    const revealed = announcementIsRevealed(announcement);
    const activity = revealed ? await findActivity(announcement.activityId) : null;
    publicAnnouncement = {
      id: event.id,
      title: revealed ? event.title : 'Activité mystère',
      date: announcement.date,
      location: announcement.location,
      mode: announcement.mode,
      revealed,
      hint: announcement.hint,
      revealAt: announcement.revealAt,
      activity: activity ? {
        id: activity.id,
        name: activity.name,
        description: activity.description,
        image: activity.image,
      } : null,
      choices: revealed ? [] : await allowedGuesses(),
      responded: await hasResponded('guesses', event.id, voter),
    };
  }

  const pollActivities = vote ? activitiesBySession.get(vote.id) : [];
  const voteIsMystery = vote?.announcement && !announcementIsRevealed(vote.announcement);
  const feedbackIsMystery = feedback?.announcement && !announcementIsRevealed(feedback.announcement);

  res.json({
    poll: vote ? {
      id: vote.id,
      title: voteIsMystery ? 'Activité mystère' : vote.title,
      description: voteIsMystery ? '' : vote.description,
      open: vote.voteOpen && pollActivities.length > 0,
      activities: pollActivities,
      responded: await hasResponded('votes', vote.id, voter),
    } : null,
    feedback: feedback ? {
      id: feedback.id,
      title: feedbackIsMystery ? 'Activité mystère' : feedback.title,
      open: feedback.feedbackOpen,
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
  const session = await publishedSession(req.params.id);
  requireThat(session.voteOpen, 409, 'Le vote est fermé.');
  const activity = (await listedActivities(session)).find((item) => item.id === req.body?.activityId);
  const option = activity?.options.find((item) => item.id === req.body?.optionId);
  requireThat(option, 400, 'Choisissez une activité et une réponse valides.');
  const result = await pool.query(`
    INSERT INTO votes (sessionid, participant, activityid, optionid, optionlabel)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (sessionid, participant) DO NOTHING
  `, [session.id, 'student:' + req.student.id, activity.id, option.id, option.label]);
  requireThat(result.rowCount > 0, 409, 'Votre vote a déjà été enregistré.');
  res.status(201).json({ ok: true });
});

api.post('/sessions/:id/feedback', auth.requireStudent, async (req, res) => {
  const session = await publishedSession(req.params.id);
  requireThat(session.feedbackOpen, 409, 'La collecte des avis est fermée.');
  const rating = req.body?.rating;
  const comment = readText(req.body?.comment, 'le commentaire', 1200, false);
  requireThat(Number.isInteger(rating) && rating >= 1 && rating <= 5, 400, 'Choisissez une note de 1 à 5.');
  const result = await pool.query(`
    INSERT INTO feedback (id, sessionid, participant, rating, comment, createdat)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (sessionid, participant) DO NOTHING
  `, [randomUUID(), session.id, 'student:' + req.student.id, rating, comment, new Date().toISOString()]);
  requireThat(result.rowCount > 0, 409, 'Votre avis a déjà été enregistré.');
  res.status(201).json({ ok: true });
});

api.post('/sessions/:id/guess', auth.requireStudent, async (req, res) => {
  const session = await publishedSession(req.params.id);
  requireThat(session.announcement?.mode === 'surprise'
    && !announcementIsRevealed(session.announcement), 409, 'Les propositions sont fermées.');
  const activityId = req.body?.activityId;
  requireThat((await allowedGuesses()).some((activity) => activity.id === activityId),
    400, 'Choisissez une activité proposée.');
  const result = await pool.query(`
    INSERT INTO guesses (sessionid, participant, activityid)
    VALUES ($1, $2, $3)
    ON CONFLICT (sessionid, participant) DO NOTHING
  `, [session.id, 'student:' + req.student.id, activityId]);
  requireThat(result.rowCount > 0, 409, 'Votre proposition a déjà été enregistrée.');
  res.status(201).json({ ok: true });
});

async function resultsFor(session) {
  const groupedResult = await pool.query(`
    SELECT activityid, optionid, MIN(optionlabel) AS optionlabel, COUNT(*)::int AS count
    FROM votes
    WHERE sessionid = $1
    GROUP BY activityid, optionid
  `, [session.id]);
  const grouped = groupedResult.rows;
  const ids = [...new Set([...session.activityIds, ...grouped.map((vote) => vote.activityid)])];
  const activityResult = ids.length
    ? await pool.query('SELECT * FROM activities WHERE id = ANY($1::text[])', [ids])
    : { rows: [] };
  const activityById = new Map(activityResult.rows.map((row) => [row.id, activityFromRow(row)]));

  const votes = ids.map((activityId) => {
    const activity = activityById.get(activityId);
    if (!activity) return null;
    const options = new Map(activity.options.map(({ id, label }) => [id, { id, label, count: 0 }]));
    let count = 0;
    for (const vote of grouped.filter((row) => row.activityid === activityId)) {
      const label = options.get(vote.optionid)?.label || vote.optionlabel;
      options.set(vote.optionid, { id: vote.optionid, label, count: Number(vote.count) });
      count += Number(vote.count);
    }
    return { activityId, name: activity.name, count, options: [...options.values()] };
  }).filter(Boolean);

  const [feedbackResult, guessesResult] = await Promise.all([
    pool.query(`
      SELECT id, rating, comment, createdat, hidden
      FROM feedback WHERE sessionid = $1 ORDER BY createdat DESC
    `, [session.id]),
    pool.query('SELECT COUNT(*)::int AS count FROM guesses WHERE sessionid = $1', [session.id]),
  ]);
  const feedback = feedbackResult.rows.map((item) => ({
    id: item.id,
    rating: item.rating,
    comment: item.comment,
    createdAt: item.createdat,
    hidden: Boolean(item.hidden),
  }));
  const guesses = Number(guessesResult.rows[0].count);
  return { votes, feedback, guesses };
}

api.get('/admin/sessions/:id/results', async (req, res) => {
  res.json(await resultsFor(await sessionOr404(req.params.id)));
});

api.put('/admin/sessions/:id/feedback/:feedbackId', auth.requireAdmin('moderate'), async (req, res) => {
  const hidden = readBoolean(req.body?.hidden, 'La visibilité', undefined);
  requireThat(hidden !== undefined, 400, 'Choisissez de masquer ou de rétablir l’avis.');
  const result = await pool.query(
    'UPDATE feedback SET hidden = $1 WHERE sessionid = $2 AND id = $3',
    [Number(hidden), req.params.id, req.params.feedbackId],
  );
  requireThat(result.rowCount > 0, 404, 'Avis introuvable.');
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
      throw new RequestError(400,
        'Indiquez une origine HTTP(S) sans chemin, par exemple https://activites.example.org.');
    }
  }
  requireThat(baseUrl, 400, 'Indiquez une adresse publique pour créer le QR code.');
  const url = new URL('/', baseUrl);
  url.search = new URLSearchParams({ vue: kind, seance: session.id }).toString();
  const png = await QRCode.toBuffer(url.href, {
    type: 'png', width: 800, margin: 3, errorCorrectionLevel: 'M',
  });
  res.attachment(`gasa-${kind}-${session.id}.png`).send(png);
});

const timeFormat = new Intl.DateTimeFormat('fr-BJ', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Africa/Porto-Novo',
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
    const activity = await findActivity(activityId);
    rows.push(['Activité retenue', activity?.name || ''], ['Date', timeFormat.format(new Date(date))], ['Lieu', location]);
  }
  return rows;
}

async function exportExcel(session, results) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'UATM GASA';
  exportSheet(workbook, 'Synthèse', [['Indicateur', 29], ['Valeur', 50]], await summaries(session, results));
  exportSheet(workbook, 'Activités', [['Activité', 34], ['Votes', 14]],
    results.votes.map((activity) => [activity.name, activity.count]));
  exportSheet(workbook, 'Réponses', [['Activité', 34], ['Réponse', 56], ['Votes', 14]],
    results.votes.flatMap((activity) => activity.options.map((option) => [activity.name, option.label, option.count])));
  exportSheet(workbook, 'Avis', [['Date', 22], ['Note sur 5', 14], ['Commentaire', 74], ['Statut', 15]],
    results.feedback.map((item) => [timeFormat.format(new Date(item.createdAt)), item.rating,
      item.comment, item.hidden ? 'Masqué' : 'Visible']));
  return workbook.xlsx.writeBuffer();
}

function reportText(text, heading) {
  return new Paragraph({ text, heading, spacing: { after: 110 } });
}

async function exportWord(session, results) {
  const paragraphs = [
    reportText(session.title, HeadingLevel.TITLE),
    reportText('Bilan de la vie étudiante · UATM GASA'),
  ];
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
    paragraphs.push(reportText(
      `${item.rating}/5 · ${timeFormat.format(new Date(item.createdAt))}${status}`,
      HeadingLevel.HEADING_2,
    ));
    if (item.comment) {
      for (const line of item.comment.split(/\r?\n/)) paragraphs.push(reportText(line));
    }
  }
  return Packer.toBuffer(new Document({
    creator: 'UATM GASA',
    title: session.title,
    sections: [{ children: paragraphs }],
  }));
}

api.get('/admin/sessions/:id/export/:format', auth.requireAdmin('export'), async (req, res) => {
  const session = await sessionOr404(req.params.id);
  const { format } = req.params;
  requireThat(['xlsx', 'docx'].includes(format), 404, 'Format d’export introuvable.');
  const results = await resultsFor(session);
  const report = format === 'xlsx'
    ? await exportExcel(session, results)
    : await exportWord(session, results);
  res.attachment(`gasa-bilan-${session.id}.${format}`).send(Buffer.from(report));
});

api.use((_req, res) => {
  res.status(404).json({ error: 'Ressource introuvable.' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/service-worker.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(resolve(root, 'service-worker.js'));
});
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').sendFile(resolve(root, 'manifest.webmanifest'));
});
app.use('/images', express.static(resolve(root, 'images')));
app.use('/videos', express.static(resolve(root, 'videos')));
app.get(['/', '/index.html'], (_req, res) =>
  res.sendFile(resolve(root, 'index.html'))
);
app.get(['/admin', '/admin.html'], (_req, res) => res.sendFile(resolve(root, 'admin.html')));
for (const file of [
  'style.css', 'student-themes.css', 'student-polls.css', 'script.js',
  'student-interface.js', 'admin.css', 'admin.js',
]) {
  app.get(`/${file}`, (_req, res) => res.sendFile(resolve(root, file)));
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof RequestError || error instanceof AccountError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Le contenu est trop volumineux.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Le formulaire est invalide.' });
  if (error.status === 404) return res.status(404).json({ error: 'Ressource introuvable.' });
  console.error(`${req.method} ${req.path}`, error);
  return res.status(500).json({ error: 'Une erreur est survenue. Réessayez dans un instant.' });
});

const server = app.listen(port, host, () => {
  console.log(`GASA Activités · http://${host}:${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    push.stop();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
