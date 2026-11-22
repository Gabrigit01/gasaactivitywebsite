import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL est absente du fichier .env');
}

export const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (error) => {
  console.error('Erreur inattendue du pool PostgreSQL :', error);
});

export async function testDatabaseConnection() {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      NOW() AS server_time
  `);
  return result.rows[0];
}
