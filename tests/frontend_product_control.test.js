process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const app = require('../server');
const { db, hashPassword } = require('../database');
const { runMigration } = require('../src/migrations/migration_v1_product_control');
const ProductControlRepository = require('../src/repositories/product_control.repository');
const ProductControlService = require('../src/services/product_control.service');

describe('🎨 Frontend Stage Verification Suite - Product Control Center', function() {
    this.timeout(15000);

    let server;
    let adminCookie = '';
    let employeeCookie = '';
    let testProductId = null;

    before((done) => {
        server = app.listen(0, async () => {
            try {
                // Ensure migration is run
                await runMigration(false);

                // Seed admin & employee users
                const adminHash = hashPassword('AdminPass123!');
                const empHash = hashPassword('EmpPass123!');

                db.run("INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['fe_admin', 'fe_admin@test.local', adminHash, 'admin', '2026-09-01']);
                db.run("INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['fe_employee', 'fe_emp@test.local', empHash, 'employee', '2026-09-01'],
                    (err) => {
                        if (err) return done(err);

                        // Login admin
                        request(server)
                            .post('/api/auth/login')
                            .send({ login: 'fe_admin', password: 'AdminPass123!' })
                            .end((errLogin, res) => {
                                if (errLogin) return done(errLogin);
                                const cookies = res.headers['set-cookie'];
                                if (cookies) adminCookie = cookies[0];

                                // Login employee
                                request(server)
                                    .post('/api/auth/login')
                                    .send({ login: 'fe_employee', password: 'EmpPass123!' })
                                    .end(async (errEmpLogin, resEmp) => {
                                        if (errEmpLogin) return done(errEmpLogin);
                                        const empCookies = resEmp.headers['set-cookie'];
                                        if (empCookies) employeeCookie = empCookies[0];

                                        try {
                                            // Seed test product for all sub-test suites
                                            const resP = await ProductControlRepository.runSql(
                                                `INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                                                 VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'needs_inventory', datetime('now'))`,
                                                ['ساعة ذكية فاخرة TEST', 'SALLA_FE_PROD_1', 'SKU-FE-101']
                                            );
                                            testProductId = resP.lastID;
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

    describe('1. Static HTML Shell & Script Inclusions', () => {
        it('should return index.html containing #page-product-control and #page-product-control-detail', (done) => {
            request(server)
                .get('/')
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(res.text.includes('id="page-product-control"'));
                    assert.ok(res.text.includes('id="page-product-control-detail"'));
                    assert.ok(res.text.includes('src="js/product_control_ui.js"'));
                    assert.ok(res.text.includes('id="pcAddInventoryModal"'));
                    assert.ok(res.text.includes('id="pcAddPurchaseModal"'));
                    assert.ok(res.text.includes('id="pcAllocateExpenseModal"'));
                    done();
                });
        });
    });

    describe('2. Authorization & Default-Deny Security (401 / 403 / 500)', () => {
        it('should reject unauthenticated request to /api/product-control/products with 401', (done) => {
            request(server)
                .get('/api/product-control/products')
                .expect(401)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.strictEqual(res.body.code, 'UNAUTHORIZED');
                    assert.strictEqual(res.body.error, 'غير مصرح بالدخول. يرجى تسجيل الدخول.');
                    done();
                });
        });

        it('should reject unauthenticated inventory count POST with 401', (done) => {
            request(server)
                .post('/api/product-control/inventory-counts')
                .send({ product_id: 1, actual_qty: 10, counted_at: '2026-09-05T10:00:00Z' })
                .expect(401, done);
        });

        it('should reject non-admin employee from adding purchase with 403', (done) => {
            request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', employeeCookie)
                .send({ supplier_name: 'Test', items: [] })
                .expect(403)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.strictEqual(res.body.code, 'FORBIDDEN');
                    done();
                });
        });
    });

    describe('3. Products List API, Search, Status Filter & Pagination', () => {

        it('should return products overview array with pagination for admin', (done) => {
            request(server)
                .get('/api/product-control/products?page=1&limit=10')
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(Array.isArray(res.body.data));
                    assert.ok(res.body.pagination);
                    assert.strictEqual(res.body.pagination.current_page, 1);
                    assert.ok(res.body.data.length >= 1);
                    const prod = res.body.data.find(p => p.id === testProductId);
                    assert.ok(prod);
                    assert.strictEqual(prod.product_name, 'ساعة ذكية فاخرة TEST');
                    assert.strictEqual(prod.sku, 'SKU-FE-101');
                    done();
                });
        });

        it('should filter products by search keyword q', (done) => {
            request(server)
                .get('/api/product-control/products?q=SKU-FE-101')
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.strictEqual(res.body.data.length, 1);
                    assert.strictEqual(res.body.data[0].id, testProductId);
                    done();
                });
        });

        it('should filter products by status filter', (done) => {
            request(server)
                .get('/api/product-control/products?status=needs_inventory')
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(Array.isArray(res.body.data));
                    done();
                });
        });
    });

    describe('4. Date Boundary Filter (from / to)', () => {
        it('should reject invalid date range from > to with HTTP 400', (done) => {
            request(server)
                .get('/api/product-control/products?from=2026-09-10&to=2026-09-01')
                .set('Cookie', adminCookie)
                .expect(400)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.strictEqual(res.body.code, 'INVALID_DATE_RANGE');
                    done();
                });
        });

        it('should accept valid date range from <= to', (done) => {
            request(server)
                .get('/api/product-control/products?from=2026-09-01&to=2026-09-05')
                .set('Cookie', adminCookie)
                .expect(200, done);
        });
    });

    describe('5. Product Detail & COGS Unavailable State', () => {
        it('should return cogs_status = UNAVAILABLE and unit_cogs_sar = null when no purchases/baseline exist', (done) => {
            request(server)
                .get(`/api/product-control/products/${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    const p = res.body;
                    assert.strictEqual(p.cogs_status, 'UNAVAILABLE');
                    assert.strictEqual(p.unit_cogs_sar, null);
                    assert.strictEqual(p.gross_profit_sar, null);
                    assert.strictEqual(p.net_profit_sar, null);
                    done();
                });
        });
    });

    describe('6. Pre-purchase Check Engine (blocking_reasons vs warnings)', () => {
        it('should block purchase when inventory count is missing', (done) => {
            request(server)
                .get(`/api/product-control/pre-purchase-check?product_id=${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.strictEqual(res.body.allowed, false);
                    assert.ok(res.body.blocking_reasons.length > 0);
                    done();
                });
        });

        it('should allow purchase once inventory count is added', async () => {
            // Add inventory count first
            await ProductControlService.recordInventoryCount({
                product_id: testProductId,
                actual_qty: 20,
                counted_at: '2026-09-05T10:00:00Z',
                notes: 'Initial inventory count for FE test'
            }, 'fe_admin');

            const res = await request(server)
                .get(`/api/product-control/pre-purchase-check?product_id=${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(res.body.allowed, true);
        });
    });

    describe('7. Purchase Creation & Expense Allocation Workflows', () => {
        it('should create multi-item purchase invoice and update WAC', (done) => {
            request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', adminCookie)
                .send({
                    supplier_name: 'المورد الممتاز',
                    purchase_at: '2026-09-05T11:00:00Z',
                    items: [
                        {
                            product_id: testProductId,
                            quantity: 30,
                            unit_cost_sar: 100.00
                        }
                    ]
                })
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.strictEqual(res.body.success, true);
                    assert.ok(res.body.purchase_id);
                    done();
                });
        });

        it('should verify cogs_status becomes AVAILABLE after purchase', (done) => {
            request(server)
                .get(`/api/product-control/products/${testProductId}`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.strictEqual(res.body.cogs_status, 'AVAILABLE');
                    assert.strictEqual(res.body.unit_cogs_sar, 100.00);
                    done();
                });
        });

        it('should allocate expense to product', async () => {
            // Create legacy expense first
            const expId = await new Promise((resolve, reject) => {
                db.run(
                    "INSERT INTO expenses (desc, cat, amt, date) VALUES (?, ?, ?, ?)",
                    ['حملة سناب شات ترويجية', 'تسويق', 500.00, '2026-09-05'],
                    function(err) {
                        if (err) return reject(err);
                        resolve(this.lastID);
                    }
                );
            });

            const res = await request(server)
                .post('/api/product-control/expenses/allocate')
                .set('Cookie', adminCookie)
                .send({
                    expense_id: expId,
                    product_id: testProductId,
                    amount_sar: 150.00,
                    allocation_type: 'ADVERTISING'
                })
                .expect(200);

            assert.strictEqual(res.value || res.body.success, true);
        });
    });

    describe('8. Sub-tabs APIs (Sales, Purchases, Inventory, Expenses, Timeline)', () => {
        it('should fetch sales history list for product', (done) => {
            request(server)
                .get(`/api/product-control/products/${testProductId}/sales`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(Array.isArray(res.body.data));
                    assert.ok(res.body.pagination);
                    done();
                });
        });

        it('should fetch purchases history list for product', (done) => {
            request(server)
                .get(`/api/product-control/products/${testProductId}/purchases`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(Array.isArray(res.body.data));
                    assert.ok(res.body.data.length >= 1);
                    done();
                });
        });

        it('should fetch inventory counts list for product', (done) => {
            request(server)
                .get(`/api/product-control/products/${testProductId}/inventory-counts`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(Array.isArray(res.body.data));
                    assert.ok(res.body.data.length >= 1);
                    done();
                });
        });

        it('should fetch expenses list for product', (done) => {
            request(server)
                .get(`/api/product-control/products/${testProductId}/expenses`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(Array.isArray(res.body.data));
                    assert.ok(res.body.data.length >= 1);
                    done();
                });
        });

        it('should fetch timeline feed for product', (done) => {
            request(server)
                .get(`/api/product-control/products/${testProductId}/timeline`)
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    assert.ok(Array.isArray(res.body.data));
                    assert.ok(res.body.data.length >= 1);
                    done();
                });
        });
    });
});
