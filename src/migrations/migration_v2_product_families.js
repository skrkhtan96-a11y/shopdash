const { db } = require('../../database');

const getSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

const allSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

const runSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});

const FAMILIES_SEED = [
    { code: 'PS5_BASIC', name: 'بلايستيشن بلس أساسي PS5', platform: 'PS5', tier: 'BASIC' },
    { code: 'PS5_EXTRA', name: 'بلايستيشن بلس إضافي PS5', platform: 'PS5', tier: 'EXTRA' },
    { code: 'PS5_PREMIUM', name: 'بلايستيشن بلس فاخر PS5', platform: 'PS5', tier: 'PREMIUM' },
    { code: 'PS4_BASIC', name: 'بلايستيشن بلس أساسي PS4', platform: 'PS4', tier: 'BASIC' },
    { code: 'PS4_EXTRA', name: 'بلايستيشن بلس إضافي PS4', platform: 'PS4', tier: 'EXTRA' },
    { code: 'PS4_PREMIUM', name: 'بلايستيشن بلس فاخر PS4', platform: 'PS4', tier: 'PREMIUM' }
];

const VARIANT_MANIFEST = [
    { id: 30, expected_name: 'بلايستيشن بلس أساسي PS5 (شهري)', family_code: 'PS5_BASIC', duration_code: 'MONTHLY' },
    { id: 31, expected_name: 'بلايستيشن بلس أساسي PS5 (3 أشهر)', family_code: 'PS5_BASIC', duration_code: 'THREE_MONTHS' },
    { id: 32, expected_name: 'بلايستيشن بلس أساسي PS5 (سنة)', family_code: 'PS5_BASIC', duration_code: 'YEARLY' },
    { id: 33, expected_name: 'بلايستيشن بلس إضافي PS5 (شهري)', family_code: 'PS5_EXTRA', duration_code: 'MONTHLY' },
    { id: 34, expected_name: 'بلايستيشن بلس إضافي PS5 (3 أشهر)', family_code: 'PS5_EXTRA', duration_code: 'THREE_MONTHS' },
    { id: 35, expected_name: 'بلايستيشن بلس إضافي PS5 (سنة)', family_code: 'PS5_EXTRA', duration_code: 'YEARLY' },
    { id: 36, expected_name: 'بلايستيشن بلس فاخر PS5 (شهري)', family_code: 'PS5_PREMIUM', duration_code: 'MONTHLY' },
    { id: 37, expected_name: 'بلايستيشن بلس فاخر PS5 (3 أشهر)', family_code: 'PS5_PREMIUM', duration_code: 'THREE_MONTHS' },
    { id: 38, expected_name: 'بلايستيشن بلس فاخر PS5 (سنة)', family_code: 'PS5_PREMIUM', duration_code: 'YEARLY' },
    { id: 39, expected_name: 'بلايستيشن بلس أساسي PS4 (شهري)', family_code: 'PS4_BASIC', duration_code: 'MONTHLY' },
    { id: 40, expected_name: 'بلايستيشن بلس أساسي PS4 (3 أشهر)', family_code: 'PS4_BASIC', duration_code: 'THREE_MONTHS' },
    { id: 41, expected_name: 'بلايستيشن بلس أساسي PS4 (سنة)', family_code: 'PS4_BASIC', duration_code: 'YEARLY' },
    { id: 42, expected_name: 'بلايستيشن بلس إضافي PS4 (شهري)', family_code: 'PS4_EXTRA', duration_code: 'MONTHLY' },
    { id: 43, expected_name: 'بلايستيشن بلس إضافي PS4 (3 أشهر)', family_code: 'PS4_EXTRA', duration_code: 'THREE_MONTHS' },
    { id: 44, expected_name: 'بلايستيشن بلس إضافي PS4 (سنة)', family_code: 'PS4_EXTRA', duration_code: 'YEARLY' },
    { id: 45, expected_name: 'بلايستيشن بلس فاخر PS4 (شهري)', family_code: 'PS4_PREMIUM', duration_code: 'MONTHLY' },
    { id: 46, expected_name: 'بلايستيشن بلس فاخر PS4 (3 أشهر)', family_code: 'PS4_PREMIUM', duration_code: 'THREE_MONTHS' },
    { id: 47, expected_name: 'بلايستيشن بلس فاخر PS4 (سنة)', family_code: 'PS4_PREMIUM', duration_code: 'YEARLY' }
];

