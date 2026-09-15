// Set NODE_ENV to test to ensure we load SQLite in-memory database
process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const crypto = require('crypto');
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

    // Payload shapes below are copied from real production webhook deliveries captured in
    // salla_webhook_logs (ids 18291-18295) for reference_id 286091780 — NOT invented.
    describe('🔔 POST /api/salla/webhook - Order Status Synchronization', () => {
        function buildOrderObject({ refId, statusSlug, statusName, amount, paymentMethod, itemId, itemName, mobile, updatedAt }) {
            return {
                id: 700000000 + Number(refId),
                reference_id: Number(refId),
                date: { date: '2026-09-20 10:00:00.000000', timezone_type: 3, timezone: 'Asia/Riyadh' },
                updated_at: { date: updatedAt, timezone_type: 3, timezone: 'Asia/Riyadh' },
                status: { id: 1, name: statusName, slug: statusSlug, customized: { id: 1, name: statusName } },
                payment_method: paymentMethod || 'credit_card',
                amounts: {
                    sub_total: { amount, currency: 'SAR' },
                    total: { amount, currency: 'SAR' }
                },
                customer: { id: 1, first_name: 'عميل', last_name: 'اختبار', mobile: mobile || '+966500000000', email: 'test@example.com' },
                items: [{ id: itemId, product_id: itemId, name: itemName || 'منتج اختبار', quantity: 1, amounts: { total: { amount, currency: 'SAR' } } }]
            };
        }

        // order.created: payload.data IS the order object directly (proven: log id 18295).
        function buildCreatedPayload(opts) {
            return { event: 'order.created', merchant: 1772607855, created_at: new Date().toString(), data: buildOrderObject(opts) };
        }

        // order.status.updated: payload.data is an activity record whose "status" field is a plain
        // localized-name STRING (not an object), and the real order lives under payload.data.order
        // (proven: log ids 18291-18294).
        function buildStatusUpdatedPayload(opts) {
            return {
                event: 'order.status.updated',
                merchant: 1772607855,
                created_at: new Date().toString(),
                data: {
                    id: 900000000 + Math.floor(Math.random() * 1e6),
                    status: opts.statusName,
                    customized: { id: 1, name: opts.statusName, slug: opts.statusSlug },
                    note: 'test transition',
                    order: buildOrderObject(opts)
                }
            };
        }

        function postWebhook(payloadObj) {
            const secret = process.env.SALLA_WEBHOOK_SECRET;
            const body = JSON.stringify(payloadObj);
            const req = request(server).post('/api/salla/webhook').set('Content-Type', 'application/json');
            if (secret) {
                const sig = crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
                req.set('X-Salla-Signature', sig);
            }
            return req.send(body);
        }

        function getOrderRows(refId) {
            return new Promise((resolve, reject) => {
                db.all(
                    "SELECT * FROM salla_imported_orders WHERE reference_id = ? OR reference_id LIKE ?",
                    [String(refId), refId + '_%'],
                    (err, rows) => err ? reject(err) : resolve(rows)
                );
            });
        }

        it('[Test A] under_review -> completed: status change is reflected on the same order', async () => {
            const refId = '900001';
            await postWebhook(buildCreatedPayload({
                refId, statusSlug: 'under_review', statusName: 'بإنتظار المراجعة',
                amount: 45, itemId: 1, itemName: 'اشتراك اختبار', updatedAt: '2026-09-20 10:00:00.000000'
            })).expect(200);

            let rows = await getOrderRows(refId);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.have.property('status_slug', 'under_review');
            expect(rows[0]).to.have.property('amount', 45);

            await postWebhook(buildStatusUpdatedPayload({
                refId, statusSlug: 'completed', statusName: 'تم التنفيذ',
                amount: 45, itemId: 1, itemName: 'اشتراك اختبار', updatedAt: '2026-09-20 10:05:00.000000'
            })).expect(200);

            rows = await getOrderRows(refId);
            expect(rows).to.have.lengthOf(1); // updated in place, not duplicated
            expect(rows[0]).to.have.property('status_slug', 'completed');
            expect(rows[0]).to.have.property('status_name', 'تم التنفيذ');
            expect(rows[0]).to.have.property('amount', 45); // amount correctly extracted from amounts.total
        });

        it('[Test B] payment_pending -> under_review -> completed: every transition is applied in order', async () => {
            const refId = '900002';
            const base = { refId, amount: 60, itemId: 2, itemName: 'اشتراك ب' };

            await postWebhook(buildCreatedPayload({ ...base, statusSlug: 'payment_pending', statusName: 'بإنتظار الدفع', updatedAt: '2026-09-20 11:00:00.000000' })).expect(200);
            let rows = await getOrderRows(refId);
            expect(rows[0]).to.have.property('status_slug', 'payment_pending');

            await postWebhook(buildStatusUpdatedPayload({ ...base, statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', updatedAt: '2026-09-20 11:05:00.000000' })).expect(200);
            rows = await getOrderRows(refId);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.have.property('status_slug', 'under_review');

            await postWebhook(buildStatusUpdatedPayload({ ...base, statusSlug: 'completed', statusName: 'تم التنفيذ', updatedAt: '2026-09-20 11:10:00.000000' })).expect(200);
            rows = await getOrderRows(refId);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.have.property('status_slug', 'completed');
        });

        it('[Test E] duplicate webhook delivery does not create duplicate rows', async () => {
            const refId = '900003';
            const base = { refId, amount: 30, itemId: 3, itemName: 'اشتراك هـ' };
            await postWebhook(buildCreatedPayload({ ...base, statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', updatedAt: '2026-09-20 12:00:00.000000' })).expect(200);

            const dupPayload = buildStatusUpdatedPayload({ ...base, statusSlug: 'completed', statusName: 'تم التنفيذ', updatedAt: '2026-09-20 12:05:00.000000' });
            await postWebhook(dupPayload).expect(200);
            await postWebhook(dupPayload).expect(200); // exact same event, redelivered
            await postWebhook(dupPayload).expect(200); // and again

            const rows = await getOrderRows(refId);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.have.property('status_slug', 'completed');
        });

        it('[Test F] an older event arriving after a newer one must not revert the status (out-of-order safety)', async () => {
            const refId = '900004';
            const base = { refId, amount: 20, itemId: 4, itemName: 'اشتراك و' };
            await postWebhook(buildCreatedPayload({ ...base, statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', updatedAt: '2026-09-20 13:00:00.000000' })).expect(200);

            // Newer event arrives first (T2)
            await postWebhook(buildStatusUpdatedPayload({ ...base, statusSlug: 'completed', statusName: 'تم التنفيذ', updatedAt: '2026-09-20 13:10:00.000000' })).expect(200);
            // Older event (T1, earlier than what's already applied) arrives late
            await postWebhook(buildStatusUpdatedPayload({ ...base, statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', updatedAt: '2026-09-20 13:05:00.000000' })).expect(200);

            const rows = await getOrderRows(refId);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.have.property('status_slug', 'completed'); // must stay at the newer state
        });

        it('[Test G] an order that already existed before the webhook arrives gets updated in place', async () => {
            const refId = '900005';
            // Simulate a pre-existing legacy row (e.g. imported before this fix, no external_updated_at)
            await new Promise((resolve, reject) => {
                db.run(
                    "INSERT INTO salla_imported_orders (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, quantity, customer_phone) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [refId, '2026-09-19', 'under_review', 'بإنتظار المراجعة', 'mada', 75, 'عميل قديم', 'منتج قديم', 1, '0500000000'],
                    (err) => err ? reject(err) : resolve()
                );
            });

            await postWebhook(buildStatusUpdatedPayload({
                refId, statusSlug: 'completed', statusName: 'تم التنفيذ', amount: 75,
                itemId: 5, itemName: 'منتج قديم', updatedAt: '2026-09-20 14:00:00.000000'
            })).expect(200);

            const rows = await getOrderRows(refId);
            expect(rows).to.have.lengthOf(1); // still one row for this order, updated not duplicated
            expect(rows[0]).to.have.property('status_slug', 'completed');
        });
    });
});
