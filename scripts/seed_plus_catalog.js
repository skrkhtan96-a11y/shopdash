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

async function seedPlusProducts() {
    console.log('=== Seeding PlayStation Plus Duration/Tier Products into Catalog ===');

    const plusProducts = [
        // PS5 - أساسي
        { name: 'بلايستيشن بلس أساسي PS5 (شهري)', cost: 34, price: 23 },
        { name: 'بلايستيشن بلس أساسي PS5 (3 أشهر)', cost: 87, price: 50 },
        { name: 'بلايستيشن بلس أساسي PS5 (سنة)', cost: 245, price: 135 },

        // PS5 - إضافي
        { name: 'بلايستيشن بلس إضافي PS5 (شهري)', cost: 52, price: 37 },
        { name: 'بلايستيشن بلس إضافي PS5 (3 أشهر)', cost: 143, price: 85 },
        { name: 'بلايستيشن بلس إضافي PS5 (سنة)', cost: 406, price: 195 },

        // PS5 - فاخر
        { name: 'بلايستيشن بلس فاخر PS5 (شهري)', cost: 61, price: 48 },
        { name: 'بلايستيشن بلس فاخر PS5 (3 أشهر)', cost: 166, price: 115 },
        { name: 'بلايستيشن بلس فاخر PS5 (سنة)', cost: 469, price: 265 },

        // PS4 - أساسي
        { name: 'بلايستيشن بلس أساسي PS4 (شهري)', cost: 34, price: 23 },
        { name: 'بلايستيشن بلس أساسي PS4 (3 أشهر)', cost: 87, price: 50 },
        { name: 'بلايستيشن بلس أساسي PS4 (سنة)', cost: 245, price: 135 },

        // PS4 - إضافي
        { name: 'بلايستيشن بلس إضافي PS4 (شهري)', cost: 52, price: 37 },
        { name: 'بلايستيشن بلس إضافي PS4 (3 أشهر)', cost: 143, price: 85 },
        { name: 'بلايستيشن بلس إضافي PS4 (سنة)', cost: 406, price: 195 },

        // PS4 - فاخر
        { name: 'بلايستيشن بلس فاخر PS4 (شهري)', cost: 61, price: 48 },
        { name: 'بلايستيشن بلس فاخر PS4 (3 أشهر)', cost: 166, price: 115 },
        { name: 'بلايستيشن بلس فاخر PS4 (سنة)', cost: 469, price: 265 }
    ];

    await runSql("PRAGMA foreign_keys = ON;");
    await runSql("BEGIN TRANSACTION;");

    try {
        const now = new Date().toISOString();
        const todayDate = now.split('T')[0];

        for (const p of plusProducts) {
            const existing = await allSql(
                "SELECT id FROM inventory_products WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))",
                [p.name]
            );

            let productId;
            if (existing.length === 0) {
                const costHalalas = Math.round(p.cost * 100);
                const priceHalalas = Math.round(p.price * 100);

                const res = await runSql(
                    `INSERT INTO inventory_products 
                     (product_name, sku, salla_product_id, quantity, salla_quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                     VALUES (?, NULL, NULL, 0, 0, ?, ?, ?, ?, 0, 'normal', ?)`,
                    [p.name, p.cost, p.price, costHalalas, priceHalalas, todayDate]
                );
                productId = res.lastID;
                console.log(`  ➕ Added Product: ID=${productId} | "${p.name}"`);

                // Insert mapping
                await runSql(
                    `INSERT OR IGNORE INTO salla_product_mapping 
                     (product_id, salla_product_id, sku, alias_name, mapping_status, created_at)
                     VALUES (?, NULL, NULL, ?, 'ACTIVE', ?)`,
                    [productId, p.name, now]
                );

                // Insert initial baseline inventory count
                await runSql(
                    `INSERT INTO product_inventory_counts 
                     (product_id, inventory_at, actual_qty, expected_qty_at_count, variance, notes, created_by)
                     VALUES (?, ?, 0, 0, 0, 'جرد افتتاحي مبدئي كتالوج منتجات بلس', 'System')`,
                    [productId, now]
                );
            } else {
                productId = existing[0].id;
                console.log(`  ℹ️ Product exists: ID=${productId} | "${p.name}"`);
            }
        }

        await runSql("COMMIT;");
        console.log('✅ Playstation Plus catalog successfully seeded!');
    } catch (e) {
        console.error('❌ Error seeding catalog:', e);
        await runSql("ROLLBACK;");
    } finally {
        db.close();
    }
}

seedPlusProducts();
