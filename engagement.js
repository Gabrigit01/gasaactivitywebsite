import { randomUUID } from 'node:crypto';
import express from 'express';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import sharp from 'sharp';

export class EngagementError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (condition, message, status = 400) => { if (!condition) throw new EngagementError(status, message); };
const text = (value, maximum = 300) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const frequencies = [{ value: 'weekly', label: 'Chaque semaine' }, { value: 'fortnightly', label: 'Toutes les deux semaines' }];
const weekdays = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'].map((label, index) => ({
  value: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][index], label,
}));

async function addColumn(db, table, name, definition) {
  const columns = db.dialect === 'postgres'
    ? await db.prepare('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?').all(table)
    : await db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!columns.some(column => column.name === name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function surveyFromRow(row) {
  return row ? { id: row.id, title: row.title, question: row.question, description: row.description,
    status: row.status, collectBirthdate: Boolean(row.collect_birthdate), birthdatePurpose: row.birthdate_purpose,
    updatedAt: row.updated_at, frequencies, weekdays } : null;
}

export async function installEngagement({ app, api, db, auth, mutate }) {
  const write = mutate || (work => db.transaction(work));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS priority_surveys (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, question TEXT NOT NULL, description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','active','paused','closed')),
      collect_birthdate INTEGER NOT NULL DEFAULT 0, birthdate_purpose TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS priority_responses (
      id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES priority_surveys(id),
      student_id TEXT NOT NULL REFERENCES student_accounts(id), frequency TEXT NOT NULL,
      weekday TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(survey_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS student_profiles (
      student_id TEXT PRIMARY KEY REFERENCES student_accounts(id), birthdate TEXT NOT NULL,
      birthdate_purpose TEXT NOT NULL, consented_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_actions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, student_id TEXT REFERENCES student_accounts(id) ON DELETE SET NULL,
      actor_name TEXT NOT NULL, actor_email TEXT NOT NULL, actor_type TEXT NOT NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, session_title TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS user_actions_date ON user_actions(created_at);
    CREATE INDEX IF NOT EXISTS user_actions_student ON user_actions(student_id);
    CREATE TABLE IF NOT EXISTS media_images (
      id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL
    );
  `);
  await addColumn(db, 'votes', 'created_at', 'TEXT');
  await addColumn(db, 'guesses', 'created_at', 'TEXT');

  await write(async () => {
    if (!await db.prepare('SELECT id FROM priority_surveys LIMIT 1').get()) {
      await db.prepare(`INSERT INTO priority_surveys
        (id,title,question,description,status,collect_birthdate,birthdate_purpose,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run('rythme-des-activites', 'Organisons nos prochaines activités',
          'À quelle fréquence souhaitez-vous nos activités ?',
          'Votre rythme, votre jour. Aidez le comité à préparer les prochaines séances.',
          'active', 0, '', new Date().toISOString());
    }
  });

  async function record({ id = randomUUID(), kind, student, admin, session, detail = '', createdAt = new Date().toISOString() }) {
    await db.prepare(`INSERT INTO user_actions
      (id,kind,student_id,actor_name,actor_email,actor_type,session_id,session_title,detail,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`)
      .run(id, kind, student?.id || null, student?.name || admin?.username || 'Participant historique',
        student?.email || '', admin ? 'admin' : 'student', session?.id || null, session?.title || '', detail, createdAt);
  }

  // Preserve historic participation without inventing an author or timestamp.
  await write(async () => {
    const marker = await db.prepare("SELECT value FROM schema_settings WHERE name = 'actions-history'").get();
    if (marker) return;
    for (const table of ['votes', 'feedback', 'guesses']) {
      const rows = await db.prepare(`SELECT entry.*, s.title AS session_title,
        person.id AS student_id, person.name AS student_name, person.email AS student_email
        FROM ${table} AS entry JOIN sessions s ON s.id = entry.sessionId
        LEFT JOIN student_accounts person ON entry.participant = 'student:' || person.id`).all();
      for (const row of rows) {
        const kind = { votes: 'vote', feedback: 'feedback', guesses: 'guess' }[table];
        await record({ id: `historique-${table}-${row.sessionId}-${row.participant}`, kind,
          student: row.student_id ? { id: row.student_id, name: row.student_name, email: row.student_email } : null,
          session: { id: row.sessionId, title: row.session_title },
          detail: table === 'feedback' ? `${row.rating}/5 · ${row.comment}` : row.optionLabel || row.activityId,
          createdAt: table === 'feedback' ? row.createdAt : row.created_at || null });
      }
    }
    await db.prepare("INSERT INTO schema_settings (name,value) VALUES ('actions-history',1) ON CONFLICT (name) DO NOTHING").run();
  });

  const current = async () => surveyFromRow(await db.prepare('SELECT * FROM priority_surveys ORDER BY updated_at DESC, id DESC LIMIT 1').get());
  const canTrace = req => req.admin?.capabilities.includes('trace');
  const canBirthdate = req => req.admin?.role === 'owner';

  function validateBirthdate(survey, body) {
    const { birthdate, birthdateConsent, birthdatePurpose } = body;
    need(survey.collectBirthdate && birthdatePurpose === survey.birthdatePurpose,
      'L’utilisation de la date de naissance a changé. Relisez la nouvelle explication avant de donner votre accord.', 409);
    need(survey.birthdatePurpose && birthdateConsent === true,
      'La date de naissance nécessite votre accord et une finalité précisée par le comité.');
    need(typeof birthdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(birthdate), 'Indiquez une date de naissance valide.');
    const date = new Date(birthdate + 'T00:00:00.000Z');
    need(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === birthdate
      && birthdate >= '1900-01-01' && date.getTime() <= Date.now(), 'Indiquez une date de naissance valide.');
  }

  async function storeBirthdate(survey, student, birthdate, createdAt) {
    await db.prepare(`INSERT INTO student_profiles (student_id,birthdate,birthdate_purpose,consented_at) VALUES (?,?,?,?)
      ON CONFLICT (student_id) DO UPDATE SET birthdate=excluded.birthdate,
      birthdate_purpose=excluded.birthdate_purpose,consented_at=excluded.consented_at`)
      .run(student.id, birthdate, survey.birthdatePurpose, createdAt);
    await record({ kind: 'student.birthdate-share', student, detail: survey.birthdatePurpose, createdAt });
  }

  api.get('/priority-survey', async (req, res) => {
    const survey = await current();
    const student = await auth.student(req, res);
    const response = student && survey ? await db.prepare(`SELECT frequency,weekday,created_at AS createdAt
      FROM priority_responses WHERE survey_id = ? AND student_id = ?`).get(survey.id, student.id) : null;
    const profile = student && survey ? await db.prepare('SELECT birthdate_purpose FROM student_profiles WHERE student_id=?').get(student.id) : null;
    res.json({ survey, responded: Boolean(response), response: response || null,
      birthdateProvided: Boolean(profile && profile.birthdate_purpose === survey.birthdatePurpose) });
  });

  api.post('/priority-survey/responses', auth.requireStudent, async (req, res) => {
    await write(async () => {
      const survey = await current();
      need(survey?.status === 'active', 'Ce sondage est actuellement fermé.', 409);
      need(req.body?.surveyId === survey.id, 'Le sondage a changé. Actualisez la page.', 409);
      const { frequency, weekday, birthdate } = req.body;
      need(frequencies.some(item => item.value === frequency), 'Choisissez une fréquence.');
      need(weekdays.some(item => item.value === weekday), 'Choisissez un jour de la semaine.');
      if (birthdate) {
        validateBirthdate(survey, req.body);
      }
      const createdAt = new Date().toISOString();
      const result = await db.prepare(`INSERT INTO priority_responses (id,survey_id,student_id,frequency,weekday,created_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT (survey_id,student_id) DO NOTHING`)
        .run(randomUUID(), survey.id, req.student.id, frequency, weekday, createdAt);
      need(result.changes > 0, 'Votre participation à ce sondage est déjà enregistrée.', 409);
      if (birthdate) {
        await storeBirthdate(survey, req.student, birthdate, createdAt);
      }
      await record({ kind: 'priority-survey', student: req.student,
        detail: `${frequencies.find(item => item.value === frequency).label} · ${weekdays.find(item => item.value === weekday).label}`, createdAt });
    });
    res.status(201).json({ ok: true });
  });

  api.post('/priority-survey/birthdate', auth.requireStudent, async (req, res) => {
    await write(async () => {
      const survey = await current();
      need(survey?.status === 'active', 'Ce sondage est actuellement fermé.', 409);
      need(req.body?.surveyId === survey.id, 'Le sondage a changé. Actualisez la page.', 409);
      need(await db.prepare('SELECT 1 FROM priority_responses WHERE survey_id=? AND student_id=?').get(survey.id, req.student.id),
        'Répondez d’abord au sondage de fréquence.', 409);
      validateBirthdate(survey, req.body);
      await storeBirthdate(survey, req.student, req.body.birthdate, new Date().toISOString());
    });
    res.status(201).json({ ok: true });
  });

  api.get('/admin/priority-survey', auth.requireAdmin('read'), async (req, res) => res.json(await current()));
  api.put('/admin/priority-survey', auth.requireAdmin('edit'), async (req, res) => {
    const survey = await write(async () => {
      const previous = await current();
      const value = { ...previous, ...req.body };
      need(['draft', 'active', 'paused', 'closed'].includes(value.status), 'État du sondage invalide.');
      need(typeof value.collectBirthdate === 'boolean', 'Précisez si la date de naissance est demandée.');
      const title = text(value.title, 120), question = text(value.question, 180), purpose = text(value.birthdatePurpose, 500);
      need(title && question, 'Renseignez le titre et la question du sondage.');
      need(!value.collectBirthdate || purpose.length >= 12, 'Expliquez précisément l’utilisation de la date de naissance avant d’activer sa collecte.');
      await db.prepare(`UPDATE priority_surveys SET title=?,question=?,description=?,status=?,collect_birthdate=?,birthdate_purpose=?,updated_at=? WHERE id=?`)
        .run(title, question, text(value.description, 500), value.status, Number(value.collectBirthdate), purpose, new Date().toISOString(), previous.id);
      await record({ kind: 'admin.survey-update', admin: req.admin, detail: `${title} · ${value.status}` });
      return current();
    });
    res.json(survey);
  });

  async function surveyResults(req, all = false) {
    const survey = await current();
    const counts = await db.prepare('SELECT frequency,weekday,COUNT(*) AS count FROM priority_responses WHERE survey_id=? GROUP BY frequency,weekday').all(survey.id);
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const responses = canTrace(req) ? await db.prepare(`SELECT r.id,r.student_id AS studentId,p.name,p.email,r.frequency,r.weekday,r.created_at AS createdAt
      ${canBirthdate(req) ? ', profile.birthdate, profile.birthdate_purpose AS birthdatePurpose, profile.consented_at AS consentedAt' : ''}
      FROM priority_responses r JOIN student_accounts p ON p.id=r.student_id
      ${canBirthdate(req) ? 'LEFT JOIN student_profiles profile ON profile.student_id=p.id' : ''}
      WHERE r.survey_id=? ORDER BY r.created_at DESC ${all ? '' : 'LIMIT 250'}`).all(survey.id) : [];
    return { survey, total, frequency: frequencies.map(item => ({ ...item, count: counts.filter(row => row.frequency === item.value).reduce((sum, row) => sum + row.count, 0) })),
      weekdays: weekdays.map(item => ({ ...item, count: counts.filter(row => row.weekday === item.value).reduce((sum, row) => sum + row.count, 0) })), responses };
  }
  api.get('/admin/priority-survey/results', auth.requireAdmin('read'), async (req, res) => res.json(await surveyResults(req)));
  api.get('/admin/priority-survey/export/:format', auth.requireAdmin('export'), async (req, res) => {
    const { format } = req.params;
    need(['xlsx', 'docx'].includes(format), 'Format introuvable.', 404);
    const result = await surveyResults(req, true);
    const rows = result.responses.map(row => [row.name, row.email, frequencies.find(item => item.value === row.frequency)?.label,
      weekdays.find(item => item.value === row.weekday)?.label, row.createdAt, row.birthdate || '', row.birthdatePurpose || '', row.consentedAt || '']);
    if (format === 'xlsx') {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Fréquence des activités');
      sheet.addRow(['Nom', 'E-mail', 'Fréquence', 'Jour', 'Date de réponse', 'Naissance (facultatif)', 'Utilisation annoncée', 'Accord donné le']);
      sheet.addRows(rows);
      sheet.getRow(1).font = { bold: true };
      sheet.columns.forEach(column => { column.width = 27; });
      res.attachment('gasa-sondage-frequence.xlsx').send(Buffer.from(await book.xlsx.writeBuffer()));
    } else {
      const paragraphs = [new Paragraph({ text: result.survey.title, heading: HeadingLevel.TITLE }), new Paragraph(`${result.total} participation(s)`)];
      for (const row of rows) paragraphs.push(new Paragraph(row.filter(Boolean).join(' · ')));
      res.attachment('gasa-sondage-frequence.docx').send(await Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] })));
    }
  });

  function pageInput(req) {
    return { page: Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1)), pageSize: 40, q: text(req.query.q, 150).toLowerCase() };
  }
  api.get('/admin/trace', auth.requireAdmin('trace'), async (req, res) => {
    const { page, pageSize, q } = pageInput(req);
    const conditions = [], values = [];
    if (q) { conditions.push('(LOWER(actor_name) LIKE ? OR LOWER(actor_email) LIKE ? OR LOWER(detail) LIKE ?)'); values.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    if (req.query.kind) { conditions.push('kind=?'); values.push(text(req.query.kind, 80)); }
    if (req.query.sessionId) { conditions.push('session_id=?'); values.push(text(req.query.sessionId, 80)); }
    for (const [key, operator] of [['from', '>='], ['to', '<=']]) {
      if (req.query[key]) {
        const date = String(req.query[key]);
        need(/^\d{4}-\d{2}-\d{2}$/.test(date), 'Période invalide.');
        conditions.push('created_at ' + operator + ' ?'); values.push(date + (key === 'from' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'));
      }
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = (await db.prepare('SELECT COUNT(*) AS count FROM user_actions' + where).get(...values)).count;
    const items = await db.prepare(`SELECT id,kind,student_id AS studentId,actor_name AS name,actor_email AS email,
      actor_type AS actorType,session_id AS sessionId,session_title AS sessionTitle,detail,created_at AS createdAt
      FROM user_actions ${where} ORDER BY CASE WHEN created_at IS NULL THEN 1 ELSE 0 END,created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize);
    res.json({ items, total, page, pageSize });
  });
  api.get('/admin/students', auth.requireAdmin('trace'), async (req, res) => {
    const { page, pageSize, q } = pageInput(req);
    const where = q ? ' WHERE LOWER(s.name) LIKE ? OR LOWER(s.email) LIKE ?' : '';
    const values = q ? ['%' + q + '%', '%' + q + '%'] : [];
    const total = (await db.prepare('SELECT COUNT(*) AS count FROM student_accounts s' + where).get(...values)).count;
    const items = await db.prepare(`SELECT s.id,s.name,s.email,s.created_at AS createdAt
      ${canBirthdate(req) ? ',p.birthdate,p.birthdate_purpose AS birthdatePurpose,p.consented_at AS consentedAt' : ''}
      FROM student_accounts s ${canBirthdate(req) ? 'LEFT JOIN student_profiles p ON p.student_id=s.id' : ''}
      ${where} ORDER BY s.name,s.id LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
    res.json({ items, total, page, pageSize });
  });

  let processingImage = false;
  api.post('/admin/uploads/images', auth.requireAdmin('edit'), express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), async (req, res) => {
    const bytes = req.body;
    need(Buffer.isBuffer(bytes) && bytes.length > 12, 'Choisissez une image JPEG, PNG ou WebP de moins de 5 Mo.');
    let mime;
    if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) mime = 'image/jpeg';
    else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
    else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
    need(mime && req.is(mime), 'Le contenu du fichier ne correspond pas à une image autorisée.');
    if (processingImage) {
      res.set('Retry-After', '2');
      throw new EngagementError(429, 'Une image est en cours de traitement. Réessayez dans quelques secondes.');
    }
    processingImage = true;
    let normalized;
    try {
      normalized = await sharp(bytes, { limitInputPixels: 24_000_000, failOn: 'warning' })
        .rotate().resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
    } catch { throw new EngagementError(400, 'Cette image est invalide ou trop grande. Choisissez une autre image.'); }
    finally { processingImage = false; }
    const id = randomUUID();
    await write(async () => {
      await db.prepare('INSERT INTO media_images (id,mime_type,content,created_at) VALUES (?,?,?,?)').run(id, 'image/webp', normalized, new Date().toISOString());
      await record({ kind: 'admin.image-upload', admin: req.admin, detail: `Image optimisée · ${normalized.length} octets` });
    });
    res.status(201).json({ url: '/media/images/' + id });
  });
  app.get('/media/images/:id', async (req, res, next) => {
    try {
      if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.sendStatus(404);
      const row = await db.prepare('SELECT content,mime_type FROM media_images WHERE id=?').get(req.params.id);
      if (!row) return res.sendStatus(404);
      res.set('Cache-Control', 'public, max-age=31536000, immutable').type(row.mime_type).send(Buffer.from(row.content));
    } catch (error) { next(error); }
  });

  return { record, current, async recordAccountEvent(event) {
    const kind = event.kind;
    const student = event.student || (event.studentId ? { id: event.studentId, name: event.name || '', email: event.email || '' } : null);
    await record({ kind, student, detail: { 'student.register': 'Inscription', 'student.login': 'Connexion',
      'student.logout': 'Déconnexion', 'student.password-reset': 'Mot de passe réinitialisé',
      'student.password-change': 'Mot de passe modifié' }[kind] || kind });
  } };
}
