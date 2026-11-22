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
const normalized = value => value.replaceAll('_', '').toLowerCase();

// Older PostgreSQL imports used unquoted or snake_case names. Rename in place:
// PostgreSQL updates dependent foreign keys and indexes without copying records.
export async function migratePostgresSchema(db) {
  if (db.dialect !== 'postgres') return;
  await db.transaction(async () => {
    await db.exec('SELECT pg_advisory_xact_lock(194135, 2)');
    const columns = await db.prepare(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
    `).all();
    const tables = new Map();
    for (const { table_name, column_name } of columns) {
      if (!tables.has(table_name)) tables.set(table_name, new Set());
      tables.get(table_name).add(column_name);
    }
    const renames = [];
    for (const [table, expected] of Object.entries(legacyColumns)) {
      const present = tables.get(table);
      if (!present) continue;
      for (const target of expected) {
        const aliases = [...present].filter(name => normalized(name) === normalized(target));
        if (aliases.length > 1) {
          throw new Error(`Migration interrompue : colonnes ambiguës pour ${table}.${target} (${aliases.join(', ')}). Aucune donnée modifiée.`);
        }
        if (!aliases.length) {
          throw new Error(`Structure PostgreSQL incompatible : ${table}.${target} introuvable. Colonnes présentes : ${[...present].join(', ')}. Aucune donnée modifiée.`);
        }
        if (aliases[0] !== target) renames.push({ table, source: aliases[0], target });
      }
    }
    for (const { table, source, target } of renames) {
      await db.exec(`ALTER TABLE ${identifier(table)} RENAME COLUMN ${identifier(source)} TO ${identifier(target)}`);
    }
    for (const table of ['activities', 'sessions']) {
      if (tables.has(table) && !tables.get(table).has('sort_order')) {
        await db.exec(`ALTER TABLE ${identifier(table)} ADD COLUMN sort_order BIGSERIAL`);
      }
    }
  });
}
