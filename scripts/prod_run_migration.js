const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { runMigration } = require('../src/migrations/migration_v1_product_control');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath);

const allSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

async function main() {
    console.log('--- Running Migration on database.db ---');
    const result = await runMigration(false);
    console.log('Migration Result:', result);

    console.log('\n--- Checking Integrity & Foreign Keys ---');
    const integrity = await allSql('PRAGMA integrity_check;');
    const fk = await allSql('PRAGMA foreign_key_check;');
    console.log('PRAGMA integrity_check:', integrity);
    console.log('PRAGMA foreign_key_check:', fk.length, 'violations');

    db.close();
}

main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
