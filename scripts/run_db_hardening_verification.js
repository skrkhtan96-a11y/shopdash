const assert = require('assert');
const db = require('../src/config/db');
const { runMigration } = require('../src/migrations/migration_v1_product_control');

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

async function runHardeningVerification() {
    console.log('🛡️ Starting Database Hardening Verification Gate...\n');

    try {
        // Step 1: Ensure PRAGMA foreign_keys = ON
        await runSql("PRAGMA foreign_keys = ON;");
        console.log('✅ PRAGMA foreign_keys = ON is active.');

        // Step 2: Get Pre-Migration counts of legacy tables
        const preInv = await getSql("SELECT COUNT(*) as count FROM inventory_products");
        const preOrders = await getSql("SELECT COUNT(*) as count FROM salla_imported_orders");
        const preExp = await getSql("SELECT COUNT(*) as count FROM expenses");

        const countPreInv = preInv ? preInv.count : 0;
        const countPreOrders = preOrders ? preOrders.count : 0;
        const countPreExp = preExp ? preExp.count : 0;

        console.log(`📊 Pre-Migration Record Counts:
   - inventory_products: ${countPreInv}
   - salla_imported_orders: ${countPreOrders}
   - expenses: ${countPreExp}`);

        // Step 3: Run Migration with forceRebuild = true to apply ON DELETE RESTRICT
        const migResult = await runMigration(true);
        console.log('✅ Migration Execution Result:', migResult);

        // Step 4: Get Post-Migration counts of legacy tables & verify zero data loss
        const postInv = await getSql("SELECT COUNT(*) as count FROM inventory_products");
        const postOrders = await getSql("SELECT COUNT(*) as count FROM salla_imported_orders");
        const postExp = await getSql("SELECT COUNT(*) as count FROM expenses");

        const countPostInv = postInv ? postInv.count : 0;
        const countPostOrders = postOrders ? postOrders.count : 0;
        const countPostExp = postExp ? postExp.count : 0;

        assert.strictEqual(countPostInv, countPreInv, 'inventory_products count changed during migration!');
        assert.strictEqual(countPostOrders, countPreOrders, 'salla_imported_orders count changed during migration!');
        assert.strictEqual(countPostExp, countPreExp, 'expenses count changed during migration!');

        console.log('✅ PASS: Zero data loss verified across all legacy production tables!');

        // Step 5: Check Mappings Breakdown
        const activeRows = await getSql("SELECT COUNT(*) as count FROM salla_product_mapping WHERE mapping_status = 'ACTIVE'");
        const reviewRows = await getSql("SELECT COUNT(*) as count FROM salla_product_mapping WHERE mapping_status = 'NEEDS_REVIEW'");
        
        const unmappedRes = await allSql(`
            SELECT COUNT(DISTINCT o.product_name) as count 
            FROM salla_imported_orders o
            LEFT JOIN salla_product_mapping m ON LOWER(TRIM(o.product_name)) = LOWER(TRIM(m.alias_name))
            WHERE m.id IS NULL AND o.product_name IS NOT NULL AND o.product_name != ''
        `);
        const countUnmapped = unmappedRes[0] ? unmappedRes[0].count : 0;

        console.log(`🏷️ Real Product Mapping Breakdown:
   - ACTIVE: ${activeRows ? activeRows.count : 0}
   - NEEDS_REVIEW: ${reviewRows ? reviewRows.count : 0}
   - UNMAPPED: ${countUnmapped}`);

        // Step 6: PRAGMA integrity_check and PRAGMA foreign_key_check
        const integrity = await allSql("PRAGMA integrity_check");
        assert.strictEqual(integrity[0].integrity_check, 'ok', 'PRAGMA integrity_check failed!');
        console.log('✅ PRAGMA integrity_check: ok');

        const fkCheck = await allSql("PRAGMA foreign_key_check");
        assert.strictEqual(fkCheck.length, 0, `PRAGMA foreign_key_check found ${fkCheck.length} violations!`);
        console.log('✅ PRAGMA foreign_key_check: 0 violations found.');

        // Step 7: Test Re-running Migration (Idempotency Check)
        const secondMig = await runMigration();
        assert.strictEqual(secondMig.status, 'ALREADY_APPLIED', 'Second migration run failed idempotency test!');
        console.log('✅ PASS: Re-running Migration is safe & idempotent (ALREADY_APPLIED).');

        // Step 8: Test invalid FK rejection under PRAGMA foreign_keys = ON
        let fkErrorCaught = false;
        try {
            await runSql(
                `INSERT INTO product_inventory_counts (product_id, inventory_at, actual_qty, expected_qty_at_count, variance, created_by)
                 VALUES (9999999, '2026-09-05T12:00:00Z', 10, 10, 0, 'tester')`
            );
        } catch (e) {
            fkErrorCaught = e.message.includes('FOREIGN KEY constraint failed');
        }
        assert(fkErrorCaught, 'Invalid FK insert was not rejected!');
        console.log('✅ PASS: Invalid Foreign Key insert was correctly REJECTED by SQLite.');

        // Step 9: Create valid parent test product for stock movement & RESTRICT policy tests
        const nowIso = new Date().toISOString();
        const testProd = await runSql("INSERT INTO inventory_products (product_name, quantity, created_at) VALUES ('منتج تجريبي للهاردنينج', 10, ?)", [nowIso]);
        const testProdId = testProd.lastID;

        // Test Unique Idempotency Constraint on product_stock_movements
        const movement = [
            testProdId, 'SALE', -1, 'ORD_HARDENING_100', 'ITEM_HARDENING_200', 'MAIN_EVENT', '2026-09-05T12:00:00Z'
        ];
        await runSql(
            `INSERT INTO product_stock_movements 
            (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            movement
        );

        let dupErrorCaught = false;
        try {
            await runSql(
                `INSERT INTO product_stock_movements 
                (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                movement
            );
        } catch (e) {
            dupErrorCaught = e.message.includes('UNIQUE constraint failed');
        }
        assert(dupErrorCaught, 'Duplicate stock movement was not blocked!');
        console.log('✅ PASS: Duplicate Stock Movement tuple correctly blocked by UNIQUE INDEX.');

        // Test multiple partial returns with distinct return event IDs
        const ret1 = [testProdId, 'SALE_RETURN', 1, 'ORD_HARDENING_100', 'ITEM_HARDENING_200', 'RET_EVENT_1', '2026-09-05T13:00:00Z'];
        const ret2 = [testProdId, 'SALE_RETURN', 1, 'ORD_HARDENING_100', 'ITEM_HARDENING_200', 'RET_EVENT_2', '2026-09-05T14:00:00Z'];
        await runSql(`INSERT INTO product_stock_movements (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ret1);
        await runSql(`INSERT INTO product_stock_movements (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ret2);
        console.log('✅ PASS: Multiple partial returns supported with distinct event reference IDs.');

        // Test RESTRICT policy when attempting to delete parent product with historical data
        await runSql(
            `INSERT INTO product_inventory_counts (product_id, inventory_at, actual_qty, expected_qty_at_count, variance, created_by)
             VALUES (?, '2026-09-05T12:00:00Z', 10, 10, 0, 'tester')`,
            [testProdId]
        );

        let deleteProdErrorCaught = false;
        try {
            await runSql("DELETE FROM inventory_products WHERE id = ?", [testProdId]);
        } catch (e) {
            deleteProdErrorCaught = e.message.includes('FOREIGN KEY constraint failed');
        }
        assert(deleteProdErrorCaught, 'Deleting product with historical inventory counts was not blocked!');
        console.log('✅ PASS: Deleting product with historical inventory counts is REJECTED by SQLite (RESTRICT policy protects history).');

        // Clean test records safely
        await runSql("DELETE FROM product_stock_movements WHERE product_id = ?", [testProdId]);
        await runSql("DELETE FROM product_inventory_counts WHERE product_id = ?", [testProdId]);
        await runSql("DELETE FROM inventory_products WHERE id = ?", [testProdId]);

        // Step 10: Verify Stock Movement Baseline Initialization
        const baselineMovements = await getSql("SELECT COUNT(*) as count FROM product_stock_movements WHERE movement_type = 'INITIAL_BASELINE'");
        console.log(`📦 Operational Stock Movements Baseline initialized: ${baselineMovements ? baselineMovements.count : 0} products.`);

        console.log('\n=====================================================');
        console.log('🏆 DATABASE HARDENING VERIFICATION REPORT');
        console.log('=====================================================');
        console.log('Migration Version : v1_product_control_center_init (1)');
        console.log(`Legacy Inventory  : ${countPostInv} records (100% intact)`);
        console.log(`Legacy Orders     : ${countPostOrders} records (100% intact)`);
        console.log(`Legacy Expenses   : ${countPostExp} records (100% intact)`);
        console.log(`ACTIVE Mappings   : ${activeRows ? activeRows.count : 0}`);
        console.log(`NEEDS_REVIEW      : ${reviewRows ? reviewRows.count : 0}`);
        console.log(`UNMAPPED          : ${countUnmapped}`);
        console.log('Integrity Check   : ok');
        console.log('Foreign Keys Check: 0 violations');
        console.log('RESTRICT Policy   : Verified (historical data protected)');
        console.log('Idempotency Check : Verified (re-running migration safe)');
        console.log('=====================================================');
        console.log('STATUS: PROVEN (Database Stage = PROVEN)\n');

    } catch (error) {
        console.error('\n❌ DATABASE HARDENING VERIFICATION FAILED:', error);
        process.exit(1);
    }
}

runHardeningVerification();
