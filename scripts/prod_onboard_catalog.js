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

async function onboardCatalog() {
    console.log('=== Starting Catalog Onboarding in Production DB (database.db) ===');

    await runSql("PRAGMA foreign_keys = ON;");
    await runSql("BEGIN TRANSACTION;");

    try {
        const productsToOnboard = [
            { name: 'بلس ايفون - الباقة الذهبية', sku: null, salla_id: null },
            { name: 'يلا شوب - سنة كاملة + 3 شهور', sku: null, salla_id: null },
            { name: 'سناب بلس - يوم', sku: null, salla_id: null },
            { name: 'سناب بلس - اسبوع', sku: null, salla_id: null },
            { name: 'بلس اندرويد - فوري', sku: null, salla_id: null }
        ];

        const onboardedResults = [];

        for (const p of productsToOnboard) {
            // Check if product already exists in inventory_products
            let prodRow = await allSql(
                "SELECT id, product_name, current_control_status FROM inventory_products WHERE product_name = ?",
                [p.name]
            );

            let productId;
            if (prodRow.length === 0) {
                const res = await runSql(
                    `INSERT INTO inventory_products 
                     (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                     VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'needs_inventory', datetime('now'))`,
                    [p.name, p.salla_id, p.sku]
                );
                productId = res.lastID;
                console.log(`  ➕ Inserted inventory_products: ID=${productId} | Name="${p.name}"`);
            } else {
                productId = prodRow[0].id;
                console.log(`  ℹ️ Product already exists: ID=${productId} | Name="${p.name}"`);
            }

            // Insert or ignore mapping with status NEEDS_REVIEW (since no salla_product_id or SKU is present in Excel order)
            await runSql(
                `INSERT OR IGNORE INTO salla_product_mapping 
                 (product_id, salla_product_id, sku, alias_name, mapping_status, created_at)
                 VALUES (?, ?, ?, ?, 'NEEDS_REVIEW', datetime('now'))`,
                [productId, p.salla_id, p.sku, p.name]
            );

            onboardedResults.push({
                product_id: productId,
                product_name: p.name,
                salla_product_id: p.salla_id,
                sku: p.sku,
                mapping_status: 'NEEDS_REVIEW',
                control_status: 'needs_inventory'
            });
        }

        await runSql("COMMIT;");
        console.log('✅ Catalog Onboarding Transaction Committed Successfully!\n');

        // Verify Integrity
        const integrity = await allSql('PRAGMA integrity_check;');
        const fk = await allSql('PRAGMA foreign_key_check;');
        console.log('PRAGMA integrity_check:', integrity[0].integrity_check);
        console.log('PRAGMA foreign_key_check:', fk.length, 'violations');

        console.log('\n--- Summary Table ---');
        console.dir(onboardedResults, { depth: null });

    } catch (e) {
        console.error('❌ Onboarding Error! Rolling back...', e);
        await runSql("ROLLBACK;");
        process.exit(1);
    } finally {
        db.close();
    }
}

onboardCatalog();
