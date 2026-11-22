
import { pool } from './config/database.js';

try {
    const result = await pool.query(`
        SELECT
            current_database() AS database,
            current_user AS db_user,
            (SELECT COUNT(*) FROM activities) AS activities_count,
            (SELECT COUNT(*) FROM sessions) AS sessions_count
    `);

    console.log('Résultat de la vérification Neon :');
    console.log(result.rows[0]);

} catch (error) {
    console.error('Erreur :', error.message);

} finally {
    await pool.end();
}
