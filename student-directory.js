import { randomUUID } from 'node:crypto';

export class DirectoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const need = (condition, message, status = 400) => {
  if (!condition) throw new DirectoryError(status, message);
};
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const years = [1, 2, 3];
const initialPrograms = [
  ['ge-si', 'GE/SI'], ['ge-sil', 'GE/SIL'], ['ge-rit', 'GE/RIT'], ['ge-ascii', 'GE/ASCII'],
];

function readName(value, label, maximum, required = true) {
  need(typeof value === 'string', `Renseignez ${label}.`);
  need(!controlCharacters.test(value), `${label} contient des caractères non autorisés.`);
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  need(!required || name.length > 0, `Renseignez ${label}.`);
  need(name.length <= maximum, `${label} ne doit pas dépasser ${maximum} caractères.`);
  return name;
}

const normalized = name => name.toLocaleLowerCase('fr');
const publicProgram = row => ({ id: row.id, name: row.name, archived: Boolean(row.archived) });
const emptyProfile = () => ({
  programId: null, programName: null, studyYear: null, programArchived: null,
  updatedAt: null, firstName: null, lastName: null,
});

export async function installDirectory({ api, db, auth, mutate, record = async () => {} }) {
  const write = mutate || (work => db.transaction(work));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_settings (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS study_programs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS academic_profiles (
      student_id TEXT PRIMARY KEY REFERENCES student_accounts(id),
      program_id TEXT NOT NULL REFERENCES study_programs(id),
      study_year INTEGER NOT NULL CHECK (study_year BETWEEN 1 AND 3),
      first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS academic_profiles_program ON academic_profiles(program_id);
  `);
  // The marker makes the initial catalog a migration, rather than a reset on restart.
  await write(async () => {
    await db.prepare("INSERT INTO schema_settings (name,value) VALUES ('study-programs',0) ON CONFLICT (name) DO NOTHING").run();
    const marker = await db.prepare("SELECT value FROM schema_settings WHERE name='study-programs'"
      + (db.dialect === 'postgres' ? ' FOR UPDATE' : '')).get();
    if (marker.value === 1) return;
    const createdAt = new Date().toISOString();
    for (const [id, name] of initialPrograms) {
      await db.prepare(`INSERT INTO study_programs (id,name,normalized_name,archived,created_at)
        VALUES (?,?,?,0,?) ON CONFLICT DO NOTHING`).run(id, name, normalized(name), createdAt);
    }
    await db.prepare("UPDATE schema_settings SET value=1 WHERE name='study-programs'").run();
  });

  async function readAcademicProfile(studentId) {
    const row = await db.prepare(`SELECT p.program_id,program.name AS program_name,p.study_year,
      program.archived,p.updated_at,p.first_name,p.last_name
      FROM academic_profiles p JOIN study_programs program ON program.id=p.program_id
      WHERE p.student_id=?`).get(studentId);
    return row ? {
      programId: row.program_id, programName: row.program_name, studyYear: row.study_year,
      programArchived: Boolean(row.archived), updatedAt: row.updated_at,
      firstName: row.first_name, lastName: row.last_name,
    } : emptyProfile();
  }

  async function saveAcademicProfile(studentId, body, student) {
    need(body && typeof body === 'object' && !Array.isArray(body), 'Renseignez votre filière et votre année.');
    return write(async () => {
      const previous = await readAcademicProfile(studentId);
      const programId = has(body, 'programId') ? body.programId : previous.programId;
      const studyYear = has(body, 'studyYear') ? body.studyYear : previous.studyYear;
      need(typeof programId === 'string' && programId.length > 0 && programId.length <= 80,
        'Choisissez une filière.');
      need(typeof studyYear === 'number' && Number.isInteger(studyYear) && years.includes(studyYear),
        'Choisissez une année d’étude entre 1 et 3.');
      const program = await db.prepare('SELECT * FROM study_programs WHERE id=?').get(programId);
      need(program, 'Cette filière est introuvable.', 400);
      need(!program.archived || previous.programId === programId,
        'Cette filière est archivée. Choisissez une filière disponible.', 409);
      const firstName = has(body, 'firstName') ? readName(body.firstName, 'le prénom', 100, false) : previous.firstName || '';
      const lastName = has(body, 'lastName') ? readName(body.lastName, 'le nom', 100, false) : previous.lastName || '';
      if (previous.programId === programId && previous.studyYear === studyYear
        && previous.firstName === firstName && previous.lastName === lastName) return previous;
      const account = student || await db.prepare('SELECT id,name,email FROM student_accounts WHERE id=?').get(studentId);
      need(account?.id === studentId, 'Ce compte étudiant est introuvable.', 404);
      const updatedAt = new Date().toISOString();
      await db.prepare(`INSERT INTO academic_profiles
        (student_id,program_id,study_year,first_name,last_name,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT (student_id) DO UPDATE SET program_id=excluded.program_id,study_year=excluded.study_year,
        first_name=excluded.first_name,last_name=excluded.last_name,updated_at=excluded.updated_at`)
        .run(studentId, programId, studyYear, firstName, lastName, updatedAt);
      await record({ kind: 'student.academic-update', student: account,
        detail: `${program.name} · ${studyYear}e année`, createdAt: updatedAt });
      return readAcademicProfile(studentId);
    });
  }

  async function uniqueName(name, excludingId) {
    const existing = await db.prepare('SELECT id FROM study_programs WHERE normalized_name=?').get(normalized(name));
    need(!existing || existing.id === excludingId, 'Une filière porte déjà ce nom.', 409);
  }

  async function programWrite(work) {
    try { return await write(work); } catch (error) {
      if (error.code === '23505' || error.errcode === 2067) {
        throw new DirectoryError(409, 'Une filière porte déjà ce nom.');
      }
      throw error;
    }
  }

  api.get('/programs', async (req, res) => {
    const programs = await db.prepare('SELECT id,name,archived FROM study_programs WHERE archived=0 ORDER BY name,id').all();
    res.json({ programs: programs.map(publicProgram), years });
  });

  api.get('/admin/programs', auth.requireAdmin('read'), async (req, res) => {
    const programs = await db.prepare(`SELECT program.id,program.name,program.archived,COUNT(profile.student_id) AS student_count
      FROM study_programs program LEFT JOIN academic_profiles profile ON profile.program_id=program.id
      GROUP BY program.id,program.name,program.archived ORDER BY program.name,program.id`).all();
    res.json({ programs: programs.map(row => ({ ...publicProgram(row), studentCount: Number(row.student_count) })) });
  });

  api.post('/admin/programs', auth.requireAdmin('edit'), async (req, res) => {
    const program = await programWrite(async () => {
      const name = readName(req.body?.name, 'le nom de la filière', 120);
      await uniqueName(name);
      const value = { id: randomUUID(), name, archived: false };
      await db.prepare('INSERT INTO study_programs (id,name,normalized_name,archived,created_at) VALUES (?,?,?,0,?)')
        .run(value.id, name, normalized(name), new Date().toISOString());
      await record({ kind: 'admin.program-create', admin: req.admin, detail: name });
      return value;
    });
    res.status(201).json(program);
  });

  api.put('/admin/programs/:id', auth.requireAdmin('edit'), async (req, res) => {
    const program = await programWrite(async () => {
      need(req.body && typeof req.body === 'object' && !Array.isArray(req.body), 'Modification de filière invalide.');
      const previous = await db.prepare('SELECT * FROM study_programs WHERE id=?').get(req.params.id);
      need(previous, 'Cette filière est introuvable.', 404);
      const name = has(req.body, 'name') ? readName(req.body.name, 'le nom de la filière', 120) : previous.name;
      let archived = Boolean(previous.archived);
      if (has(req.body, 'archived')) {
        need(typeof req.body.archived === 'boolean', 'Précisez si la filière est archivée.');
        need(req.admin.capabilities.includes('archive'), 'Cette action est réservée au responsable du comité.', 403);
        archived = req.body.archived;
      }
      await uniqueName(name, previous.id);
      if (previous.name !== name || Boolean(previous.archived) !== archived) {
        await db.prepare('UPDATE study_programs SET name=?,normalized_name=?,archived=? WHERE id=?')
          .run(name, normalized(name), Number(archived), previous.id);
        await record({ kind: 'admin.program-update', admin: req.admin, detail: name });
      }
      return { id: previous.id, name, archived };
    });
    res.json(program);
  });

  api.get('/student/academic-profile', auth.requireStudent, async (req, res) => {
    res.json(await readAcademicProfile(req.student.id));
  });
  api.put('/student/academic-profile', auth.requireStudent, async (req, res) => {
    res.json(await saveAcademicProfile(req.student.id, req.body, req.student));
  });

  return { saveAcademicProfile, readAcademicProfile };
}
