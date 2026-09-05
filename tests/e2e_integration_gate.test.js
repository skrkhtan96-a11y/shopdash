process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const app = require('../server');
const { db, hashPassword } = require('../database');
const { runMigration } = require('../src/migrations/migration_v1_product_control');
const ProductControlRepository = require('../src/repositories/product_control.repository');
const ProductControlService = require('../src/services/product_control.service');
const CurrencyUtil = require('../src/utils/currency');

describe('🚀 End-to-End Integration Gate Test Suite - Product Control Center', function() {
    this.timeout(20000);

    let server;
    let adminCookie = '';
    let employeeCookie = '';
    let testProductId = null;
    let unmappedProductId = null;

    before((done) => {
        server = app.listen(0, async () => {
            try {
                // 1. Run database migration
                await runMigration(false);

                // 2. Seed admin and employee users
                const adminHash = hashPassword('AdminE2EPass123!');
                const empHash = hashPassword('EmpE2EPass123!');

                db.run("INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['e2e_admin', 'e2e_admin@test.local', adminHash, 'admin', '2026-09-01']);
                db.run("INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['e2e_employee', 'e2e_emp@test.local', empHash, 'employee', '2026-09-01'],
                    (err) => {
                        if (err) return done(err);

                        // Login admin
                        request(server)
                            .post('/api/auth/login')
                            .send({ login: 'e2e_admin', password: 'AdminE2EPass123!' })
                            .end((errLogin, res) => {
                                if (errLogin) return done(errLogin);
                                const cookies = res.headers['set-cookie'];
                                if (cookies) adminCookie = cookies[0];

                                // Login employee
                                request(server)
                                    .post('/api/auth/login')
                                    .send({ login: 'e2e_employee', password: 'EmpE2EPass123!' })
                                    .end(async (errEmpLogin, resEmp) => {
                                        if (errEmpLogin) return done(errEmpLogin);
                                        const empCookies = resEmp.headers['set-cookie'];
                                        if (empCookies) employeeCookie = empCookies[0];

                                        try {
                                            // Seed main test product
                                            const resP = await ProductControlRepository.runSql(
                                                `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                                                 VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'needs_inventory', datetime('now'))`,
                                                ['شاشة ألعاب 4K E2E', 'SALLA-E2E-999', 'SKU-E2E-999']
                                            );
                                            testProductId = resP.lastID;

                                            // Seed product for UNMAPPED testing
                                            const resUnmapped = await ProductControlRepository.runSql(
                                                `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                                                 VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'needs_inventory', datetime('now'))`,
                                                ['منتج غير مرتبط UNMAPPED', 'SALLA-UNMAPPED-1', 'SKU-UNMAPPED-1']
                                            );
                                            unmappedProductId = resUnmapped.lastID;

                                            // Create active mapping for testProductId
                                            await ProductControlRepository.upsertMapping(
                                                testProductId,
                                                'SALLA-E2E-999',
                                                'SKU-E2E-999',
                                                'شاشة ألعاب 4K E2E',
                                                'ACTIVE'
                                            );

                                            done();
                                        } catch (eP) {
                                            done(eP);
                                        }
                                    });
                            });
                    });
            } catch (e) {
                done(e);
            }
        });
    });

    after((done) => {
        server.close(done);
    });

    // =========================================================================
    // 1. Mandatory End-to-End Lifecycle Scenario
    // =========================================================================
    describe('1. Main Mandatory Lifecycle Scenario & Reconciliation', () => {

        it('Step 1: Record initial inventory count (10 units)', async () => {
            const countRes = await request(server)
                .post(`/api/product-control/products/${testProductId}/inventory-counts`)
                .set('Cookie', adminCookie)
                .send({
                    actual_qty: 10,
                    inventory_at: '2026-09-05T09:00:00Z',
                    notes: 'E2E Initial Inventory Count'
                })
                .expect(200);

            assert.strictEqual(countRes.body.success, true);

            // Database Verification
            const dbProduct = await ProductControlRepository.getProductById(testProductId);
            assert.strictEqual(dbProduct.quantity, 10);
            assert.strictEqual(dbProduct.current_control_status, 'normal');

            // API Verification
            const apiRes = await request(server)
                .get(`/api/product-control/products/${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(apiRes.body.data.product.quantity, 10);
            assert.strictEqual(apiRes.body.data.metrics.expected_stock, 10);
        });

        it('Step 2: Purchase 20 units @ 50.00 SAR (Total stock = 30, WAC = 50.00 SAR)', async () => {
            const purRes = await request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', adminCookie)
                .send({
                    purchased_at: '2026-09-05T10:00:00Z',
                    supplier_name: 'المورد الرئيسي E2E',
                    invoice_ref: 'INV-E2E-001',
                    items: [
                        {
                            product_id: testProductId,
                            quantity: 20,
                            unit_cost_sar: 50.00
                        }
                    ]
                })
                .expect(200);

            assert.strictEqual(purRes.body.success, true);

            // Database Reconciliation
            const dbProduct = await ProductControlRepository.getProductById(testProductId);
            assert.strictEqual(dbProduct.quantity, 30);
            assert.strictEqual(dbProduct.cost_halalas, 5000); // 50.00 SAR
            assert.strictEqual(dbProduct.inventory_value_halalas, 100000); // 20 units @ 50 SAR + 10 units @ 0 SAR = 1000 SAR

            // API Reconciliation
            const apiRes = await request(server)
                .get(`/api/product-control/products/${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(apiRes.body.data.product.quantity, 30);
            assert.strictEqual(apiRes.body.data.unit_cogs_sar, 50.00);
            assert.strictEqual(apiRes.body.data.cogs_status, 'AVAILABLE');
        });

        it('Step 3 & 4: Import Sale (8 units) and Partial Return (2 units) & Sync Sales', async () => {
            // Import Salla Order (8 units @ 100 SAR)
            await ProductControlRepository.runSql(
                `INSERT INTO salla_imported_orders (reference_id, date, status_slug, product_name, quantity, amount)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                ['ORDER-E2E-1001', '2026-09-05', 'completed', 'شاشة ألعاب 4K E2E', 8, 800.00]
            );

            // Import Salla Partial Return (2 units)
            await ProductControlRepository.runSql(
                `INSERT INTO salla_imported_orders (reference_id, date, status_slug, product_name, quantity, amount)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                ['ORDER-E2E-1001-RET', '2026-09-05', 'refunded', 'شاشة ألعاب 4K E2E', 2, 200.00]
            );

            // Trigger Sales Sync
            const syncRes = await request(server)
                .post('/api/product-control/sync-sales')
                .set('Cookie', adminCookie)
                .expect(200);

            assert.ok(syncRes.body.synced_movements >= 2);

            // Database Reconciliation
            const movements = await ProductControlRepository.getStockMovements(testProductId);
            const saleMov = movements.find(m => m.movement_type === 'SALE');
            const retMov = movements.find(m => m.movement_type === 'RETURN');

            assert.ok(saleMov);
            assert.strictEqual(saleMov.quantity, -8);
            assert.strictEqual(saleMov.unit_cogs_halalas, 5000);

            assert.ok(retMov);
            assert.strictEqual(retMov.quantity, 2);
            assert.strictEqual(retMov.unit_cogs_halalas, 5000);

            const expectedStock = await ProductControlRepository.getCurrentStockFromMovements(testProductId);
            assert.strictEqual(expectedStock, 24); // 10 + 20 - 8 + 2 = 24

            // API Reconciliation
            const apiRes = await request(server)
                .get(`/api/product-control/products/${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(apiRes.body.data.metrics.expected_stock, 24);
        });

        it('Step 5 & 6: Allocate Advertising (100 SAR) and Other Expense (25 SAR)', async () => {
            // Create legacy expense 1: Advertising
            const expAdId = await new Promise((resolve, reject) => {
                db.run(
                    "INSERT INTO expenses (desc, cat, amt, date) VALUES (?, ?, ?, ?)",
                    ['حملة تسويقية ترويجية E2E', 'تسويق', 200.00, '2026-09-05'],
                    function(err) { if (err) reject(err); else resolve(this.lastID); }
                );
            });

            // Create legacy expense 2: Other
            const expOtherId = await new Promise((resolve, reject) => {
                db.run(
                    "INSERT INTO expenses (desc, cat, amt, date) VALUES (?, ?, ?, ?)",
                    ['مصاريف تغليف وشحن E2E', 'مصاريف تشغيلية', 50.00, '2026-09-05'],
                    function(err) { if (err) reject(err); else resolve(this.lastID); }
                );
            });

            // Allocate Ad Expense (100 SAR)
            await request(server)
                .post('/api/product-control/expenses/allocate')
                .set('Cookie', adminCookie)
                .send({
                    expense_id: expAdId,
                    product_id: testProductId,
                    amount_sar: 100.00,
                    allocation_type: 'ADVERTISING',
                    platform: 'Snapchat',
                    campaign_name: 'Camp 4K'
                })
                .expect(200);

            // Allocate Other Expense (25 SAR)
            await request(server)
                .post('/api/product-control/expenses/allocate')
                .set('Cookie', adminCookie)
                .send({
                    expense_id: expOtherId,
                    product_id: testProductId,
                    amount_sar: 25.00,
                    allocation_type: 'OTHER',
                    notes: 'Packaging'
                })
                .expect(200);

            // Database Reconciliation
            const adSum = await ProductControlRepository.getExpenseAllocatedSum(expAdId);
            const otherSum = await ProductControlRepository.getExpenseAllocatedSum(expOtherId);

            assert.strictEqual(adSum, 10000); // 100 SAR
            assert.strictEqual(otherSum, 2500); // 25 SAR
        });

        it('Step 7: Final Inventory Count with Variance (Pre-count Expected: 24, Actual: 22, Variance: -2)', async () => {
            const countRes = await request(server)
                .post(`/api/product-control/products/${testProductId}/inventory-counts`)
                .set('Cookie', adminCookie)
                .send({
                    actual_qty: 22,
                    inventory_at: '2026-09-05T18:00:00Z',
                    notes: 'E2E Final Inventory Count'
                })
                .expect(200);

            assert.strictEqual(countRes.body.data.variance, -2);
            assert.strictEqual(countRes.body.data.status, 'under_review');

            // Database Reconciliation
            const dbProduct = await ProductControlRepository.getProductById(testProductId);
            assert.strictEqual(dbProduct.quantity, 22);
            assert.strictEqual(dbProduct.current_control_status, 'under_review');

            const lastInv = await ProductControlRepository.getLastInventory(testProductId);
            assert.strictEqual(lastInv.actual_qty, 22);
            assert.strictEqual(lastInv.variance, -2);
            assert.strictEqual(lastInv.expected_qty_at_count, 24);

            // API Details Reconciliation
            const apiRes = await request(server)
                .get(`/api/product-control/products/${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(apiRes.body.data.metrics.expected_stock_before_last_count, 24);
            assert.strictEqual(apiRes.body.data.metrics.last_inventory_actual_qty, 22);
            assert.strictEqual(apiRes.body.data.metrics.last_inventory_variance, -2);
            assert.strictEqual(apiRes.body.data.metrics.current_expected_stock, 22);

            // API Overview Reconciliation
            const overviewRes = await request(server)
                .get('/api/product-control/products?q=SKU-E2E-999')
                .set('Cookie', adminCookie)
                .expect(200);

            const prodItem = overviewRes.body.data[0];
            assert.strictEqual(prodItem.current_stock, 22);
            assert.strictEqual(prodItem.last_inventory_actual, 22);
            assert.strictEqual(prodItem.last_inventory_variance, -2);
        });

        it('Step 8: Next sale of 1 unit after count (Expected stock becomes 21)', async () => {
            // Import Salla Order for 1 unit
            await ProductControlRepository.runSql(
                `INSERT INTO salla_imported_orders (reference_id, date, status_slug, product_name, quantity, amount)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                ['ORDER-E2E-1002', '2026-09-05', 'completed', 'شاشة ألعاب 4K E2E', 1, 100.00]
            );

            // Trigger Sales Sync
            await request(server)
                .post('/api/product-control/sync-sales')
                .set('Cookie', adminCookie)
                .expect(200);

            // API Verification of post-count expected stock
            const apiRes = await request(server)
                .get(`/api/product-control/products/${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(apiRes.body.data.metrics.expected_stock_before_last_count, 24);
            assert.strictEqual(apiRes.body.data.metrics.last_inventory_actual_qty, 22);
            assert.strictEqual(apiRes.body.data.metrics.last_inventory_variance, -2);
            assert.strictEqual(apiRes.body.data.metrics.current_expected_stock, 21);
        });
    });

    // =========================================================================
    // 2. Multi-Cost WAC & COGS Reconciliation
    // =========================================================================
    describe('2. Multi-Cost WAC & COGS Reconciliation', () => {
        let multiCostProductId = null;

        before(async () => {
            const resP = await ProductControlRepository.runSql(
                `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                 VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'normal', datetime('now'))`,
                ['منتج متعدد التكلفة WAC TEST', 'SALLA-WAC-1', 'SKU-WAC-1']
            );
            multiCostProductId = resP.lastID;
        });

        it('should correctly calculate WAC across multiple purchase batches at different unit costs', async () => {
            // Purchase Batch 1: 10 units @ 40.00 SAR (Total: 400 SAR)
            await request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', adminCookie)
                .send({
                    items: [{ product_id: multiCostProductId, quantity: 10, unit_cost_sar: 40.00 }]
                })
                .expect(200);

            let prod1 = await ProductControlRepository.getProductById(multiCostProductId);
            assert.strictEqual(prod1.cost_halalas, 4000); // 40.00 SAR
            assert.strictEqual(prod1.inventory_value_halalas, 40000); // 400.00 SAR

            // Purchase Batch 2: 10 units @ 60.00 SAR (Total: 600 SAR)
            await request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', adminCookie)
                .send({
                    items: [{ product_id: multiCostProductId, quantity: 10, unit_cost_sar: 60.00 }]
                })
                .expect(200);

            let prod2 = await ProductControlRepository.getProductById(multiCostProductId);
            // Combined: 20 units, Total value: 1000 SAR => WAC = 50.00 SAR (5000 halalas)
            assert.strictEqual(prod2.quantity, 20);
            assert.strictEqual(prod2.cost_halalas, 5000);
            assert.strictEqual(prod2.inventory_value_halalas, 100000);
        });
    });

    // =========================================================================
    // 3. COGS Unavailable State Test
    // =========================================================================
    describe('3. COGS Unavailable Handling', () => {
        it('should return cogs_status = UNAVAILABLE and null financial metrics when cost is uninitialized', async () => {
            const apiRes = await request(server)
                .get(`/api/product-control/products/${unmappedProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(apiRes.body.data.cogs_status, 'UNAVAILABLE');
            assert.strictEqual(apiRes.body.data.unit_cogs_sar, null);
            assert.strictEqual(apiRes.body.data.gross_profit_sar, null);
            assert.strictEqual(apiRes.body.data.net_profit_sar, null);
        });
    });

    // =========================================================================
    // 4. Pre-Purchase Decision Engine Gate
    // =========================================================================
    describe('4. Pre-Purchase Decision Engine Gate', () => {
        it('should block purchase when product status is purchase_stopped', async () => {
            // Update status to purchase_stopped
            await request(server)
                .put(`/api/product-control/products/${testProductId}/status`)
                .set('Cookie', adminCookie)
                .send({ status: 'purchase_stopped', reason: 'Admin Stop Test' })
                .expect(200);

            const checkRes = await request(server)
                .get(`/api/product-control/pre-purchase-check?product_id=${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(checkRes.body.allowed, false);
            assert.ok(checkRes.body.blocking_reasons.some(r => r.includes('متوقف عن الشراء')));

            // Revert status back to normal
            await request(server)
                .put(`/api/product-control/products/${testProductId}/status`)
                .set('Cookie', adminCookie)
                .send({ status: 'normal', reason: 'Revert Test' })
                .expect(200);
        });
    });

    // =========================================================================
    // 5. Purchase Cancellation / Rollback Test
    // =========================================================================
    describe('5. Purchase Cancellation / Rollback Safety', () => {
        it('should cancel purchase invoice and atomically revert stock, WAC, and log reversal movement', async () => {
            // Record a temporary purchase invoice
            const purRes = await request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', adminCookie)
                .send({
                    supplier_name: 'مورد مؤقت للغاء',
                    items: [{ product_id: testProductId, quantity: 5, unit_cost_sar: 50.00 }]
                })
                .expect(200);

            const headerId = purRes.body.purchase_id;
            assert.ok(headerId);

            const stockBeforeCancel = (await ProductControlRepository.getProductById(testProductId)).quantity;

            // Cancel the purchase invoice
            const cancelRes = await request(server)
                .delete(`/api/product-control/products/${testProductId}/purchases`)
                .set('Cookie', adminCookie)
                .send({ header_id: headerId, reason: 'E2E Rollback Test' })
                .expect(200);

            assert.strictEqual(cancelRes.body.success, true);

            // Database Reconciliation
            const stockAfterCancel = (await ProductControlRepository.getProductById(testProductId)).quantity;
            assert.strictEqual(stockAfterCancel, stockBeforeCancel - 5);

            const movements = await ProductControlRepository.getStockMovements(testProductId);
            const reversalMov = movements.find(m => m.movement_type === 'PURCHASE_REVERSAL' && m.source_reference_id == headerId);
            assert.ok(reversalMov);
            assert.strictEqual(reversalMov.quantity, -5);

            // Audit Log Preserved
            const audits = await ProductControlRepository.getAuditLogsForEntity('PURCHASE_HEADER', headerId);
            assert.ok(audits.some(a => a.action === 'CANCEL'));
        });
    });

    // =========================================================================
    // 6. Security & Permissions E2E
    // =========================================================================
    describe('6. Security & Permissions E2E Verification', () => {
        it('should reject unauthenticated write calls with 401', async () => {
            await request(server)
                .post(`/api/product-control/products/${testProductId}/inventory-counts`)
                .send({ actual_qty: 50 })
                .expect(401);
        });

        it('should reject non-admin employee write calls with 403', async () => {
            await request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', employeeCookie)
                .send({ items: [] })
                .expect(403);
        });

        it('should allow read operations for authenticated employees', async () => {
            await request(server)
                .get('/api/product-control/products')
                .set('Cookie', employeeCookie)
                .expect(200);
        });
    });

});