async function runMigration(forceRebuild = false) {
    console.log(`[Migration v2] Starting Product Family Migration v2...`);

    try {
        await runSql("PRAGMA foreign_keys = ON;");

        // Versioning check
        await runSql(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        const v2 = await getSql("SELECT * FROM schema_version WHERE version = 2");
        if (v2 && !forceRebuild) {
            console.log("[Migration v2] Version 2 already applied. Skipping.");
            return { status: 'ALREADY_APPLIED', version: 2 };
        }

        // 1. Create product_families table
        await runSql(`
            CREATE TABLE IF NOT EXISTS product_families (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                family_code TEXT UNIQUE NOT NULL,
                family_name TEXT NOT NULL,
                platform TEXT NOT NULL CHECK(platform IN ('PS5', 'PS4', 'OTHER')),
                tier TEXT NOT NULL CHECK(tier IN ('BASIC', 'EXTRA', 'PREMIUM', 'OTHER')),
                status TEXT DEFAULT 'active',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Add family_id and duration_code columns to inventory_products
        try {
            await runSql("ALTER TABLE inventory_products ADD COLUMN family_id INTEGER REFERENCES product_families(id);");
        } catch (e) { /* column exists */ }

        try {
            await runSql("ALTER TABLE inventory_products ADD COLUMN duration_code TEXT DEFAULT 'STANDALONE' CHECK(duration_code IN ('MONTHLY', 'THREE_MONTHS', 'YEARLY', 'STANDALONE'));");
        } catch (e) { /* column exists */ }

        // Set default duration_code for products without family
        await runSql("UPDATE inventory_products SET duration_code = 'STANDALONE' WHERE family_id IS NULL AND (duration_code IS NULL OR duration_code = '');");

        // 3. Partial Unique Index
        await runSql(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_family_duration_unique 
            ON inventory_products (family_id, duration_code) 
            WHERE family_id IS NOT NULL;
        `);

        // Record pre-migration snapshot of historical table row counts
        const tablesToSnapshot = [
            'inventory_products',
            'product_stock_movements',
            'product_inventory_counts',
            'purchase_headers',
            'purchase_items',
            'product_expense_allocations',
            'salla_product_mapping'
        ];

        const preSnapshot = {};
        for (const tbl of tablesToSnapshot) {
            try {
                const r = await getSql(`SELECT COUNT(*) as count FROM ${tbl}`);
                preSnapshot[tbl] = r ? r.count : 0;
            } catch (err) {
                preSnapshot[tbl] = 0;
            }
        }

        await runSql("BEGIN TRANSACTION;");

        // Seed Product Families
        const familyIdMap = {};
        for (const fam of FAMILIES_SEED) {
            await runSql(`
                INSERT OR IGNORE INTO product_families (family_code, family_name, platform, tier, status)
                VALUES (?, ?, ?, ?, 'active');
            `, [fam.code, fam.name, fam.platform, fam.tier]);

            const row = await getSql("SELECT id FROM product_families WHERE family_code = ?", [fam.code]);
            if (row) {
                familyIdMap[fam.code] = row.id;
            }
        }

        // Manifest Validation & Linkage
        for (const v of VARIANT_MANIFEST) {
            const prod = await getSql("SELECT id, product_name FROM inventory_products WHERE id = ?", [v.id]);
            if (!prod) {
                // If variant ID not found, match by exact name
                const byName = await getSql("SELECT id, product_name FROM inventory_products WHERE TRIM(product_name) = TRIM(?)", [v.expected_name]);
                if (byName) {
                    const famId = familyIdMap[v.family_code];
                    if (famId) {
                        await runSql("UPDATE inventory_products SET family_id = ?, duration_code = ? WHERE id = ?", [famId, v.duration_code, byName.id]);
                    }
                }
            } else {
                // Verify exact name match
                if (prod.product_name.trim() !== v.expected_name.trim()) {
                    console.error(`[Migration v2 ABORT] Manifest mismatch for ID=${v.id}. DB name: "${prod.product_name}", expected: "${v.expected_name}". Rolling back!`);
                    await runSql("ROLLBACK;");
                    throw new Error(`Migration v2 Manifest Mismatch on ID ${v.id}`);
                }
                const famId = familyIdMap[v.family_code];
                if (famId) {
                    await runSql("UPDATE inventory_products SET family_id = ?, duration_code = ? WHERE id = ?", [famId, v.duration_code, v.id]);
                }
            }
        }

        await runSql("COMMIT;");

        // Post-migration snapshot verification
        for (const tbl of tablesToSnapshot) {
            try {
                const r = await getSql(`SELECT COUNT(*) as count FROM ${tbl}`);
                const postCount = r ? r.count : 0;
                if (postCount < preSnapshot[tbl]) {
                    throw new Error(`Zero Data Loss Violation: Table ${tbl} row count dropped from ${preSnapshot[tbl]} to ${postCount}`);
                }
            } catch (err) {
                if (preSnapshot[tbl] > 0) throw err;
            }
        }

        // PRAGMA checks
        const integrity = await getSql("PRAGMA integrity_check;");
        const fkCheck = await allSql("PRAGMA foreign_key_check;");
        if (integrity.integrity_check !== 'ok' || fkCheck.length > 0) {
            throw new Error(`Integrity check failed post migration: ${JSON.stringify(integrity)}, FK violations: ${fkCheck.length}`);
        }

        await runSql("INSERT OR REPLACE INTO schema_version (version, name) VALUES (2, 'v2_product_family_duration_variants');");

        console.log("[Migration v2] Product Family Migration v2 = PROVEN & Applied Successfully!");
        return { status: 'APPLIED', version: 2, snapshot: preSnapshot };
    } catch (err) {
        console.error("[Migration v2] Error running migration:", err.message);
        try { await runSql("ROLLBACK;"); } catch (e) {}
        throw err;
    }
}

module.exports = {
    runMigration,
    FAMILIES_SEED,
    VARIANT_MANIFEST
};
