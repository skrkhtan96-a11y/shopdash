const db = require('../config/db');

const MIGRATION_VERSION = 1;
const MIGRATION_NAME = 'v1_product_control_center_init';

function runSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function runMigration(forceRebuild = false) {
    console.log(`[Migration] Starting Versioned Migration v${MIGRATION_VERSION}: ${MIGRATION_NAME}...`);

    // Ensure foreign keys active
    await runSql("PRAGMA foreign_keys = ON;");

    // 1. Create schema_migrations table if not exists
    await runSql(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 2. Check if migration already applied
    const existing = await getSql("SELECT version FROM schema_migrations WHERE version = ?", [MIGRATION_VERSION]);
    if (existing && !forceRebuild) {
        console.log(`[Migration] Version ${MIGRATION_VERSION} already applied. Skipping.`);
        return { status: 'ALREADY_APPLIED', version: MIGRATION_VERSION };
    }

    // 3. Begin Transaction
    await runSql("BEGIN TRANSACTION");

    try {
        // If forceRebuild, drop new tables to apply ON DELETE RESTRICT
        if (forceRebuild) {
            await runSql("DROP TABLE IF EXISTS product_stock_movements");
            await runSql("DROP TABLE IF EXISTS product_inventory_counts");
            await runSql("DROP TABLE IF EXISTS purchase_items");
            await runSql("DROP TABLE IF EXISTS purchase_headers");
            await runSql("DROP TABLE IF EXISTS product_expense_allocations");
            await runSql("DROP TABLE IF EXISTS product_status_history");
            await runSql("DROP TABLE IF EXISTS salla_product_mapping");
        }

        // 3.1. salla_product_mapping (ON DELETE RESTRICT to protect mapping history)
        await runSql(`
            CREATE TABLE IF NOT EXISTS salla_product_mapping (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                salla_product_id TEXT,
                sku TEXT,
                alias_name TEXT UNIQUE NOT NULL,
                mapping_status TEXT DEFAULT 'ACTIVE',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(product_id) REFERENCES inventory_products(id) ON DELETE RESTRICT
            )
        `);

        // 3.2. product_inventory_counts (ON DELETE RESTRICT to prevent loss of audit history)
        await runSql(`
            CREATE TABLE IF NOT EXISTS product_inventory_counts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                inventory_at TEXT NOT NULL,
                actual_qty INTEGER NOT NULL,
                expected_qty_at_count INTEGER NOT NULL,
                variance INTEGER NOT NULL,
                notes TEXT,
                created_by TEXT NOT NULL,
                user_id INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                deleted_by TEXT,
                deleted_at TEXT,
                cancellation_reason TEXT,
                FOREIGN KEY(product_id) REFERENCES inventory_products(id) ON DELETE RESTRICT
            )
        `);

        // 3.3. purchase_headers
        await runSql(`
            CREATE TABLE IF NOT EXISTS purchase_headers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchased_at TEXT NOT NULL,
                supplier TEXT,
                invoice_ref TEXT,
                expense_id INTEGER,
                total_invoice_amount_halalas INTEGER NOT NULL,
                notes TEXT,
                created_by TEXT NOT NULL,
                user_id INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                deleted_by TEXT,
                deleted_at TEXT,
                cancellation_reason TEXT,
                FOREIGN KEY(expense_id) REFERENCES expenses(id) ON DELETE SET NULL
            )
        `);

        // 3.4. purchase_items (ON DELETE RESTRICT on product_id)
        await runSql(`
            CREATE TABLE IF NOT EXISTS purchase_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                header_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                unit_cost_halalas INTEGER NOT NULL,
                total_amount_halalas INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(header_id) REFERENCES purchase_headers(id) ON DELETE CASCADE,
                FOREIGN KEY(product_id) REFERENCES inventory_products(id) ON DELETE RESTRICT
            )
        `);

        // 3.5. product_expense_allocations (ON DELETE RESTRICT on product_id & expense_id)
        await runSql(`
            CREATE TABLE IF NOT EXISTS product_expense_allocations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                expense_id INTEGER NOT NULL,
                allocation_type TEXT NOT NULL DEFAULT 'ADVERTISING',
                platform TEXT,
                campaign_name TEXT,
                period_from TEXT NOT NULL,
                period_to TEXT NOT NULL,
                allocated_amount_halalas INTEGER NOT NULL,
                allocation_ratio REAL DEFAULT 1.0,
                reference TEXT,
                notes TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                FOREIGN KEY(product_id) REFERENCES inventory_products(id) ON DELETE RESTRICT,
                FOREIGN KEY(expense_id) REFERENCES expenses(id) ON DELETE RESTRICT
            )
        `);

        // 3.6. product_status_history (ON DELETE RESTRICT)
        await runSql(`
            CREATE TABLE IF NOT EXISTS product_status_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                old_status TEXT,
                new_status TEXT NOT NULL,
                changed_by TEXT NOT NULL,
                user_id INTEGER,
                reason TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(product_id) REFERENCES inventory_products(id) ON DELETE RESTRICT
            )
        `);

        // 3.7. product_control_audit_logs
        await runSql(`
            CREATE TABLE IF NOT EXISTS product_control_audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                entity_id INTEGER,
                action TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                user_id INTEGER,
                username TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3.8. product_stock_movements (ON DELETE RESTRICT - Operational Stock Source of Truth)
        await runSql(`
            CREATE TABLE IF NOT EXISTS product_stock_movements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                movement_type TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                source_reference_id TEXT NOT NULL,
                source_item_reference_id TEXT NOT NULL,
                source_event_reference_id TEXT NOT NULL DEFAULT 'MAIN',
                movement_at TEXT NOT NULL,
                unit_cogs_halalas INTEGER DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(product_id) REFERENCES inventory_products(id) ON DELETE RESTRICT
            )
        `);

        // 3.9. Unique Idempotency Index on product_stock_movements
        await runSql(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_idempotency 
            ON product_stock_movements(product_id, movement_type, source_reference_id, source_item_reference_id, source_event_reference_id)
        `);

        // 3.10. product_control_config
        await runSql(`
            CREATE TABLE IF NOT EXISTS product_control_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3.11. Indexes
        await runSql(`CREATE INDEX IF NOT EXISTS idx_p_inv_date ON product_inventory_counts(product_id, inventory_at)`);
        await runSql(`CREATE INDEX IF NOT EXISTS idx_p_items_prod ON purchase_items(product_id)`);
        await runSql(`CREATE INDEX IF NOT EXISTS idx_p_items_head ON purchase_items(header_id)`);
        await runSql(`CREATE INDEX IF NOT EXISTS idx_p_alloc_prod ON product_expense_allocations(product_id, period_from, period_to)`);
        await runSql(`CREATE INDEX IF NOT EXISTS idx_p_stat_prod ON product_status_history(product_id, created_at)`);
        await runSql(`CREATE INDEX IF NOT EXISTS idx_p_mov_prod_date ON product_stock_movements(product_id, movement_at)`);

        // 4. Safe ALTER on inventory_products
        try { await runSql("ALTER TABLE inventory_products ADD COLUMN cost_halalas INTEGER DEFAULT 0"); } catch (e) {}
        try { await runSql("ALTER TABLE inventory_products ADD COLUMN price_halalas INTEGER DEFAULT 0"); } catch (e) {}
        try { await runSql("ALTER TABLE inventory_products ADD COLUMN inventory_value_halalas INTEGER DEFAULT 0"); } catch (e) {}
        try { await runSql("ALTER TABLE inventory_products ADD COLUMN current_control_status TEXT DEFAULT 'normal'"); } catch (e) {}

        // 5. Seed default config
        await runSql(`
            INSERT OR IGNORE INTO product_control_config (key, value, description)
            VALUES 
            ('require_recent_inventory_before_purchase', '1', 'اشتراط إجراء جرد حديث قبل السماح بتسجيل شراء جديد'),
            ('max_days_since_inventory', '30', 'أقصى عدد أيام مسموح بعد آخر جرد (30 يوماً)')
        `);

        // 6. Populate Product Mappings & Operational Stock Ledger Baselines
        const prods = await allSql("SELECT id, product_name, salla_product_id, sku, quantity, cost, price FROM inventory_products");
        let activeCount = 0;
        let needsReviewCount = 0;

        const now = new Date().toISOString();

        for (const p of (prods || [])) {
            const name = (p.product_name || '').trim();
            if (name) {
                const isAmbiguous = name.includes('؟') || name.length < 3;
                const status = isAmbiguous ? 'NEEDS_REVIEW' : 'ACTIVE';
                await runSql(
                    `INSERT OR IGNORE INTO salla_product_mapping (product_id, salla_product_id, sku, alias_name, mapping_status)
                     VALUES (?, ?, ?, ?, ?)`,
                    [p.id, p.salla_product_id || null, p.sku || null, name, status]
                );
                if (isAmbiguous) needsReviewCount++;
                else activeCount++;

                // Convert existing float cost/price to halalas if needed
                const costHalalas = Math.round((p.cost || 0) * 100);
                const priceHalalas = Math.round((p.price || 0) * 100);
                const initialValueHalalas = (p.quantity || 0) * costHalalas;

                await runSql(
                    `UPDATE inventory_products 
                     SET cost_halalas = ?, price_halalas = ?, inventory_value_halalas = ?
                     WHERE id = ?`,
                    [costHalalas, priceHalalas, initialValueHalalas, p.id]
                );

                // Insert INITIAL_BASELINE stock movement
                await runSql(
                    `INSERT OR IGNORE INTO product_stock_movements
                    (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at, unit_cogs_halalas)
                    VALUES (?, 'INITIAL_BASELINE', ?, 'SYSTEM_MIGRATION_V1', ?, 'BASELINE', ?, ?)`,
                    [p.id, p.quantity || 0, String(p.id), now, costHalalas]
                );

                if ((p.quantity || 0) === 0) {
                    await runSql("UPDATE inventory_products SET current_control_status = 'needs_inventory' WHERE id = ?", [p.id]);
                }
            }
        }

        // Count unmapped distinct product names in salla_imported_orders
        const unmappedOrders = await allSql(`
            SELECT COUNT(DISTINCT o.product_name) as count 
            FROM salla_imported_orders o
            LEFT JOIN salla_product_mapping m ON LOWER(TRIM(o.product_name)) = LOWER(TRIM(m.alias_name))
            WHERE m.id IS NULL AND o.product_name IS NOT NULL AND o.product_name != ''
        `);
        const unmappedCount = unmappedOrders[0] ? unmappedOrders[0].count : 0;

        // 7. Record version
        await runSql("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (?, ?)", [MIGRATION_VERSION, MIGRATION_NAME]);

        // Commit transaction
        await runSql("COMMIT");

        console.log(`[Migration] Version ${MIGRATION_VERSION} applied successfully! ACTIVE: ${activeCount}, NEEDS_REVIEW: ${needsReviewCount}, UNMAPPED: ${unmappedCount}`);
        return {
            status: 'SUCCESS',
            version: MIGRATION_VERSION,
            active_mappings: activeCount,
            needs_review_mappings: needsReviewCount,
            unmapped_orders_count: unmappedCount
        };
    } catch (ex) {
        console.error('[Migration Error] Rolling back...', ex.message);
        try { await runSql("ROLLBACK"); } catch (rbErr) {}
        throw ex;
    }
}

module.exports = { runMigration, MIGRATION_VERSION };
