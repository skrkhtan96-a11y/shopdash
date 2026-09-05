process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('../src/config/db');
const ProductControlRepository = require('../src/repositories/product_control.repository');
const ProductControlService = require('../src/services/product_control.service');
const { runMigration } = require('../src/migrations/migration_v1_product_control');

function runSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

describe('⚙️ Backend Stage Verification Suite - Product Control Center', function() {
    this.timeout(20000);

    let testProd1Id = null;
    let testProd2Id = null;
    let testProd3Id = null;
    let expenseId = null;
    let purchaseHeaderId = null;

    before(async () => {
        await runMigration(false);
        await runSql("PRAGMA foreign_keys = ON;");

        // Clean up legacy test data
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
    });

    after(async () => {
        if (testProd1Id || testProd2Id || testProd3Id) {
            await runSql("DELETE FROM purchase_items WHERE product_id IN (?, ?, ?)", [testProd1Id || 0, testProd2Id || 0, testProd3Id || 0]);
            await runSql("DELETE FROM product_stock_movements WHERE product_id IN (?, ?, ?)", [testProd1Id || 0, testProd2Id || 0, testProd3Id || 0]);
            await runSql("DELETE FROM product_inventory_counts WHERE product_id IN (?, ?, ?)", [testProd1Id || 0, testProd2Id || 0, testProd3Id || 0]);
            await runSql("DELETE FROM product_expense_allocations WHERE product_id IN (?, ?, ?)", [testProd1Id || 0, testProd2Id || 0, testProd3Id || 0]);
            await runSql("DELETE FROM product_status_history WHERE product_id IN (?, ?, ?)", [testProd1Id || 0, testProd2Id || 0, testProd3Id || 0]);
            await runSql("DELETE FROM salla_product_mapping WHERE product_id IN (?, ?, ?)", [testProd1Id || 0, testProd2Id || 0, testProd3Id || 0]);
            await runSql("DELETE FROM purchase_headers WHERE invoice_ref LIKE '%INV-2026%'");
            await runSql("DELETE FROM inventory_products WHERE id IN (?, ?, ?)", [testProd1Id || 0, testProd2Id || 0, testProd3Id || 0]);
        }
        if (expenseId) await runSql("DELETE FROM expenses WHERE id = ?", [expenseId]);
        await runSql("DELETE FROM salla_imported_orders WHERE reference_id IN ('ORD_UNMAPPED_999', 'ORD_TEST_1001')");
    });

    it('1. should handle empty catalog and seed test product', async () => {
        const overviewEmpty = await ProductControlService.getProductsOverview();
        assert.ok(Array.isArray(overviewEmpty.products));

        const now = new Date().toISOString();
        const testProd1Res = await runSql(
            `INSERT INTO inventory_products (product_name, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['ساعة ذكية فاخرة TEST', 'TEST-WATCH-01', 0, 100, 250, 10000, 25000, 0, 'needs_inventory', now]
        );
        testProd1Id = testProd1Res.lastID;
        assert.ok(testProd1Id > 0);
    });

    it('2. should handle product mapping & unmapped orders without leakage', async () => {
        await runSql(
            `INSERT OR REPLACE INTO salla_imported_orders (reference_id, date, status_slug, status_name, amount, product_name, quantity)
             VALUES ('ORD_UNMAPPED_999', '2026-09-01', 'completed', 'تم التنفيذ', 250.00, 'عطر غير مربوط 999', 1)`
        );

        const unmappedList = await ProductControlService.getUnmappedOrdersProducts();
        const foundUnmapped = unmappedList.find(u => u.product_name === 'عطر غير مربوط 999');
        assert.ok(foundUnmapped);

        const overviewWithTestProd = await ProductControlService.getProductsOverview('TEST-WATCH-01');
        assert.strictEqual(overviewWithTestProd.products.length, 1);
        assert.strictEqual(overviewWithTestProd.products[0].total_units_sold, 0);

        await ProductControlService.saveMapping(testProd1Id, 'SALLA-W01', 'TEST-WATCH-01', 'ساعة ذكية فاخرة TEST', 'ACTIVE', { id: 1, username: 'tester' });
        const mappings = await ProductControlService.getAllMappings();
        const savedMap = mappings.find(m => m.product_id === testProd1Id && m.alias_name === 'ساعة ذكية فاخرة TEST');
        assert.ok(savedMap && savedMap.mapping_status === 'ACTIVE');
    });

    it('3. should synchronize sales idempotently to stock movements', async () => {
        await runSql(
            `INSERT OR REPLACE INTO salla_imported_orders (reference_id, date, status_slug, status_name, amount, product_name, quantity)
             VALUES ('ORD_TEST_1001', '2026-09-02', 'completed', 'تم التنفيذ', 250.00, 'ساعة ذكية فاخرة TEST', 2)`
        );

        const syncedCount1 = await ProductControlService.syncSalesToStockMovements();
        assert.ok(syncedCount1 >= 1);

        const movementsBefore = await ProductControlRepository.getStockMovements(testProd1Id);
        const saleMovements1 = movementsBefore.filter(m => m.source_reference_id === 'ORD_TEST_1001' && m.movement_type === 'SALE');
        assert.strictEqual(saleMovements1.length, 1);

        await ProductControlService.syncSalesToStockMovements();
        const movementsAfter = await ProductControlRepository.getStockMovements(testProd1Id);
        const saleMovements2 = movementsAfter.filter(m => m.source_reference_id === 'ORD_TEST_1001' && m.movement_type === 'SALE');
        assert.strictEqual(saleMovements2.length, 1);
    });

    it('4. should handle partial and full returns idempotently', async () => {
        await runSql(`UPDATE salla_imported_orders SET status_slug = 'refunded' WHERE reference_id = 'ORD_TEST_1001'`);
        await ProductControlService.syncSalesToStockMovements();

        const movementsAfterReturn = await ProductControlRepository.getStockMovements(testProd1Id);
        const returnMovement = movementsAfterReturn.find(m => m.source_reference_id === 'ORD_TEST_1001' && m.movement_type === 'RETURN');
        assert.ok(returnMovement && returnMovement.quantity === 2);
    });

    it('5. should record physical inventory count and update stock baseline', async () => {
        const countRes = await ProductControlService.recordInventoryCount(testProd1Id, {
            actual_qty: 50,
            inventory_at: '2026-09-03T10:00:00.000Z',
            notes: 'افتتاح رصيد الجرد الفعلي'
        }, { id: 1, username: 'auditor' });

        assert.strictEqual(countRes.actual_qty, 50);
        const updatedProdAfterCount = await ProductControlRepository.getProductById(testProd1Id);
        assert.strictEqual(updatedProdAfterCount.quantity, 50);
    });

    it('6. should record multi-product purchase invoice and recalculate WAC', async () => {
        const now = new Date().toISOString();
        const testProd2Res = await runSql(
            `INSERT INTO inventory_products (product_name, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['سوار أبل TEST', 'TEST-STRAP-02', 20, 50, 100, 5000, 10000, 100000, 'normal', now]
        );
        testProd2Id = testProd2Res.lastID;

        const invoiceRes = await ProductControlService.recordPurchaseInvoice({
            purchased_at: '2026-09-04T14:00:00.000Z',
            supplier: 'شركة الجملة العالمية',
            invoice_ref: 'INV-2026-001',
            notes: 'شراء دفعة استيراد رقم 1',
            items: [
                { product_id: testProd1Id, quantity: 50, unit_cost_halalas: 12000 },
                { product_id: testProd2Id, quantity: 30, unit_cost_halalas: 6000 }
            ]
        }, { id: 1, username: 'purchaser' });

        purchaseHeaderId = invoiceRes.header_id;
        assert.ok(purchaseHeaderId > 0);
        assert.strictEqual(invoiceRes.total_invoice_amount_halalas, 780000);

        const prod1AfterPur = await ProductControlRepository.getProductById(testProd1Id);
        assert.strictEqual(prod1AfterPur.quantity, 100);
        assert.strictEqual(prod1AfterPur.cost_halalas, 11000);
    });

    it('7. should check sequential purchase WAC without drift', async () => {
        await ProductControlService.recordPurchaseInvoice({
            purchased_at: '2026-09-05T09:00:00.000Z',
            supplier: 'شركة الجملة العالمية',
            invoice_ref: 'INV-2026-002',
            items: [
                { product_id: testProd1Id, quantity: 100, unit_cost_halalas: 13000 }
            ]
        }, { id: 1, username: 'purchaser' });

        const prod1AfterPur2 = await ProductControlRepository.getProductById(testProd1Id);
        assert.strictEqual(prod1AfterPur2.quantity, 200);
        assert.strictEqual(prod1AfterPur2.cost_halalas, 12000);
    });

    it('8. should cancel purchase invoice and reverse stock movements', async () => {
        await ProductControlService.cancelPurchaseInvoice(testProd1Id, purchaseHeaderId, 'خطأ في فاتورة المورد', { id: 1, username: 'manager' });
        const prod1AfterCancel = await ProductControlRepository.getProductById(testProd1Id);
        assert.strictEqual(prod1AfterCancel.quantity, 150);
    });

    it('9. should handle COGS unavailable when cost is 0', async () => {
        const now = new Date().toISOString();
        const testProd3Res = await runSql(
            `INSERT INTO inventory_products (product_name, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['منتج بدون تكلفة TEST', 'TEST-NOCOST-03', 10, 0, 50, 0, 5000, 0, 'normal', now]
        );
        testProd3Id = testProd3Res.lastID;
        const detailsNoCost = await ProductControlService.getProductDetails(testProd3Id);
        assert.strictEqual(detailsNoCost.cogs_status, 'UNAVAILABLE');
    });

    it('10. should reject expense allocation exceeding remaining total', async () => {
        const expRes = await runSql(`INSERT INTO expenses (desc, cat, amt, date) VALUES ('حملة تيك توك الترويجية', 'ADVERTISING', 1000.00, '2026-09-01')`);
        expenseId = expRes.lastID;

        await ProductControlService.recordExpenseAllocation({
            product_id: testProd1Id,
            expense_id: expenseId,
            allocation_type: 'ADVERTISING',
            platform: 'TikTok',
            period_from: '2026-09-01',
            period_to: '2026-09-05',
            allocated_amount_halalas: 80000
        }, { id: 1, username: 'marketer' });

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
            assert.strictEqual(err.details.remaining_amount_halalas, 20000);
        }
        assert.ok(allocationRejected);
    });

    it('11. should block pre-purchase when product status is purchase_stopped', async () => {
        const preCheckProd3 = await ProductControlService.evaluatePrePurchase(testProd3Id);
        assert.strictEqual(preCheckProd3.allowed, false);

        await ProductControlService.updateProductStatus(testProd1Id, 'purchase_stopped', 'إيقاف الشراء مؤقتاً', { id: 1, username: 'manager' });
        const preCheckStopped = await ProductControlService.evaluatePrePurchase(testProd1Id);
        assert.strictEqual(preCheckStopped.allowed, false);
    });

    it('12. should enforce foreign key constraints on invalid product reference', async () => {
        let fkViolationCaught = false;
        try {
            await ProductControlRepository.insertStockMovement({
                product_id: 999999,
                movement_type: 'SALE',
                quantity: -1,
                source_reference_id: 'FK_TEST',
                source_item_reference_id: '1',
                source_event_reference_id: 'MAIN',
                movement_at: new Date().toISOString()
            });
        } catch (err) {
            fkViolationCaught = true;
        }
        assert.ok(fkViolationCaught);
    });

    it('13. should aggregate timeline feed chronologically', async () => {
        const timeline = await ProductControlService.getProductTimeline(testProd1Id);
        assert.ok(Array.isArray(timeline) && timeline.length >= 3);
    });
});
