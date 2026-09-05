const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath);

const allSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

async function main() {
    console.log('=== Executing Final Production Go-Live Script ===');

    // 1. Create Timestamped Final Backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, '..', `database_backup_golive_${timestamp}.db`);
    
    fs.copyFileSync(dbPath, backupPath);
    const stats = fs.statSync(backupPath);
    const fileBuffer = fs.readFileSync(backupPath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    console.log(`\n1. Final Production Backup Created:`);
    console.log(`   - File: ${backupPath}`);
    console.log(`   - Size: ${stats.size} bytes`);
    console.log(`   - SHA256: ${sha256}`);

    // Verify backup DB opens
    const backupDb = new sqlite3.Database(backupPath);
    const backupIntegrity = await new Promise((resolve) => {
        backupDb.all('PRAGMA integrity_check;', (err, rows) => resolve(rows));
    });
    console.log(`   - Backup Integrity Check: ${JSON.stringify(backupIntegrity)}`);
    backupDb.close();

    // 2. PRAGMA Checks on Main DB
    console.log(`\n2. Database PRAGMA Checks:`);
    const mainIntegrity = await allSql('PRAGMA integrity_check;');
    const mainFk = await allSql('PRAGMA foreign_key_check;');
    console.log(`   - PRAGMA integrity_check: ${mainIntegrity[0].integrity_check}`);
    console.log(`   - PRAGMA foreign_key_check: ${mainFk.length} violations`);

    // 3. Verify Product Control Center State
    console.log(`\n3. Product Control Center Data Summary:`);
    const prods = await allSql("SELECT id, product_name, current_control_status, cost_halalas FROM inventory_products");
    console.log(`   - Catalog Products (${prods.length}):`);
    prods.forEach(p => console.log(`     * ID: ${p.id} | Name: "${p.product_name}" | Status: ${p.current_control_status} | Cost: ${p.cost_halalas}`));

    const mappings = await allSql("SELECT mapping_status, COUNT(*) as count FROM salla_product_mapping GROUP BY mapping_status");
    console.log(`   - Mapping Status Breakdown:`, mappings);

    const counts = await allSql("SELECT COUNT(*) as count FROM product_inventory_counts");
    console.log(`   - Logged Inventory Counts: ${counts[0].count}`);

    db.close();
}

main().catch(err => {
    console.error('Go-Live execution failed:', err);
    process.exit(1);
});
