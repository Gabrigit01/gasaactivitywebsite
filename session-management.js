const phases = new Set(['upcoming', 'current', 'past']);
const portoNovoOffset = 60 * 60 * 1000;

export async function installSessionFields(db) {
  await db.transaction(async () => {
    const columns = db.dialect === 'postgres'
      ? await db.prepare(`SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name=?`).all('sessions')
      : await db.prepare('PRAGMA table_info(sessions)').all();
    const names = new Set(columns.map(column => column.name));
    if (!names.has('phase')) await db.exec('ALTER TABLE sessions ADD COLUMN phase TEXT');
    if (!names.has('activity_id')) {
      await db.exec('ALTER TABLE sessions ADD COLUMN activity_id TEXT REFERENCES activities(id)');
    }
  });
}

function localDay(timestamp) {
  const date = new Date(timestamp + portoNovoOffset);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function sessionPhase(session, now = Date.now()) {
  if (session?.status === 'archived' || session?.archived === true) return 'past';
  if (phases.has(session?.phase)) return session.phase;
  let announcement = session?.announcement;
  if (typeof announcement === 'string') {
    try { announcement = JSON.parse(announcement); } catch { announcement = null; }
  }
  const timestamp = typeof announcement?.date === 'string' ? Date.parse(announcement.date) : NaN;
  const announcedDay = Number.isFinite(timestamp) ? localDay(timestamp) : null;
  const today = Number.isFinite(now) ? localDay(now) : null;
  if (announcedDay && today) {
    if (announcedDay > today) return 'upcoming';
    if (announcedDay < today) return 'past';
    return 'current';
  }
  if (session?.feedbackOpen && !session?.voteOpen) return 'past';
  if (session?.status === 'draft' || session?.voteOpen) return 'upcoming';
  return 'current';
}
