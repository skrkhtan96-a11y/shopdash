process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const expect = (val) => ({
    to: {
        be: {
            an: (type) => assert.ok(type === 'array' ? Array.isArray(val) : typeof val === type),
            a: (type) => assert.ok(type === 'array' ? Array.isArray(val) : typeof val === type)
        },
        get exist() { assert.ok(val); return this; },
        get not() { return { get exist() { assert.ok(!val); return this; } }; },
        equal: (expected) => assert.strictEqual(val, expected),
        have: {
            property: (prop, expected) => {
                assert.ok(val && val.hasOwnProperty(prop));
                if (expected !== undefined) assert.strictEqual(val[prop], expected);
            }
        }
    }
});
const app = require('../server');
const { db, hashPassword } = require('../database');

describe('🏷️ Product Pricing Rules API Tests', () => {
    let server;
    let adminCookie = '';
    let employeeCookie = '';

    before((done) => {
        server = app.listen(0, () => {
            // Seed admin and employee users in-memory database
            const adminHashed = hashPassword('SecureAdminPass123!');
            const employeeHashed = hashPassword('SecureEmployeePass123!');

            db.serialize(() => {
                db.run(
                    "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['pricing_test_admin', 'admin@pricing.local', adminHashed, 'admin', '2026-06-26']
                );
                db.run(
                    "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    ['pricing_test_employee', 'employee@pricing.local', employeeHashed, 'employee', '2026-06-26'],
                    (err) => {
                        if (err) return done(err);

                        // Login admin to get session cookie
                        request(server)
                            .post('/api/auth/login')
                            .send({ login: 'pricing_test_admin', password: 'SecureAdminPass123!' })
                            .end((errLogin, res) => {
                                if (errLogin) return done(errLogin);
                                const cookies = res.headers['set-cookie'];
                                if (cookies) {
                                    adminCookie = cookies[0];
                                }

                                // Login employee to get session cookie
                                request(server)
                                    .post('/api/auth/login')
                                    .send({ login: 'pricing_test_employee', password: 'SecureEmployeePass123!' })
                                    .end((errLoginEmp, resEmp) => {
                                        if (errLoginEmp) return done(errLoginEmp);
                                        const cookiesEmp = resEmp.headers['set-cookie'];
                                        if (cookiesEmp) {
                                            employeeCookie = cookiesEmp[0];
                                        }
                                        done();
                                    });
                            });
                    }
                );
            });
        });
    });

    after((done) => {
        server.close(done);
    });

    describe('GET /api/inventory/pricing-rules', () => {
        it('should successfully fetch product pricing rules (admin/employee)', (done) => {
            request(server)
                .get('/api/inventory/pricing-rules')
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.be.an('array');
                    done();
                });
        });
    });

    describe('POST /api/inventory/pricing-rules', () => {
        it('should block employee from adding/updating pricing rules', (done) => {
            request(server)
                .post('/api/inventory/pricing-rules')
                .set('Cookie', employeeCookie)
                .send({
                    product_name: 'كود سناب max',
                    period: 'شهري',
                    purchase_price: 15.00,
                    selling_price: 25.00,
                    copies_per_unit: 1
                })
                .expect(403, done);
        });

        it('should successfully add/update a pricing rule as admin', (done) => {
            request(server)
                .post('/api/inventory/pricing-rules')
                .set('Cookie', adminCookie)
                .send({
                    product_name: 'كود سناب max',
                    period: 'شهري',
                    purchase_price: 15.00,
                    selling_price: 25.00,
                    copies_per_unit: 1,
                    free_bundle_product: 'كود سناب max (يومي)',
                    free_bundle_qty_multiplier: 1,
                    notes: 'شراء شهري يمنح يومي مجاني بنفس الكمية'
                })
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('success', true);

                    // Verify in DB
                    db.get("SELECT * FROM product_pricing_rules WHERE product_name = 'كود سناب max' AND period = 'شهري'", (dbErr, row) => {
                        if (dbErr) return done(dbErr);
                        expect(row).to.exist;
                        expect(row.purchase_price).to.equal(15.00);
                        expect(row.selling_price).to.equal(25.00);
                        expect(row.copies_per_unit).to.equal(1);
                        expect(row.free_bundle_product).to.equal('كود سناب max (يومي)');
                        expect(row.free_bundle_qty_multiplier).to.equal(1);
                        done();
                    });
                });
        });
    });

    describe('DELETE /api/inventory/pricing-rules/:id', () => {
        it('should block employee from deleting pricing rules', (done) => {
            request(server)
                .delete('/api/inventory/pricing-rules/1')
                .set('Cookie', employeeCookie)
                .expect(403, done);
        });

        it('should successfully delete a pricing rule as admin', (done) => {
            db.get("SELECT id FROM product_pricing_rules WHERE product_name = 'كود سناب max' AND period = 'شهري'", (dbErr, row) => {
                if (dbErr) return done(dbErr);
                expect(row).to.exist;
                const idToDelete = row.id;

                request(server)
                    .delete(`/api/inventory/pricing-rules/${idToDelete}`)
                    .set('Cookie', adminCookie)
                    .expect(200)
                    .end((err, res) => {
                        if (err) return done(err);
                        expect(res.body).to.have.property('success', true);

                        // Verify deleted
                        db.get("SELECT * FROM product_pricing_rules WHERE id = ?", [idToDelete], (dbErr2, rowDeleted) => {
                            if (dbErr2) return done(dbErr2);
                            expect(rowDeleted).to.not.exist;
                            done();
                        });
                    });
            });
        });
    });
});
