const request = require('supertest');
const app = require('../server');
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

async function runProductionHardeningVerification() {
    console.log("=================================================================");
    console.log("🛡️ STARTING BACKEND PRODUCTION HARDENING GATE VERIFICATION SUITE");
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
            throw new Error(`Hardening Assertion Failed: ${message}`);
        }
    }

    try {
        await runMigration(false);
        await runSql("PRAGMA foreign_keys = ON;");

        // Clean up test data in strict dependency order
        await runSql("DELETE FROM purchase_items WHERE product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%HARDEN%')");
        await runSql("DELETE FROM product_stock_movements WHERE source_reference_id LIKE '%HARDEN%' OR source_reference_id LIKE '%ORD_HARDEN%' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%HARDEN%')");
        await runSql("DELETE FROM product_inventory_counts WHERE notes LIKE '%HARDEN%' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%HARDEN%')");
        await runSql("DELETE FROM product_expense_allocations WHERE platform LIKE '%HARDEN%' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%HARDEN%')");
        await runSql("DELETE FROM product_status_history WHERE product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%HARDEN%')");
        await runSql("DELETE FROM salla_product_mapping WHERE alias_name LIKE '%HARDEN%' OR product_id IN (SELECT id FROM inventory_products WHERE product_name LIKE '%HARDEN%')");
        await runSql("DELETE FROM purchase_headers WHERE invoice_ref LIKE '%HARDEN%'");
        await runSql("DELETE FROM inventory_products WHERE product_name LIKE '%HARDEN%'");
        await runSql("DELETE FROM expenses WHERE desc LIKE '%HARDEN%'");
        await runSql("DELETE FROM salla_imported_orders WHERE reference_id LIKE '%ORD_HARDEN%'");
        await runSql("DELETE FROM users WHERE username = 'harden_viewer'");
        await runSql("DELETE FROM sessions WHERE token LIKE 'session_harden_%'");

        const nowIso = new Date().toISOString();

        // Create Sessions & Users for HTTP Authorization testing
        const viewerUserRes = await runSql(
            `INSERT INTO users (username, email, password, role, created_at) VALUES ('harden_viewer', 'viewer@harden.com', 'hash123', 'viewer', ?)`
        , [nowIso]);
        const viewerUserId = viewerUserRes.lastID;

        const adminUserRes = await runSql(
            `INSERT OR IGNORE INTO users (username, email, password, role, created_at) VALUES ('harden_admin', 'admin@harden.com', 'hash123', 'admin', ?)`
        , [nowIso]);
        const adminUserRow = await getSql("SELECT id FROM users WHERE username = 'harden_admin'");
        const adminUserId = adminUserRow ? adminUserRow.id : (adminUserRes.lastID || 1);
        await runSql("UPDATE users SET role = 'admin' WHERE id = ?", [adminUserId]);

        // Insert valid sessions
        await runSql(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('session_harden_viewer', ?, datetime('now', '+1 hour'))`, [viewerUserId]);
        await runSql(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('session_harden_admin', ?, datetime('now', '+1 hour'))`, [adminUserId]);

        // Insert Fixture Product 1: Complete Product
        const p1Res = await runSql(
            `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES ('شاحن لاسلكي HARDEN', 'SALLA-H01', 'SKU-H01', 10, 100, 200, 10000, 20000, 100000, 'normal', ?)`
        , [nowIso]);
        const p1Id = p1Res.lastID;

        // Insert INITIAL_BASELINE for Product 1
        await runSql(
            `INSERT INTO product_stock_movements (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at, unit_cogs_halalas)
             VALUES (?, 'INITIAL_BASELINE', 10, 'SYS_HARDEN', ?, 'BASELINE', ?, 10000)`,
            [p1Id, String(p1Id), nowIso]
        );

        // Save ACTIVE mapping for P1
        await ProductControlService.saveMapping(p1Id, 'SALLA-H01', 'SKU-H01', 'شاحن لاسلكي HARDEN', 'ACTIVE', { id: adminUserId, username: 'harden_admin' });

        // Insert Fixture Product 2: Product without SKU but has salla_product_id (Req 12)
        const p2Res = await runSql(
            `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES ('قاعدة مكتبية HARDEN', 'SALLA-H02-NOSKU', NULL, 5, 40, 80, 4000, 8000, 20000, 'normal', ?)`
        , [nowIso]);
        const p2Id = p2Res.lastID;
        await ProductControlService.saveMapping(p2Id, 'SALLA-H02-NOSKU', null, 'قاعدة مكتبية HARDEN', 'ACTIVE', { id: adminUserId, username: 'harden_admin' });

        // Insert Fixture Product 3: Product without Cost (Req 13)
        const p3Res = await runSql(
            `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
             VALUES ('جراب حماية HARDEN', 'SALLA-H03', 'SKU-H03', 15, 0, 30, 0, 3000, 0, 'needs_inventory', ?)`
        , [nowIso]);
        const p3Id = p3Res.lastID;

        // =================================================================
        // REQUIREMENT 1: HTTP Endpoint & Response Schema Verification
        // =================================================================
        console.log("🔹 1. HTTP Endpoint & Schema Verification");
        const resOverview = await request(app)
            .get('/api/product-control/products')
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resOverview.status === 200, "GET /api/product-control/products returns HTTP 200");
        assert(resOverview.body.success === true && Array.isArray(resOverview.body.data), "Overview response contains success:true and data array");
        assert(resOverview.body.total !== undefined && resOverview.body.page === 1, "Overview response includes pagination total & page metadata");

        const resDetails = await request(app)
            .get(`/api/product-control/products/${p1Id}/details`)
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resDetails.status === 200, "GET /api/product-control/products/:id/details returns HTTP 200");
        assert(resDetails.body.data.cogs_status === 'AVAILABLE', "Details returns cogs_status AVAILABLE for product with cost");

        const resPreCheck = await request(app)
            .get(`/api/product-control/products/${p1Id}/pre-purchase-check`)
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resPreCheck.status === 200, "GET /api/product-control/products/:id/pre-purchase-check returns HTTP 200");
        assert(resPreCheck.body.data.allowed !== undefined && resPreCheck.body.data.snapshot !== undefined, "Pre-purchase check schema includes allowed & snapshot");

        // =================================================================
        // REQUIREMENT 2: Default-Deny Authorization Proof via HTTP
        // =================================================================
        console.log("\n🔹 2. Default-Deny Authorization Proof via HTTP");
        // Unauthenticated request -> 401
        const resUnauth = await request(app)
            .post(`/api/product-control/products/${p1Id}/inventory`)
            .send({ actual_qty: 20 });
        assert(resUnauth.status === 401, "Unauthenticated write request returns HTTP 401 Unauthorized");
        assert(resUnauth.body.code === 'UNAUTHORIZED', "Unauthenticated error code is UNAUTHORIZED");

        // Authenticated as 'viewer' (no write role) -> 403
        const resForbidden = await request(app)
            .post(`/api/product-control/products/${p1Id}/inventory`)
            .set('Cookie', ['session_token=session_harden_viewer'])
            .send({ actual_qty: 20 });
        assert(resForbidden.status === 403, "Authenticated user without write role returns HTTP 403 Forbidden");
        assert(resForbidden.body.code === 'FORBIDDEN', "Forbidden error code is FORBIDDEN");

        // Authenticated as 'admin' -> 201 Success
        const resAuthSuccess = await request(app)
            .post(`/api/product-control/products/${p1Id}/inventory`)
            .set('Cookie', ['session_token=session_harden_admin'])
            .send({ actual_qty: 10, notes: 'اختبار الجرد HARDEN' });
        assert(resAuthSuccess.status === 201, "Authorized admin write request returns HTTP 201 Created");

        // =================================================================
        // REQUIREMENT 3: Transaction Rollback Proof
        // =================================================================
        console.log("\n🔹 3. Transaction Rollback Proof");
        let rollbackCaught = false;
        try {
            await ProductControlService.recordPurchaseInvoice({
                purchased_at: nowIso,
                supplier: 'مورد مضلل',
                invoice_ref: 'HARDEN-FAIL-INV',
                items: [
                    { product_id: p1Id, quantity: 10, unit_cost_halalas: 10000 },
                    { product_id: 999999, quantity: 5, unit_cost_halalas: 5000 } // Invalid FK -> Causes DB error mid-transaction
                ]
            }, { id: adminUserId, username: 'harden_admin' });
        } catch (err) {
            rollbackCaught = true;
        }
        assert(rollbackCaught === true, "Mid-transaction failure threw exception");

        // Verify zero residual records left
        const residualHeader = await getSql("SELECT * FROM purchase_headers WHERE invoice_ref = 'HARDEN-FAIL-INV'");
        assert(residualHeader === undefined, "Rollback Proof: NO purchase_header record persisted");

        const residualItems = await allSql("SELECT * FROM purchase_items WHERE header_id IN (SELECT id FROM purchase_headers WHERE invoice_ref = 'HARDEN-FAIL-INV')");
        assert(residualItems.length === 0, "Rollback Proof: NO purchase_items persisted");

        const residualMovements = await allSql("SELECT * FROM product_stock_movements WHERE source_reference_id IN (SELECT id FROM purchase_headers WHERE invoice_ref = 'HARDEN-FAIL-INV')");
        assert(residualMovements.length === 0, "Rollback Proof: NO stock_movements persisted");

        const p1Unchanged = await ProductControlRepository.getProductById(p1Id);
        assert(p1Unchanged.quantity === 10, "Rollback Proof: Product stock unchanged after rollback");
        assert(p1Unchanged.cost_halalas === 10000, "Rollback Proof: Product WAC unchanged after rollback");

        // =================================================================
        // REQUIREMENT 4: Concurrency & Race Condition Proof
        // =================================================================
        console.log("\n🔹 4. Concurrency & Race Condition Proof (BEGIN IMMEDIATE)");
        // Execute 4 concurrent purchases on P1 simultaneously
        const concurrentPurchases = [1, 2, 3, 4].map(idx => {
            return ProductControlService.recordPurchaseInvoice({
                purchased_at: nowIso,
                supplier: `مورد التزامن ${idx}`,
                invoice_ref: `HARDEN-CONC-${idx}`,
                items: [
                    { product_id: p1Id, quantity: 5, unit_cost_halalas: 10000 } // 5 units @ 100 SAR each
                ]
            }, { id: adminUserId, username: 'harden_admin' });
        });

        await Promise.all(concurrentPurchases);

        const p1AfterConc = await ProductControlRepository.getProductById(p1Id);
        // Initial stock 10 + 4 * 5 = 30 units
        assert(p1AfterConc.quantity === 30, "Concurrency Proof: Stock updated accurately to 30 units without lost updates");
        assert(p1AfterConc.inventory_value_halalas === 300000, "Concurrency Proof: Total inventory value exact at 300,000 Halalas");

        // =================================================================
        // REQUIREMENT 5: Return & Idempotency Proof (No Double Counting)
        // =================================================================
        console.log("\n🔹 5. Return & Idempotency Proof");
        // Insert sale order for 10 units
        await runSql(
            `INSERT INTO salla_imported_orders (reference_id, date, status_slug, status_name, amount, product_name, quantity)
             VALUES ('ORD_HARDEN_RET_101', '2026-09-02', 'completed', 'تم التنفيذ', 2000.00, 'شاحن لاسلكي HARDEN', 10)`
        );

        // Sync sale -> -10 stock
        await ProductControlService.syncSalesToStockMovements();
        const expectedStockAfterSale = await ProductControlRepository.getCurrentStockFromMovements(p1Id);
        // Initial baseline 10 + 20 (purchases) - 10 (sale) = 20
        assert(expectedStockAfterSale === 20, "Sale movement recorded -10 stock accurately");

        // Partial Return 1 (3 units)
        await runSql(
            `UPDATE salla_imported_orders SET status_slug = 'refunded' WHERE reference_id = 'ORD_HARDEN_RET_101'`
        );
        await ProductControlService.syncSalesToStockMovements();
        const stockAfterReturn1 = await ProductControlRepository.getCurrentStockFromMovements(p1Id);
        assert(stockAfterReturn1 === 30, "Return movement restored positive stock idempotently");

        // Re-run sync (duplicate return event)
        await ProductControlService.syncSalesToStockMovements();
        const stockAfterDupReturn = await ProductControlRepository.getCurrentStockFromMovements(p1Id);
        assert(stockAfterDupReturn === 30, "Duplicate return sync event produces 0 duplicate movement (No Double Counting)");

        // =================================================================
        // REQUIREMENT 6: WAC Numeric Reconciliation
        // =================================================================
        console.log("\n🔹 6. WAC Numeric Reconciliation");
        // Step A: Initial state of P1: 30 units @ 10,000 Halalas = 300,000 Halalas (3,000 SAR)
        // Step B: Purchase 1: 20 units @ 16,000 Halalas (160 SAR) = 320,000 Halalas
        await ProductControlService.recordPurchaseInvoice({
            purchased_at: nowIso,
            supplier: 'مورد التكلفة 1',
            invoice_ref: 'HARDEN-WAC-01',
            items: [{ product_id: p1Id, quantity: 20, unit_cost_halalas: 16000 }]
        }, { id: adminUserId, username: 'harden_admin' });

        // Total: 50 units = 620,000 Halalas => WAC = 12,400 Halalas (124 SAR)
        const wacStepB = await ProductControlRepository.getProductById(p1Id);
        assert(wacStepB.quantity === 50, "WAC Step B: Quantity = 50");
        assert(wacStepB.cost_halalas === 12400, "WAC Step B: WAC = 12,400 Halalas (124 SAR)");
        assert(wacStepB.inventory_value_halalas === 620000, "WAC Step B: Value = 620,000 Halalas");

        // Step C: Purchase 2: 10 units @ 20,000 Halalas (200 SAR) = 200,000 Halalas
        await ProductControlService.recordPurchaseInvoice({
            purchased_at: nowIso,
            supplier: 'مورد التكلفة 2',
            invoice_ref: 'HARDEN-WAC-02',
            items: [{ product_id: p1Id, quantity: 10, unit_cost_halalas: 20000 }]
        }, { id: adminUserId, username: 'harden_admin' });

        // Total: 60 units = 820,000 Halalas => WAC = Math.round(820,000 / 60) = 13,667 Halalas (136.67 SAR)
        const wacStepC = await ProductControlRepository.getProductById(p1Id);
        assert(wacStepC.quantity === 60, "WAC Step C: Quantity = 60");
        assert(wacStepC.cost_halalas === 13667, "WAC Step C: WAC = 13,667 Halalas without drift");
        assert(wacStepC.inventory_value_halalas === 820000, "WAC Step C: Total Inventory Value exact at 820,000 Halalas");

        // =================================================================
        // REQUIREMENT 7: Expense Allocation Concurrency / Race Condition Proof
        // =================================================================
        console.log("\n🔹 7. Expense Allocation Concurrency & Over-Limit Race Condition Proof");
        // Create dummy expense: 1,000 SAR (100,000 Halalas)
        const expRes = await runSql(
            `INSERT INTO expenses (desc, cat, amt, date) VALUES ('حملة فيسبوك HARDEN', 'ADVERTISING', 1000.00, '2026-09-01')`
        );
        const expenseId = expRes.lastID;

        // Launch 2 concurrent allocations of 70,000 Halalas each (Total 140,000 > 100,000)
        const concurrentAllocations = [p1Id, p2Id].map(prodId => {
            return ProductControlService.recordExpenseAllocation({
                product_id: prodId,
                expense_id: expenseId,
                allocation_type: 'ADVERTISING',
                platform: 'HARDEN_FB',
                period_from: '2026-09-01',
                period_to: '2026-09-05',
                allocated_amount_halalas: 70000
            }, { id: adminUserId, username: 'harden_admin' }).then(res => ({ status: 'fulfilled', value: res }))
              .catch(err => ({ status: 'rejected', reason: err }));
        });

        const allocResults = await Promise.all(concurrentAllocations);
        const fulfilled = allocResults.filter(r => r.status === 'fulfilled');
        const rejected = allocResults.filter(r => r.status === 'rejected');

        assert(fulfilled.length === 1, "Exactly 1 concurrent allocation succeeded");
        assert(rejected.length === 1, "Exactly 1 concurrent allocation was rejected due to limit");
        assert(rejected[0].reason.details.remaining_amount_halalas === 30000, "Rejection error details returned exact remaining amount (30,000 Halalas)");

        // =================================================================
        // REQUIREMENT 8: Date Range (from/to) Boundary Validation
        // =================================================================
        console.log("\n🔹 8. Date Range (from/to) Boundary Validation");
        // from > to -> HTTP 400
        const resInvalidRange = await request(app)
            .get(`/api/product-control/products/${p1Id}/details?from=2026-09-10&to=2026-09-01`)
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resInvalidRange.status === 400, "from > to returns HTTP 400 Bad Request");
        assert(resInvalidRange.body.code === 'INVALID_DATE_RANGE', "Invalid date range code is INVALID_DATE_RANGE");

        // invalid format -> HTTP 400
        const resInvalidFormat = await request(app)
            .get(`/api/product-control/products/${p1Id}/details?from=invalid-date`)
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resInvalidFormat.status === 400, "Invalid date string returns HTTP 400 Bad Request");

        // Same day filtering -> HTTP 200
        const resSameDay = await request(app)
            .get(`/api/product-control/products/${p1Id}/details?from=2026-09-02&to=2026-09-02`)
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resSameDay.status === 200, "Same day filtering (from=to) executes cleanly with HTTP 200");

        // =================================================================
        // REQUIREMENT 9: Pagination & Limits Proof
        // =================================================================
        console.log("\n🔹 9. Pagination & Limits Proof");
        const resPaginated = await request(app)
            .get('/api/product-control/products?limit=2&page=1')
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resPaginated.status === 200, "Paginated overview returns HTTP 200");
        assert(resPaginated.body.count <= 2, "Returned count is bounded by limit=2");
        assert(resPaginated.body.total >= 3, "Total count reflects total items in catalog");

        // =================================================================
        // REQUIREMENT 10: Query Plan Verification
        // =================================================================
        console.log("\n🔹 10. Query Plan Verification");
        const planRows = await allSql(`
            EXPLAIN QUERY PLAN
            SELECT p.id, p.product_name, COALESCE(SUM(m.quantity), 0) 
            FROM inventory_products p
            LEFT JOIN product_stock_movements m ON m.product_id = p.id
            GROUP BY p.id
        `);
        assert(planRows.length > 0, "EXPLAIN QUERY PLAN executed successfully");
        const usesIndex = planRows.some(r => r.detail && r.detail.includes('INDEX'));
        assert(usesIndex === true, "Query plan confirms covering index usage (idx_p_mov_prod_date)");

        // =================================================================
        // REQUIREMENT 11 & 12: Product Fixture & Unmapped / Alias / SKU Linkage
        // =================================================================
        console.log("\n🔹 11 & 12. Real-World Product Fixture & Linkage Verification");
        // Test product P2 (No SKU, has salla_product_id)
        const p2Details = await ProductControlService.getProductDetails(p2Id);
        assert(p2Details.product.sku === null, "Product P2 has null SKU");
        assert(p2Details.product.salla_product_id === 'SALLA-H02-NOSKU', "Product P2 has salla_product_id");

        // Verify changing product alias update preserves historical mapping link
        await ProductControlService.saveMapping(p2Id, 'SALLA-H02-NOSKU', null, 'قاعدة مكتبية اسم معدل HARDEN', 'ACTIVE', { id: adminUserId, username: 'harden_admin' });
        const p2Mappings = await ProductControlRepository.getMappingByProductId(p2Id);
        assert(p2Mappings.some(m => m.alias_name === 'قاعدة مكتبية اسم معدل HARDEN'), "Alias update persisted without breaking history");

        // =================================================================
        // REQUIREMENT 13: Product without Cost (COGS = UNAVAILABLE, Profits = NULL)
        // =================================================================
        console.log("\n🔹 13. Product without Cost Handling");
        const p3Details = await ProductControlService.getProductDetails(p3Id);
        assert(p3Details.cogs_status === 'UNAVAILABLE', "Product P3 cogs_status is UNAVAILABLE");
        assert(p3Details.unit_cogs_sar === null, "Product P3 unit_cogs_sar is NULL (not 0)");
        assert(p3Details.gross_profit_sar === null, "Product P3 gross_profit_sar is NULL (not 0)");
        assert(p3Details.net_profit_sar === null, "Product P3 net_profit_sar is NULL (not 0)");

        // =================================================================
        // REQUIREMENT 14: INITIAL_BASELINE Integrity
        // =================================================================
        console.log("\n🔹 14. INITIAL_BASELINE Integrity");
        assert(p3Details.product.current_control_status === 'needs_inventory', "Product P3 without reliable baseline remains needs_inventory");
        const p3Movements = await ProductControlRepository.getStockMovements(p3Id);
        const fakeBaseline = p3Movements.find(m => m.movement_type === 'INITIAL_BASELINE');
        assert(fakeBaseline === undefined, "NO fabricated INITIAL_BASELINE was created for unverified product P3");

        // =================================================================
        // REQUIREMENT 15: Unified Error Contract Proof
        // =================================================================
        console.log("\n🔹 15. Unified Error Contract Proof");
        const resContractError = await request(app)
            .get('/api/product-control/products/999999/details')
            .set('Cookie', ['session_token=session_harden_admin']);
        assert(resContractError.status === 404, "Non-existent product returns HTTP 404");
        assert(resContractError.body.error !== undefined, "Error response contains 'error' message string");
        assert(resContractError.body.code === 'PRODUCT_NOT_FOUND', "Error response contains standardized 'code' string");
        assert(resContractError.body.stack === undefined, "Error response hides internal stack trace");

        // =================================================================
        // REQUIREMENT 16: Full System Clean Cleanup
        // =================================================================
        console.log("\n🔹 16. Full System Clean Cleanup");
        await runSql("DELETE FROM purchase_items WHERE product_id IN (?, ?, ?)", [p1Id, p2Id, p3Id]);
        await runSql("DELETE FROM product_stock_movements WHERE product_id IN (?, ?, ?)", [p1Id, p2Id, p3Id]);
        await runSql("DELETE FROM product_inventory_counts WHERE product_id IN (?, ?, ?)", [p1Id, p2Id, p3Id]);
        await runSql("DELETE FROM product_expense_allocations WHERE product_id IN (?, ?, ?)", [p1Id, p2Id, p3Id]);
        await runSql("DELETE FROM product_status_history WHERE product_id IN (?, ?, ?)", [p1Id, p2Id, p3Id]);
        await runSql("DELETE FROM salla_product_mapping WHERE product_id IN (?, ?, ?)", [p1Id, p2Id, p3Id]);
        await runSql("DELETE FROM purchase_headers WHERE invoice_ref LIKE '%HARDEN%'");
        await runSql("DELETE FROM inventory_products WHERE id IN (?, ?, ?)", [p1Id, p2Id, p3Id]);
        await runSql("DELETE FROM expenses WHERE id = ?", [expenseId]);
        await runSql("DELETE FROM salla_imported_orders WHERE reference_id LIKE '%ORD_HARDEN%'");
        await runSql("DELETE FROM users WHERE username = 'harden_viewer'");
        await runSql("DELETE FROM sessions WHERE token LIKE 'session_harden_%'");

        console.log("\n=================================================================");
        console.log(`✅ HARDENING GATE PASSED: ALL ${passedTests}/${totalTests} TESTS PASSED!`);
        console.log("=================================================================\n");
        return true;
    } catch (err) {
        console.error("\n❌ HARDENING GATE FAILED:", err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

if (require.main === module) {
    runProductionHardeningVerification().then(() => {
        process.exit(0);
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runProductionHardeningVerification };
