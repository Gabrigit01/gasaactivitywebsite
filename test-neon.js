
import { pool, testDatabaseConnection } from './config/database.js';

try {
    const result = await testDatabaseConnection();

    console.log('Connexion à Neon réussie !');
    console.log('Base :', result.database_name);
    console.log('Utilisateur :', result.database_user);
    console.log('Heure du serveur :', result.server_time);

} catch (error) {
    console.error('Échec de connexion à Neon :', error.message);
    process.exitCode = 1;

} finally {
    await pool.end();
}
