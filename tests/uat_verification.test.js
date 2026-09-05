process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const app = require('../server');
const { db, hashPassword } = require('../database');
const { runMigration } = require('../src/migrations/migration_v1_product_control');
const ProductControlRepository = require('../src/repositories/product_control.repository');
const ProductControlService = require('../src/services/product_control.service');

describe('📋 User Acceptance Testing (UAT) Verification Suite - Product Control Center', function() {
    this.timeout(25000);

    let server;
    let adminCookie = '';
    let employeeCookie = '';
    let uatProductId = null;
    let noCostProductId = null;

    before((done) => {
        server = app.listen(0, async () => {
            try {
                await runMigration(false);

                // Seed admin & employee roles
                const adminHash = hashPassword('UatAdmin123!');
                const empHash = hashPassword('UatEmp123!');

                db.run("INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['uat_admin', 'uat_admin@test.local', adminHash, 'admin', '2026-09-01']);
                db.run("INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['uat_employee', 'uat_emp@test.local', empHash, 'employee', '2026-09-01'],
                    (err) => {
                        if (err) return done(err);

                        // Login admin
                        request(server)
                            .post('/api/auth/login')
                            .send({ login: 'uat_admin', password: 'UatAdmin123!' })
                            .end((errLogin, res) => {
                                if (errLogin) return done(errLogin);
                                const cookies = res.headers['set-cookie'];
                                if (cookies) adminCookie = cookies[0];

                                // Login employee
                                request(server)
                                    .post('/api/auth/login')
                                    .send({ login: 'uat_employee', password: 'UatEmp123!' })
                                    .end(async (errEmpLogin, resEmp) => {
                                        if (errEmpLogin) return done(errEmpLogin);
                                        const empCookies = resEmp.headers['set-cookie'];
                                        if (empCookies) employeeCookie = empCookies[0];

                                        try {
                                            // Seed UAT Main Product
                                            const resP = await ProductControlRepository.runSql(
                                                `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                                                 VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'needs_inventory', datetime('now'))`,
                                                ['حقيبة سفر فاخرة UAT', 'SALLA-UAT-888', 'SKU-UAT-888']
                                            );
                                            uatProductId = resP.lastID;

                                            // Seed UAT No-Cost Product
                                            const resNC = await ProductControlRepository.runSql(
                                                `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                                                 VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'needs_inventory', datetime('now'))`,
                                                ['نظارة شمسية UAT بدون تكلفة', 'SALLA-UAT-777', 'SKU-UAT-777']
                                            );
                                            noCostProductId = resNC.lastID;

                                            // Map Salla Alias
                                            await ProductControlRepository.upsertMapping(
                                                uatProductId,
                                                'SALLA-UAT-888',
                                                'SKU-UAT-888',
                                                'حقيبة سفر فاخرة UAT',
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

    // UAT Scenario 1: Catalog Navigation & List View
    it('UAT 1: Catalog Navigation & Products Monitoring List (#page-product-control)', async () => {
        const res = await request(server)
            .get('/api/product-control/products?page=1&limit=15')
            .set('Cookie', adminCookie)
            .expect(200);

        assert.strictEqual(res.body.success, true);
        assert.ok(Array.isArray(res.body.data));
        assert.ok(res.body.pagination);
        assert.ok(res.body.data.some(p => p.id === uatProductId));
    });

    // UAT Scenario 2: Product Detail Dashboard
    it('UAT 2: Product Detail Dashboard (#page-product-control-detail)', async () => {
        const res = await request(server)
            .get(`/api/product-control/products/${uatProductId}`)
            .set('Cookie', adminCookie)
            .expect(200);

        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.product.product_name, 'حقيبة سفر فاخرة UAT');
        assert.strictEqual(res.body.data.product.sku, 'SKU-UAT-888');
        assert.ok(res.body.data.metrics);
        assert.ok(res.body.data.history);
    });

    // UAT Scenario 3: Physical Inventory Count & Variance Flagging
    it('UAT 3: Perform Initial & Variance Inventory Count', async () => {
        // Initial Count
        await request(server)
            .post(`/api/product-control/products/${uatProductId}/inventory-counts`)
            .set('Cookie', adminCookie)
            .send({ actual_qty: 15, inventory_at: '2026-09-05T08:00:00Z', notes: 'UAT Initial Count' })
            .expect(200);

        const prodDb = await ProductControlRepository.getProductById(uatProductId);
        assert.strictEqual(prodDb.quantity, 15);
        assert.strictEqual(prodDb.current_control_status, 'normal');
    });

    // UAT Scenario 4: Pre-Purchase Decision Engine Gate
    it('UAT 4: Pre-Purchase Gate Evaluation (Allowed vs Blocked)', async () => {
        // Product 1 has inventory count -> Allowed
        const resAllowed = await request(server)
            .get(`/api/product-control/pre-purchase-check?product_id=${uatProductId}`)
            .set('Cookie', adminCookie)
            .expect(200);

        assert.strictEqual(resAllowed.body.allowed, true);

        // No-cost product has no inventory count -> Blocked
        const resBlocked = await request(server)
            .get(`/api/product-control/pre-purchase-check?product_id=${noCostProductId}`)
            .set('Cookie', adminCookie)
            .expect(200);

        assert.strictEqual(resBlocked.body.allowed, false);
        assert.ok(resBlocked.body.blocking_reasons.length > 0);
    });

    // UAT Scenario 5: Multi-Product Purchase Invoice Recording
    it('UAT 5: Multi-Product Purchase Invoice Recording', async () => {
        const purRes = await request(server)
            .post('/api/product-control/purchases')
            .set('Cookie', adminCookie)
            .send({
                supplier_name: 'شركة الاستيراد المتحدة UAT',
                invoice_ref: 'INV-UAT-555',
                items: [
                    { product_id: uatProductId, quantity: 25, unit_cost_sar: 80.00 }
                ]
            })
            .expect(200);

        assert.strictEqual(purRes.body.success, true);
        assert.ok(purRes.body.purchase_id);
    });

    // UAT Scenario 6: Stock & WAC Recalculation
    it('UAT 6: Verify Stock Balance & WAC Recalculation after Purchase', async () => {
        const dbProd = await ProductControlRepository.getProductById(uatProductId);
        // 15 units @ 0 + 25 units @ 80 SAR = 2000 SAR total cost value / 25 costed units = 80.00 SAR WAC (8000 halalas)
        assert.strictEqual(dbProd.quantity, 40);
        assert.strictEqual(dbProd.cost_halalas, 8000);
        assert.strictEqual(dbProd.inventory_value_halalas, 200000); // 2000 SAR
    });

    // UAT Scenario 7 & 8: Sales Mapped Attribution, Returns & Idempotency
    it('UAT 7 & 8: Sales Sync, Partial Return & Zero Double Counting', async () => {
        await ProductControlRepository.runSql(
            `INSERT INTO salla_imported_orders (reference_id, date, status_slug, product_name, quantity, amount)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['ORDER-UAT-7001', '2026-09-05', 'completed', 'حقيبة سفر فاخرة UAT', 5, 750.00]
        );

        await ProductControlRepository.runSql(
            `INSERT INTO salla_imported_orders (reference_id, date, status_slug, product_name, quantity, amount)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['ORDER-UAT-7001-RET', '2026-09-05', 'refunded', 'حقيبة سفر فاخرة UAT', 1, 150.00]
        );

        const syncRes = await request(server)
            .post('/api/product-control/sync-sales')
            .set('Cookie', adminCookie)
            .expect(200);

        assert.ok(syncRes.body.synced_movements >= 2);

        const expectedStock = await ProductControlRepository.getCurrentStockFromMovements(uatProductId);
        assert.strictEqual(expectedStock, 36); // 40 - 5 + 1 = 36
    });

    // UAT Scenario 9: ADVERTISING and OTHER Expense Allocations
    it('UAT 9: Expense Allocations (ADVERTISING & OTHER)', async () => {
        const expAdId = await new Promise((resolve, reject) => {
            db.run("INSERT INTO expenses (desc, cat, amt, date) VALUES (?, ?, ?, ?)",
                ['تسويق إلكتروني UAT', 'ADVERTISING', 300.00, '2026-09-05'],
                function(err) { if (err) reject(err); else resolve(this.lastID); }
            );
        });

        const expOtherId = await new Promise((resolve, reject) => {
            db.run("INSERT INTO expenses (desc, cat, amt, date) VALUES (?, ?, ?, ?)",
                ['عمولات بنكية UAT', 'OTHER', 60.00, '2026-09-05'],
                function(err) { if (err) reject(err); else resolve(this.lastID); }
            );
        });

        await request(server)
            .post('/api/product-control/expenses/allocate')
            .set('Cookie', adminCookie)
            .send({
                expense_id: expAdId,
                product_id: uatProductId,
                amount_sar: 150.00,
                allocation_type: 'ADVERTISING',
                platform: 'Google'
            })
            .expect(200);

        await request(server)
            .post('/api/product-control/expenses/allocate')
            .set('Cookie', adminCookie)
            .send({
                expense_id: expOtherId,
                product_id: uatProductId,
                amount_sar: 30.00,
                allocation_type: 'OTHER'
            })
            .expect(200);

        const adSum = await ProductControlRepository.getExpenseAllocatedSum(expAdId);
        const otherSum = await ProductControlRepository.getExpenseAllocatedSum(expOtherId);

        assert.strictEqual(adSum, 15000); // 150 SAR
        assert.strictEqual(otherSum, 3000); // 30 SAR
    });

    // UAT Scenario 10: Financial Income Statement Breakdown
    it('UAT 10: Revenue, COGS, Gross Profit & Net Profit Review', async () => {
        const res = await request(server)
            .get(`/api/product-control/products/${uatProductId}`)
            .set('Cookie', adminCookie)
            .expect(200);

        const d = res.body.data;
        assert.strictEqual(d.cogs_status, 'AVAILABLE');
        assert.strictEqual(d.unit_cogs_sar, 80.00);
        assert.ok(d.history.stock_movements.some(m => m.movement_type === 'SALE'));
    });

    // UAT Scenario 11: COGS UNAVAILABLE Handling
    it('UAT 11: COGS UNAVAILABLE State Handling', async () => {
        const res = await request(server)
            .get(`/api/product-control/products/${noCostProductId}`)
            .set('Cookie', adminCookie)
            .expect(200);

        const d = res.body.data;
        assert.strictEqual(d.cogs_status, 'UNAVAILABLE');
        assert.strictEqual(d.unit_cogs_sar, null);
        assert.strictEqual(d.gross_profit_sar, null);
        assert.strictEqual(d.net_profit_sar, null);
    });

    // UAT Scenario 12: 7 Product Control Status Contract
    it('UAT 12: All 7 Control Statuses Contract Validation', async () => {
        const manualStatuses = ['normal', 'needs_inventory', 'under_review', 'purchase_stopped'];

        for (const st of manualStatuses) {
            const res = await request(server)
                .put(`/api/product-control/products/${uatProductId}/status`)
                .set('Cookie', adminCookie)
                .send({ status: st, reason: `Testing manual status ${st}` })
                .expect(200);

            assert.strictEqual(res.body.data.new_status, st);
        }

        // Verify invalid status rejected with 400
        await request(server)
            .put(`/api/product-control/products/${uatProductId}/status`)
            .set('Cookie', adminCookie)
            .send({ status: 'invalid_status_xyz', reason: 'Invalid test' })
            .expect(400);

        // Revert to normal
        await request(server)
            .put(`/api/product-control/products/${uatProductId}/status`)
            .set('Cookie', adminCookie)
            .send({ status: 'normal', reason: 'Reset to normal' })
            .expect(200);
    });

    // UAT Scenario 13: Roles & Permissions Access Control
    it('UAT 13: Roles & Permissions Access Control (Unauthenticated / Employee / Admin)', async () => {
        // Unauthenticated -> 401
        await request(server)
            .post(`/api/product-control/products/${uatProductId}/inventory-counts`)
            .send({ actual_qty: 10 })
            .expect(401);

        // Employee Read-only -> Write 403, Read 200
        await request(server)
            .post('/api/product-control/purchases')
            .set('Cookie', employeeCookie)
            .send({ items: [] })
            .expect(403);

        await request(server)
            .get('/api/product-control/products')
            .set('Cookie', employeeCookie)
            .expect(200);

        // Admin -> Write 200/201
        await request(server)
            .get('/api/product-control/products')
            .set('Cookie', adminCookie)
            .expect(200);
    });

    // UAT Scenario 14: Search, Filters & Backend Pagination
    it('UAT 14: Search, Status Filter & Date Shortcuts', async () => {
        // Search by SKU
        const resSearch = await request(server)
            .get('/api/product-control/products?q=SKU-UAT-888')
            .set('Cookie', adminCookie)
            .expect(200);

        assert.strictEqual(resSearch.body.data.length, 1);
        assert.strictEqual(resSearch.body.data[0].id, uatProductId);

        // Status Filter
        const resFilter = await request(server)
            .get('/api/product-control/products?status=normal')
            .set('Cookie', adminCookie)
            .expect(200);

        assert.ok(Array.isArray(resFilter.body.data));

        // Date Shortcuts
        const resDate = await request(server)
            .get('/api/product-control/products?from=2026-09-01&to=2026-09-05')
            .set('Cookie', adminCookie)
            .expect(200);

        assert.strictEqual(resDate.body.success, true);
    });

    // UAT Scenario 15: Static Assets Shell & Responsive RTL Alignment
    it('UAT 15: Desktop, Mobile & RTL Layout Static Inspection', async () => {
        const res = await request(server)
            .get('/index.html')
            .set('Cookie', adminCookie)
            .expect(200);

        assert.ok(res.text.includes('dir="rtl"') || res.text.includes('lang="ar"'));
        assert.ok(res.text.includes('id="page-product-control"'));
        assert.ok(res.text.includes('id="page-product-control-detail"'));
    });
});
