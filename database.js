import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The application keeps the same parameterized statements on both engines.
// Only SQL tokens are translated; quoted strings and comments stay untouched.
export function postgresSql(sql) {
  let parameter = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?|\b[A-Za-z_][A-Za-z_0-9]*\b/g, token => {
    if (token === '?') return '$' + (++parameter);
    if (/^[\'"/\-]/.test(token)) return token;
    if (token === 'BLOB') return 'BYTEA';
    if (token === 'INTEGER') return 'BIGINT';
    if (/[a-z][A-Z]/.test(token)) return '"' + token + '"';
    return token;
  });
}

function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Valeur de base de données hors limites.');
  return number;
}

export function postgresDatabase(pool) {
  const context = new AsyncLocalStorage();
  let savepoint = 0;
  const query = (sql, values) => (context.getStore() || pool).query(postgresSql(sql), values);
  const db = {
    dialect: 'postgres',
    orderColumn: 'sort_order',
    exec: sql => query(sql),
    prepare(sql) {
      return {
        async all(...values) { return (await query(sql, values)).rows; },
        async get(...values) { return (await query(sql, values)).rows[0]; },
        async run(...values) { return { changes: (await query(sql, values)).rowCount }; },
      };
    },
    async transaction(work) {
      const current = context.getStore();
      const client = current || await pool.connect();
      const name = current ? 'gasa_' + (++savepoint) : null;
      let begun = false;
      try {
        await client.query(name ? 'SAVEPOINT ' + name : 'BEGIN');
        begun = true;
        const result = await context.run(client, work);
        await client.query(name ? 'RELEASE SAVEPOINT ' + name : 'COMMIT');
        return result;
      } catch (error) {
        if (begun) await client.query(name ? 'ROLLBACK TO SAVEPOINT ' + name : 'ROLLBACK').catch(() => {});
        throw error;
      } finally {
        if (!current) client.release();
      }
    },
    async close() { await pool.end(); },
  };
  return db;
}

export async function openDatabase({ connectionString = process.env.DATABASE_URL, dataDir } = {}) {
  if (connectionString) {
    let url;
    try { url = new URL(connectionString); } catch { /* Report no connection credentials. */ }
    if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('DATABASE_URL doit être une adresse PostgreSQL valide.');
    }
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 15_000,
      application_name: 'gasa-activites',
      enableChannelBinding: true,
      types: {
        getTypeParser(oid, format) {
          return oid === 20 && format !== 'binary' ? safeInteger : pg.types.getTypeParser(oid, format);
        },
      },
    });
    pool.on('error', () => console.error('Connexion PostgreSQL interrompue ; une nouvelle connexion sera tentée.'));
    const db = postgresDatabase(pool);
    try { await db.exec('SELECT 1'); } catch {
      await db.close();
      throw new Error('Connexion PostgreSQL impossible. Vérifiez DATABASE_URL et la disponibilité de la base.');
    }
    return db;
  }

  const { DatabaseSync } = await import('node:sqlite');
  const directory = resolve(dataDir || './data');
  mkdirSync(directory, { recursive: true });
  const sqlite = new DatabaseSync(resolve(directory, 'gasa.sqlite'));
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  let savepoint = 0;
  const exclusive = work => {
    const pending = queue.then(work);
    queue = pending.catch(() => {});
    return pending;
  };
  const execute = work => context.getStore() ? Promise.resolve().then(work) : exclusive(work);
  return {
    dialect: 'sqlite',
    orderColumn: 'rowid',
    exec: sql => execute(() => sqlite.exec(sql)),
    prepare(sql) {
      // Prepare lazily so startup transactions can create their own tables first.
      return Object.fromEntries(['all', 'get', 'run'].map(method => [method,
        (...values) => execute(() => sqlite.prepare(sql)[method](...values)),
      ]));
    },
    async transaction(work) {
      const nested = context.getStore();
      const name = nested ? 'gasa_' + (++savepoint) : null;
      const perform = async () => {
        sqlite.exec(name ? 'SAVEPOINT ' + name : 'BEGIN IMMEDIATE');
        try {
          const result = await context.run(true, work);
          sqlite.exec(name ? 'RELEASE SAVEPOINT ' + name : 'COMMIT');
          return result;
        } catch (error) {
          sqlite.exec(name ? 'ROLLBACK TO SAVEPOINT ' + name : 'ROLLBACK');
          throw error;
        }
      };
      return nested ? perform() : exclusive(perform);
    },
    close: () => exclusive(() => sqlite.close()),
  };
}
