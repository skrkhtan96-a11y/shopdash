// Set NODE_ENV to test to ensure we load SQLite in-memory database
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
        include: (expected) => assert.ok(val && val.includes(expected)),
        have: {
            property: (prop, expected) => {
                assert.ok(val && val.hasOwnProperty(prop));
                if (expected !== undefined) assert.strictEqual(val[prop], expected);
            },
            lengthOf: (expectedLen) => {
                assert.ok(val && (val.length !== undefined));
                assert.strictEqual(val.length, expectedLen);
            }
        }
    }
});
const app = require('../server');
const { db, hashPassword } = require('../database');

describe('📦 Salla Excel Import and Orders Retrieval Tests', () => {
    let server;
    let adminCookie = '';

    before((done) => {
        server = app.listen(0, () => {
            // Seed first admin user in-memory database
            const hashedPassword = hashPassword('SecureAdminPass123!');
            db.run(
                "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                ['salla_test_admin', 'admin@salla.local', hashedPassword, 'admin', '2026-06-11'],
                (err) => {
                    if (err) return done(err);
                    // Login to get session cookie
                    request(server)
                        .post('/api/auth/login')
                        .send({ login: 'salla_test_admin', password: 'SecureAdminPass123!' })
                        .end((errLogin, res) => {
                            if (errLogin) return done(errLogin);
                            const cookies = res.headers['set-cookie'];
                            if (cookies) {
                                adminCookie = cookies[0];
                            }
                            done();
                        });
                }
            );
        });
    });

    after((done) => {
        server.close(done);
    });

    describe('POST /api/salla/imported-orders', () => {
        it('should successfully import multiple orders, including duplicate reference IDs with suffixes', (done) => {
            const testOrders = [
                {
                    reference_id: '12345_0',
                    date: '2026-06-25',
                    status_slug: 'completed',
                    status_name: 'تم التنفيذ',
                    payment_method: 'mada',
                    amount: 150.00,
                    customer_name: 'أحمد علي',
                    customer_phone: '0501234567',
                    product_name: 'كتاب مفيد',
                    product_thumbnail: '',
                    quantity: 1
                },
                {
                    reference_id: '12345_1',
                    date: '2026-06-25',
                    status_slug: 'completed',
                    status_name: 'تم التنفيذ',
                    payment_method: 'mada',
                    amount: 250.00,
                    customer_name: 'أحمد علي',
                    customer_phone: '0501234567',
                    product_name: 'قلم فاخر',
                    product_thumbnail: '',
                    quantity: 1
                },
                {
                    reference_id: '12346',
                    date: '2026-06-25',
                    status_slug: 'completed',
                    status_name: 'تم التنفيذ',
                    payment_method: 'apple_pay',
                    amount: 500.00,
                    customer_name: 'سارة محمد',
                    customer_phone: '0559876543',
                    product_name: 'ساعة ذكية',
                    product_thumbnail: '',
                    quantity: 2
                }
            ];

            request(server)
                .post('/api/salla/imported-orders')
                .set('Cookie', adminCookie)
                .send({ orders: testOrders })
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('success', true);
                    expect(res.body).to.have.property('count', 3);

                    // Verify that they are indeed in the database and not overwritten
                    db.all("SELECT * FROM salla_imported_orders WHERE reference_id LIKE '12345%'", (dbErr, rows) => {
                        if (dbErr) return done(dbErr);
                        expect(rows).to.have.lengthOf(2);
                        const firstRow = rows.find(r => r.reference_id === '12345_0');
                        const secondRow = rows.find(r => r.reference_id === '12345_1');
                        expect(firstRow).to.exist;
                        expect(secondRow).to.exist;
                        expect(firstRow.customer_phone).to.equal('0501234567');
                        expect(secondRow.customer_phone).to.equal('0501234567');
                        expect(firstRow.product_name).to.equal('كتاب مفيد');
                        expect(secondRow.product_name).to.equal('قلم فاخر');
                        done();
                    });
                });
        });
    });

    describe('GET /api/salla/orders', () => {
        it('should allow searching for orders by customer phone number', (done) => {
            request(server)
                .get('/api/salla/orders?q=0559876543')
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('data');
                    const orders = res.body.data;
                    expect(orders).to.have.lengthOf(1);
                    expect(orders[0].customer.full_name).to.equal('سارة محمد');
                    expect(orders[0].customer.mobile).to.equal('0559876543');
                    done();
                });
        });

        it('should return all imported orders with customer phone included', (done) => {
            request(server)
                .get('/api/salla/orders')
                .set('Cookie', adminCookie)
                .expect(200)
                .end((err, res) => {
                    if (err) return done(err);
                    expect(res.body).to.have.property('data');
                    const orders = res.body.data;
                    const phoneOrder = orders.find(o => o.customer.mobile === '0501234567');
                    expect(phoneOrder).to.exist;
                    expect(phoneOrder.customer.full_name).to.equal('أحمد علي');
                    done();
                });
        });
    });
});
