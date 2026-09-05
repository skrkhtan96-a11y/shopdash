const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath);

const runSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
    });
});

const allSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

async function applyOpeningInventory() {
    console.log('=== Applying Confirmed Digital Opening Inventory (actual_qty = 0) in Production DB ===');

    await runSql("PRAGMA foreign_keys = ON;");
    await runSql("BEGIN TRANSACTION;");

    try {
        const productNames = [
            'بلس ايفون - الباقة الذهبية',
            'يلا شوب - سنة كاملة + 3 شهور',
            'سناب بلس - يوم',
            'سناب بلس - اسبوع',
            'بلس اندرويد - فوري'
        ];

        const now = new Date().toISOString();

        for (const name of productNames) {
            const prods = await allSql("SELECT id FROM inventory_products WHERE product_name = ?", [name]);
            if (prods.length === 0) continue;

            const productId = prods[0].id;

            // 1. Record Inventory Count Record
            const countRes = await runSql(
                `INSERT INTO product_inventory_counts 
                 (product_id, inventory_at, actual_qty, expected_qty_at_count, variance, notes, created_by, created_at)
                 VALUES (?, ?, 0, 0, 0, ?, 'Production Admin', ?)`,
                [productId, now, 'الجرد الافتتاحي المعتمد لمنتجات الخدمات الرقمية (الرصيد الفعلي = 0)', now]
            );

            // 2. Update Product status to 'normal' with 0 inventory
            await runSql(
                `UPDATE inventory_products 
                 SET quantity = 0, current_control_status = 'normal'
                 WHERE id = ?`,
                [productId]
            );

            // 3. Update mapping status to 'ACTIVE' as confirmed by management
            await runSql(
                `UPDATE salla_product_mapping 
                 SET mapping_status = 'ACTIVE'
                 WHERE product_id = ?`,
                [productId]
            );

            console.log(`  ✅ Product ID=${productId} ("${name}"): Count Logged (0), Status='normal', Mapping='ACTIVE'`);
        }

        await runSql("COMMIT;");
        console.log('\n🎉 Opening Inventory & Active Mappings Applied Successfully!\n');

        // Integrity PRAGMAs
        const integrity = await allSql('PRAGMA integrity_check;');
        const fk = await allSql('PRAGMA foreign_key_check;');
        console.log('PRAGMA integrity_check:', integrity[0].integrity_check);
        console.log('PRAGMA foreign_key_check:', fk.length, 'violations');

    } catch (e) {
        console.error('❌ Error applying opening inventory:', e);
        await runSql("ROLLBACK;");
        process.exit(1);
    } finally {
        db.close();
    }
}

applyOpeningInventory();
