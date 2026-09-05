const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'database.db');
console.log(`🔍 Inspecting Production DB at: ${dbPath}`);

if (!fs.existsSync(dbPath)) {
    console.error(`❌ DB file not found at ${dbPath}`);
    process.exit(1);
}

const db = new sqlite3.Database(dbPath);

const runSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

async function runCheck() {
    console.log('\n--- 1. Production Preflight Row Counts ---');
    const tables = [
        'inventory_products',
        'salla_imported_orders',
        'expenses',
        'salla_product_mapping',
        'product_inventory_counts',
        'product_stock_movements',
        'purchase_headers',
        'purchase_items',
        'product_expense_allocations'
    ];

    const counts = {};
    for (const t of tables) {
        try {
            const res = await runSql(`SELECT COUNT(*) as cnt FROM ${t}`);
            counts[t] = res[0].cnt;
            console.log(`  - ${t}: ${res[0].cnt} rows`);
        } catch (e) {
            counts[t] = `TABLE NOT FOUND (${e.message})`;
            console.log(`  - ${t}: TABLE NOT CREATED YET`);
        }
    }

    console.log('\n--- 2. Mandatory Backup & Verification ---');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, '..', `database_backup_${timestamp}.db`);
    
    // Copy DB file
    fs.copyFileSync(dbPath, backupPath);
    const stats = fs.statSync(backupPath);
    
    // Hash backup
    const fileBuffer = fs.readFileSync(backupPath);
    const hashSum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    console.log(`  - Backup created: ${backupPath}`);
    console.log(`  - Backup Size: ${stats.size} bytes`);
    console.log(`  - Backup SHA256: ${hashSum}`);

    // Verify backup DB opens and integrity check succeeds
    const backupDb = new sqlite3.Database(backupPath);
    const integrityRes = await new Promise((resolve) => {
        backupDb.all('PRAGMA integrity_check;', (err, rows) => resolve(rows));
    });
    console.log(`  - Backup Integrity Check: ${JSON.stringify(integrityRes)}`);
    backupDb.close();

    console.log('\n--- 3. Migration & DB Integrity Check ---');
    const mainIntegrity = await runSql('PRAGMA integrity_check;');
    const mainFk = await runSql('PRAGMA foreign_key_check;');
    console.log(`  - Main DB Integrity Check: ${mainIntegrity[0].integrity_check}`);
    console.log(`  - Main DB Foreign Key Check: ${mainFk.length} violations`);

    console.log('\n--- 4. Production Mapping Audit ---');
    try {
        const mappingStats = await runSql(`
            SELECT mapping_status, COUNT(*) as count 
            FROM salla_product_mapping 
            GROUP BY mapping_status
        `);
        console.log(`  - Mapping status breakdown:`, mappingStats);
    } catch (e) {
        console.log(`  - Mapping table not yet initialized.`);
    }

    console.log('\n--- 5. Initial Inventory Readiness Audit ---');
    try {
        const statusBreakdown = await runSql(`
            SELECT current_control_status, COUNT(*) as count 
            FROM inventory_products 
            GROUP BY current_control_status
        `);
        console.log(`  - Product status breakdown:`, statusBreakdown);
    } catch (e) {
        console.log(`  - inventory_products table not yet populated.`);
    }

    db.close();
}

runCheck().catch(err => {
    console.error('Fatal Error during prod check:', err);
    process.exit(1);
});
