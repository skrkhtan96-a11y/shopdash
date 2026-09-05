const path = require('path');
const db = require('../src/config/db');
const ProductControlRepository = require('../src/repositories/product_control.repository');
const ProductControlService = require('../src/services/product_control.service');
const CurrencyUtil = require('../src/utils/currency');
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

async function runBackendVerification() {
    console.log("=================================================================");
    console.log("🚀 STARTING BACKEND STAGE VERIFICATION SUITE FOR PRODUCT CONTROL");
    console.log("=================================================================\n");

    let totalTests = 0;
    let passedTests = 0;

    function assert(condition, message) {
        totalTests++;
        if (condition) {
            passedTests++;
            console.log(`  [PASS] Test ${totalTests}: ${message}`);
        } else {
            console.error(`  [FAIL] Test ${totalTests}: ${message}`);
            throw new Error(`Assertion failed: ${message}`);
        }
    }

    try {
        // Ensure migration applied
        await runMigration(false);
        await runSql("PRAGMA foreign_keys = ON;");

        // Cleanup any leftover test data in proper dependency order (child tables first due to ON DELETE RESTRICT)
        await runSql("DELETE FROM purchase_items WHERE product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%TEST%')");
        await runSql("DELETE FROM product_stock_movements WHERE source_reference_id LIKE '%TEST%' OR source_reference_id LIKE '%ORD_%' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%TEST%')");
        await runSql("DELETE FROM product_inventory_counts WHERE notes LIKE '%TEST%' OR notes LIKE '%افتتاح%' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%TEST%')");
        await runSql("DELETE FROM product_expense_allocations WHERE platform = 'TikTok' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%TEST%')");
        await runSql("DELETE FROM product_status_history WHERE product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%TEST%')");
        await runSql("DELETE FROM salla_product_mapping WHERE alias_name LIKE '%TEST%' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%TEST%')");
        await runSql("DELETE FROM purchase_headers WHERE invoice_ref LIKE '%INV-2026%'");
        await runSql("DELETE FROM inventory_products WHERE product_name LIKE '%TEST%'");
        await runSql("DELETE FROM expenses WHERE desc = 'حملة تيك توك الترويجية'");
        await runSql("DELETE FROM salla_imported_orders WHERE reference_id IN ('ORD_UNMAPPED_999', 'ORD_TEST_1001')");

        // --- TEST 1: Empty Product Catalog ---
        console.log("🔹 Test Group 1: Empty Catalog Handling");
        const overviewEmpty = await ProductControlService.getProductsOverview();
        assert(Array.isArray(overviewEmpty.products), "getProductsOverview returns products array when catalog is empty or populated");

        // Create temporary test product in inventory_products for isolated testing
        const now = new Date().toISOString();
        const testProd1Res = await runSql(
            `INSERT INTO inventory_products (product_name, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['ساعة ذكية فاخرة TEST', 'TEST-WATCH-01', 0, 100, 250, 10000, 25000, 0, 'needs_inventory', now]
        );
        const testProd1Id = testProd1Res.lastID;
        assert(testProd1Id > 0, "Inserted test product successfully");

        // --- TEST 2: Product Mapping & Unmapped Order Handling ---
        console.log("\n🔹 Test Group 2: Product Mapping & Unmapped Order Handling");
        // Insert unmapped order
        await runSql(
            `INSERT OR REPLACE INTO salla_imported_orders (reference_id, date, status_slug, status_name, amount, product_name, quantity)
             VALUES ('ORD_UNMAPPED_999', '2026-09-01', 'completed', 'تم التنفيذ', 250.00, 'عطر غير مربوط 999', 1)`
        );

        const unmappedList = await ProductControlService.getUnmappedOrdersProducts();
        const foundUnmapped = unmappedList.find(u => u.product_name === 'عطر غير مربوط 999');
        assert(foundUnmapped !== undefined, "Unmapped sale detected in unmapped list");

        // Verify unmapped sale does NOT show in testProd1 KPI
        const overviewWithTestProd = await ProductControlService.getProductsOverview('TEST-WATCH-01');
        assert(overviewWithTestProd.products.length === 1, "Fetched test product in overview");
        assert(overviewWithTestProd.products[0].total_units_sold === 0, "UNMAPPED sale does NOT enter product KPI");

        // Map alias to test product
        await ProductControlService.saveMapping(testProd1Id, 'SALLA-W01', 'TEST-WATCH-01', 'ساعة ذكية فاخرة TEST', 'ACTIVE', { id: 1, username: 'tester' });
        const mappings = await ProductControlService.getAllMappings();
        const savedMap = mappings.find(m => m.product_id === testProd1Id && m.alias_name === 'ساعة ذكية فاخرة TEST');
        assert(savedMap && savedMap.mapping_status === 'ACTIVE', "Saved active mapping successfully");

        // --- TEST 3: Idempotent Stock Movements (Sale & Returns) ---
        console.log("\n🔹 Test Group 3: Idempotent Stock Movement Synchronization");
        // Insert order matching mapped product alias
        await runSql(
            `INSERT OR REPLACE INTO salla_imported_orders (reference_id, date, status_slug, status_name, amount, product_name, quantity)
             VALUES ('ORD_TEST_1001', '2026-09-02', 'completed', 'تم التنفيذ', 250.00, 'ساعة ذكية فاخرة TEST', 2)`
        );

        // Sync sales
        const syncedCount1 = await ProductControlService.syncSalesToStockMovements();
        assert(syncedCount1 >= 1, "Synced sales to stock movements");

        // Run sync sales a second time (Idempotency check)
        const movementsBefore = await ProductControlRepository.getStockMovements(testProd1Id);
        const saleMovements1 = movementsBefore.filter(m => m.source_reference_id === 'ORD_TEST_1001' && m.movement_type === 'SALE');
        assert(saleMovements1.length === 1, "Recorded exactly 1 sale movement for order");

        await ProductControlService.syncSalesToStockMovements();
        const movementsAfter = await ProductControlRepository.getStockMovements(testProd1Id);
        const saleMovements2 = movementsAfter.filter(m => m.source_reference_id === 'ORD_TEST_1001' && m.movement_type === 'SALE');
        assert(saleMovements2.length === 1, "Re-running sync does NOT duplicate stock movement (Idempotent)");

        // --- TEST 4: Partial / Full Returns ---
        console.log("\n🔹 Test Group 4: Partial / Full Returns");
        // Update order status to refunded
        await runSql(
            `UPDATE salla_imported_orders SET status_slug = 'refunded' WHERE reference_id = 'ORD_TEST_1001'`
        );
        await ProductControlService.syncSalesToStockMovements();

        const movementsAfterReturn = await ProductControlRepository.getStockMovements(testProd1Id);
        const returnMovement = movementsAfterReturn.find(m => m.source_reference_id === 'ORD_TEST_1001' && m.movement_type === 'RETURN');
        assert(returnMovement !== undefined && returnMovement.quantity === 2, "Recorded positive return stock movement idempotently");

        // --- TEST 5: Inventory Count Transaction ---
        console.log("\n🔹 Test Group 5: Inventory Count Transaction & Baseline");
        const countRes = await ProductControlService.recordInventoryCount(testProd1Id, {
            actual_qty: 50,
            inventory_at: '2026-09-03T10:00:00.000Z',
            notes: 'افتتاح رصيد الجرد الفعلي'
        }, { id: 1, username: 'auditor' });

        assert(countRes.actual_qty === 50, "Inventory count recorded 50 actual units");

        const updatedProdAfterCount = await ProductControlRepository.getProductById(testProd1Id);
        assert(updatedProdAfterCount.quantity === 50, "Product stock updated to 50");
        assert(updatedProdAfterCount.inventory_value_halalas === 50 * 10000, "Inventory value updated to 500,000 Halalas");

        // --- TEST 6: Multi-Product Purchase Invoice & WAC Calculation ---
        console.log("\n🔹 Test Group 6: Multi-Product Purchase Invoice & WAC Calculation");
        // Insert second test product
        const testProd2Res = await runSql(
            `INSERT INTO inventory_products (product_name, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['سوار أبل TEST', 'TEST-STRAP-02', 20, 50, 100, 5000, 10000, 100000, 'normal', now]
        );
        const testProd2Id = testProd2Res.lastID;

        // Record multi-product purchase
        const invoiceRes = await ProductControlService.recordPurchaseInvoice({
            purchased_at: '2026-09-04T14:00:00.000Z',
            supplier: 'شركة الجملة العالمية',
            invoice_ref: 'INV-2026-001',
            notes: 'شراء دفعة استيراد رقم 1',
            items: [
                { product_id: testProd1Id, quantity: 50, unit_cost_halalas: 12000 }, // 50 units @ 120 SAR = 600,000 Halalas
                { product_id: testProd2Id, quantity: 30, unit_cost_halalas: 6000 }   // 30 units @ 60 SAR = 180,000 Halalas
            ]
        }, { id: 1, username: 'purchaser' });

        assert(invoiceRes.header_id > 0, "Multi-product purchase invoice created successfully");
        assert(invoiceRes.total_invoice_amount_halalas === 780000, "Calculated total invoice halalas = 780,000 (7,800 SAR)");

        // Verify WAC on Prod 1:
        // Initial: 50 units @ 100 SAR (500,000 Halalas)
        // Purchase: 50 units @ 120 SAR (600,000 Halalas)
        // Total: 100 units = 1,100,000 Halalas => WAC = 11,000 Halalas (110 SAR)
        const prod1AfterPur = await ProductControlRepository.getProductById(testProd1Id);
        assert(prod1AfterPur.quantity === 100, "Prod 1 quantity updated to 100");
        assert(prod1AfterPur.cost_halalas === 11000, "Prod 1 WAC recalculated to 11,000 Halalas (110 SAR)");
        assert(prod1AfterPur.inventory_value_halalas === 1100000, "Prod 1 inventory value updated to 1,100,000 Halalas");

        // --- TEST 7: Sequential Purchase WAC Drift Check ---
        console.log("\n🔹 Test Group 7: Sequential Purchase WAC Drift Check");
        // Second purchase of Prod 1: 100 units @ 130 SAR (13,000 Halalas) = 1,300,000 Halalas
        await ProductControlService.recordPurchaseInvoice({
            purchased_at: '2026-09-05T09:00:00.000Z',
            supplier: 'شركة الجملة العالمية',
            invoice_ref: 'INV-2026-002',
            items: [
                { product_id: testProd1Id, quantity: 100, unit_cost_halalas: 13000 }
            ]
        }, { id: 1, username: 'purchaser' });

        // Total: 200 units = 2,400,000 Halalas => WAC = 12,000 Halalas (120 SAR)
        const prod1AfterPur2 = await ProductControlRepository.getProductById(testProd1Id);
        assert(prod1AfterPur2.quantity === 200, "Prod 1 quantity updated to 200");
        assert(prod1AfterPur2.cost_halalas === 12000, "Prod 1 WAC recalculated to 12,000 Halalas without rounding drift");
        assert(prod1AfterPur2.inventory_value_halalas === 2400000, "Prod 1 total inventory value exact");

        // --- TEST 8: Purchase Reversal / Cancellation ---
        console.log("\n🔹 Test Group 8: Purchase Reversal / Cancellation");
        await ProductControlService.cancelPurchaseInvoice(testProd1Id, invoiceRes.header_id, 'خطأ في فاتورة المورد', { id: 1, username: 'manager' });
        const prod1AfterCancel = await ProductControlRepository.getProductById(testProd1Id);
        assert(prod1AfterCancel.quantity === 150, "Prod 1 stock reduced back by 50 units");

        // --- TEST 9: COGS Unavailable Handling ---
        console.log("\n🔹 Test Group 9: COGS Unavailable Handling");
        const testProd3Res = await runSql(
            `INSERT INTO inventory_products (product_name, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['منتج بدون تكلفة TEST', 'TEST-NOCOST-03', 10, 0, 50, 0, 5000, 0, 'normal', now]
        );
        const testProd3Id = testProd3Res.lastID;
        const detailsNoCost = await ProductControlService.getProductDetails(testProd3Id);
        assert(detailsNoCost.cogs_status === 'UNAVAILABLE', "COGS status is UNAVAILABLE when cost is 0 and no purchases exist");

        // --- TEST 10: Expense Allocation Over-Limit Rejection ---
        console.log("\n🔹 Test Group 10: Expense Allocation Over-Limit Rejection");
        // Create dummy expense in expenses table: 1,000 SAR (100,000 Halalas)
        const expRes = await runSql(
            `INSERT INTO expenses (desc, cat, amt, date) VALUES ('حملة تيك توك الترويجية', 'ADVERTISING', 1000.00, '2026-09-01')`
        );
        const expenseId = expRes.lastID;

        // First allocation: 80,000 Halalas (800 SAR)
        const alloc1 = await ProductControlService.recordExpenseAllocation({
            product_id: testProd1Id,
            expense_id: expenseId,
            allocation_type: 'ADVERTISING',
            platform: 'TikTok',
            period_from: '2026-09-01',
            period_to: '2026-09-05',
            allocated_amount_halalas: 80000
        }, { id: 1, username: 'marketer' });

        assert(alloc1.allocated_amount_halalas === 80000, "First allocation of 80,000 Halalas succeeded");

        // Second allocation: 30,000 Halalas (300 SAR) -> Total 110,000 > 100,000 => MUST REJECT!
        let allocationRejected = false;
        try {
            await ProductControlService.recordExpenseAllocation({
                product_id: testProd2Id,
                expense_id: expenseId,
                allocation_type: 'ADVERTISING',
                platform: 'TikTok',
                period_from: '2026-09-01',
                period_to: '2026-09-05',
                allocated_amount_halalas: 30000
            }, { id: 1, username: 'marketer' });
        } catch (err) {
            allocationRejected = true;
            assert(err.details !== undefined, "Rejection error returned structured details");
            assert(err.details.remaining_amount_halalas === 20000, "Remaining amount correctly identified as 20,000 Halalas");
        }
        assert(allocationRejected, "Expense allocation exceeding legacy expense total was rejected");

        // --- TEST 11: Pre-Purchase Decision Engine ---
        console.log("\n🔹 Test Group 11: Pre-Purchase Decision Engine");
        // Test product 3 has no inventory count
        const preCheckProd3 = await ProductControlService.evaluatePrePurchase(testProd3Id);
        assert(preCheckProd3.allowed === false, "Pre-purchase check blocks when inventory count missing");
        assert(preCheckProd3.blocking_reasons.length >= 1, "Blocking reasons contains inventory count message");

        // Change status to purchase_stopped
        await ProductControlService.updateProductStatus(testProd1Id, 'purchase_stopped', 'إيقاف الشراء مؤقتاً', { id: 1, username: 'manager' });
        const preCheckStopped = await ProductControlService.evaluatePrePurchase(testProd1Id);
        assert(preCheckStopped.allowed === false, "Pre-purchase check blocks when product status is purchase_stopped");

        // --- TEST 12: Invalid Foreign Key Rejection ---
        console.log("\n🔹 Test Group 12: Invalid Foreign Key Rejection");
        let fkViolationCaught = false;
        try {
            await ProductControlRepository.insertStockMovement({
                product_id: 999999, // Non-existent product ID
                movement_type: 'SALE',
                quantity: -1,
                source_reference_id: 'FK_TEST',
                source_item_reference_id: '1',
                source_event_reference_id: 'MAIN',
                movement_at: new Date().toISOString()
            });
        } catch (err) {
            fkViolationCaught = true;
            assert(err.message.includes('FOREIGN KEY') || err.message.includes('constraint'), "Invalid FK threw foreign key constraint error");
        }
        assert(fkViolationCaught, "Foreign key constraint correctly enforced");

        // --- TEST 13: Timeline Aggregation ---
        console.log("\n🔹 Test Group 13: Timeline Aggregation");
        const timeline = await ProductControlService.getProductTimeline(testProd1Id);
        assert(Array.isArray(timeline) && timeline.length >= 3, "Timeline returns chronological array of events");

        // --- Clean up test products from DB after tests ---
        await runSql("DELETE FROM purchase_items WHERE product_id IN (?, ?, ?)", [testProd1Id, testProd2Id, testProd3Id]);
        await runSql("DELETE FROM product_stock_movements WHERE product_id IN (?, ?, ?)", [testProd1Id, testProd2Id, testProd3Id]);
        await runSql("DELETE FROM product_inventory_counts WHERE product_id IN (?, ?, ?)", [testProd1Id, testProd2Id, testProd3Id]);
        await runSql("DELETE FROM product_expense_allocations WHERE product_id IN (?, ?, ?)", [testProd1Id, testProd2Id, testProd3Id]);
        await runSql("DELETE FROM product_status_history WHERE product_id IN (?, ?, ?)", [testProd1Id, testProd2Id, testProd3Id]);
        await runSql("DELETE FROM salla_product_mapping WHERE product_id IN (?, ?, ?)", [testProd1Id, testProd2Id, testProd3Id]);
        await runSql("DELETE FROM purchase_headers WHERE invoice_ref LIKE '%INV-2026%'");
        await runSql("DELETE FROM inventory_products WHERE id IN (?, ?, ?)", [testProd1Id, testProd2Id, testProd3Id]);
        await runSql("DELETE FROM expenses WHERE id = ?", [expenseId]);
        await runSql("DELETE FROM salla_imported_orders WHERE reference_id IN ('ORD_UNMAPPED_999', 'ORD_TEST_1001')");

        console.log("\n=================================================================");
        console.log(`✅ VERIFICATION COMPLETE: ALL ${passedTests}/${totalTests} TESTS PASSED!`);
        console.log("=================================================================\n");
        return true;
    } catch (err) {
        console.error("\n❌ VERIFICATION FAILED:", err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

if (require.main === module) {
    runBackendVerification();
}

module.exports = { runBackendVerification };
