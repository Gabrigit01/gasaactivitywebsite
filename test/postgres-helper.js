import { PGlite } from '@electric-sql/pglite';
import { postgresDatabase } from '../database.js';

// Runs actual PostgreSQL SQL locally, without using a hosted account or credentials.
export async function localPostgres() {
  const engine = await PGlite.create({ parsers: { 20: value => Number(value) } });
  let queue = Promise.resolve();
  const acquire = async () => {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  };
  const execute = async (sql, values) => {
    const result = values?.length ? await engine.query(sql, values) : (await engine.exec(sql)).at(-1);
    return { rows: result.rows, rowCount: result.affectedRows || 0 };
  };
  const pool = {
    async query(sql, values) {
      const release = await acquire();
      try { return await execute(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await acquire();
      return { query: execute, release };
    },
    end: () => engine.close(),
  };
  return postgresDatabase(pool);
}
