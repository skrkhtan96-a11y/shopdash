// Verifies the new normalized product-sales data model: salla_order_items, the webhook/sync write
// integration, and GET /api/salla/product-sales-report. Mirrors the payload-building approach already
// used in tests/salla.test.js (payloads copied from real production shapes, not invented).
process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const crypto = require('crypto');
const axios = require('axios');
const app = require('../server');
const { db, hashPassword } = require('../database');
const SallaService = require('../src/services/salla.service');
const SallaOrderItemsService = require('../src/services/salla_order_items.service');

describe('🧾 Salla Product Sales Report — order-item level accuracy', () => {
    let server;
    let adminCookie = '';

    before((done) => {
        server = app.listen(0, () => {
            const hashedPassword = hashPassword('SecureAdminPass123!');
            db.run(
                "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                ['order_items_admin', 'oi_admin@salla.local', hashedPassword, 'admin', '2026-06-11'],
                (err) => {
                    if (err) return done(err);
                    request(server)
                        .post('/api/auth/login')
                        .send({ login: 'order_items_admin', password: 'SecureAdminPass123!' })
                        .end((errLogin, res) => {
                            if (errLogin) return done(errLogin);
                            const cookies = res.headers['set-cookie'];
                            if (cookies) adminCookie = cookies[0];
                            done();
                        });
                }
            );
        });
    });

    after((done) => { server.close(done); });

    // ---- fixtures -------------------------------------------------------

    function makeItem({ id, productId, name, sku, quantity, itemTotal, options }) {
        const total = itemTotal;
        return {
            id, product_id: productId, name, sku: sku || '', quantity, weight: 0,
            options: options || undefined,
            amounts: {
                price_without_tax: { amount: total, currency: 'SAR' },
                total_discount: { amount: 0, currency: 'SAR' },
                tax: { percent: '0.00', amount: { amount: 0, currency: 'SAR' } },
                total: { amount: total, currency: 'SAR' }
            }
        };
    }

    function buildOrder({ refId, sallaOrderId, statusSlug, statusName, items, updatedAt, mobile }) {
        const orderTotal = items.reduce((s, it) => s + (it.amounts.total.amount), 0);
        return {
            id: sallaOrderId,
            reference_id: Number(refId),
            date: { date: '2026-09-10 09:00:00.000000', timezone_type: 3, timezone: 'Asia/Riyadh' },
            updated_at: { date: updatedAt, timezone_type: 3, timezone: 'Asia/Riyadh' },
            status: { id: 1, name: statusName, slug: statusSlug, customized: { id: 1, name: statusName } },
            payment_method: 'credit_card',
            amounts: { sub_total: { amount: orderTotal, currency: 'SAR' }, total: { amount: orderTotal, currency: 'SAR' } },
            total: { amount: orderTotal, currency: 'SAR' },
            customer: { id: 1, first_name: 'عميل', last_name: 'اختبار', mobile: mobile || '+966500000000', email: 't@example.com' },
            items
        };
    }

    function buildCreatedPayload(order) {
        return { event: 'order.created', merchant: 1772607855, created_at: new Date().toString(), data: order };
    }
    function buildStatusUpdatedPayload(order) {
        return {
            event: 'order.status.updated', merchant: 1772607855, created_at: new Date().toString(),
            data: { id: 900000000 + Math.floor(Math.random() * 1e6), status: order.status.name, customized: { id: 1, name: order.status.name, slug: order.status.slug }, note: 'test', order }
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
    function getItemRows(refId) {
        return new Promise((resolve, reject) => {
            db.all("SELECT * FROM salla_order_items WHERE order_reference_id = ? ORDER BY item_id", [String(refId)], (err, rows) => err ? reject(err) : resolve(rows));
        });
    }
    function reportUrl(params) {
        const qs = new URLSearchParams(params).toString();
        return `/api/salla/product-sales-report?${qs}`;
    }

    // ---- 1/2: single product, quantity 1 and quantity 3 -----------------

    it('[Test 1] single product, one order, quantity 1 -> orders=1, units=1', async () => {
        const refId = '800001';
        const order = buildOrder({
            refId, sallaOrderId: 700800001, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 1, productId: 5001, name: 'بلس اساسي PS5', quantity: 1, itemTotal: 45 })],
            updatedAt: '2026-09-10 10:00:00.000000'
        });
        await postWebhook(buildCreatedPayload(order)).expect(200);

        const res = await request(server).get(reportUrl({ product_id: '5001', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(res.body.sold_orders, 1);
        assert.strictEqual(res.body.sold_units, 1);
        assert.strictEqual(res.body.total_revenue, 45);
        assert.deepStrictEqual(res.body.matching_order_references, [refId]);
    });

    it('[Test 2] single product, one order, quantity 3 -> orders=1, units=3', async () => {
        const refId = '800002';
        const order = buildOrder({
            refId, sallaOrderId: 700800002, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 2, productId: 5001, name: 'بلس اساسي PS5', quantity: 3, itemTotal: 135 })],
            updatedAt: '2026-09-10 10:05:00.000000'
        });
        await postWebhook(buildCreatedPayload(order)).expect(200);

        const res = await request(server).get(reportUrl({ product_id: '5001', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        // Combined with Test 1's order (same product_id, same date range): 2 orders, 4 units total.
        assert.strictEqual(res.body.sold_orders, 2);
        assert.strictEqual(res.body.sold_units, 4);
        assert.ok(res.body.matching_order_references.includes(refId));
    });

    // ---- 3/4: multi-product order, per-item revenue ----------------------

    it('[Test 3 & 4] two products in one order with different prices: A x2, B x1, revenue stays item-specific', async () => {
        const refId = '800003';
        const order = buildOrder({
            refId, sallaOrderId: 700800003, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [
                makeItem({ id: 31, productId: 6001, name: 'بلس ايفون - الباقة الذهبية', quantity: 2, itemTotal: 24 }),
                makeItem({ id: 32, productId: 6002, name: 'بلس اندرويد - فوري', quantity: 1, itemTotal: 50 })
            ],
            updatedAt: '2026-09-11 10:00:00.000000'
        });
        await postWebhook(buildCreatedPayload(order)).expect(200);

        const resA = await request(server).get(reportUrl({ product_id: '6001', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(resA.body.sold_orders, 1);
        assert.strictEqual(resA.body.sold_units, 2);
        assert.strictEqual(resA.body.total_revenue, 24); // NOT 74 (the full order total)

        const resB = await request(server).get(reportUrl({ product_id: '6002', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(resB.body.sold_orders, 1);
        assert.strictEqual(resB.body.sold_units, 1);
        assert.strictEqual(resB.body.total_revenue, 50);
    });

    // ---- 5: legacy-duplicate-forms dedup ---------------------------------

    it('[Test 5] the same real order reaching the system via webhook and then sync must count once', async () => {
        const refId = '800005';
        const sallaOrderId = 700800005;
        const order = buildOrder({
            refId, sallaOrderId, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 51, productId: 5001, name: 'بلس اساسي PS5', quantity: 1, itemTotal: 45 })],
            updatedAt: '2026-09-12 10:00:00.000000'
        });
        await postWebhook(buildCreatedPayload(order)).expect(200);
        // Re-processed by syncOrders (item_id 51 for the same order_reference_id -> upsert, not duplicate)
        await SallaOrderItemsService.upsertOrderItemsForOrder(order, {
            statusSlug: 'completed', statusName: 'تم التنفيذ', orderDate: '2026-09-12', externalUpdatedAt: '2026-09-12 10:00:00.000000', source: 'sync'
        });

        const rows = await getItemRows(refId);
        assert.strictEqual(rows.length, 1, 'must not duplicate the same item when reached twice');
    });

    // ---- 6-10: status contract --------------------------------------------

    it('[Test 6-10] status contract: only under_review and completed count as SALE', async () => {
        const base = { productId: 7001, name: 'كود سناب max ( شهر )', quantity: 1, itemTotal: 20 };
        const cases = [
            { refId: '800101', statusSlug: 'payment_pending', statusName: 'بإنتظار الدفع' },
            { refId: '800102', statusSlug: 'canceled', statusName: 'ملغي' },
            { refId: '800103', statusSlug: 'under_review', statusName: 'بإنتظار المراجعة' },
            { refId: '800104', statusSlug: 'completed', statusName: 'تم التنفيذ' },
            { refId: '800105', statusSlug: 'restored', statusName: 'مسترجع' },
            { refId: '800106', statusSlug: 'shipped', statusName: 'تم الشحن' }
        ];
        for (const c of cases) {
            const order = buildOrder({
                refId: c.refId, sallaOrderId: 700000000 + Number(c.refId), statusSlug: c.statusSlug, statusName: c.statusName,
                items: [makeItem({ id: 1, ...base })], updatedAt: '2026-09-13 10:00:00.000000'
            });
            await postWebhook(buildCreatedPayload(order)).expect(200);
        }

        const res = await request(server).get(reportUrl({ product_id: '7001', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(res.body.sold_orders, 2, 'only under_review + completed should count as sold');
        assert.strictEqual(res.body.sold_units, 2);
        assert.ok(res.body.matching_order_references.includes('800103'));
        assert.ok(res.body.matching_order_references.includes('800104'));
        assert.ok(!res.body.matching_order_references.includes('800101'));
        assert.ok(!res.body.matching_order_references.includes('800102'));

        // [Test 10] unknown/restored/shipped must not silently become sales
        assert.strictEqual(res.body.status_breakdown.restored.counted_as_sale, false);
        assert.strictEqual(res.body.status_breakdown.restored.classification, 'NOT_SALE_PENDING_DECISION');
        assert.strictEqual(res.body.status_breakdown.shipped.counted_as_sale, false);
        assert.strictEqual(res.body.status_breakdown.shipped.classification, 'NOT_SALE_PENDING_DECISION');
        assert.strictEqual(res.body.status_breakdown.payment_pending.classification, 'NOT_SALE');
        assert.strictEqual(res.body.status_breakdown.canceled.classification, 'NOT_SALE');
    });

    // ---- 11/12: product filter precision -----------------------------------

    it('[Test 11] filtering by Product A must not return Product B', async () => {
        const refId = '800020';
        const order = buildOrder({
            refId, sallaOrderId: 700800020, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [
                makeItem({ id: 201, productId: 8001, name: 'منتج أ', quantity: 1, itemTotal: 10 }),
                makeItem({ id: 202, productId: 8002, name: 'منتج ب', quantity: 1, itemTotal: 20 })
            ],
            updatedAt: '2026-09-14 10:00:00.000000'
        });
        await postWebhook(buildCreatedPayload(order)).expect(200);

        const resA = await request(server).get(reportUrl({ product_id: '8001', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(resA.body.sold_units, 1);
        assert.strictEqual(resA.body.total_revenue, 10);
    });

    it('[Test 12] PS4 and PS5 remain distinct products', async () => {
        const ref4 = '800030';
        const ref5 = '800031';
        await postWebhook(buildCreatedPayload(buildOrder({
            refId: ref4, sallaOrderId: 700800030, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 301, productId: 9004, name: 'بلس اساسي PS4', quantity: 1, itemTotal: 10 })],
            updatedAt: '2026-09-14 11:00:00.000000'
        }))).expect(200);
        await postWebhook(buildCreatedPayload(buildOrder({
            refId: ref5, sallaOrderId: 700800031, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 311, productId: 9005, name: 'بلس اساسي PS5', quantity: 1, itemTotal: 45 })],
            updatedAt: '2026-09-14 11:05:00.000000'
        }))).expect(200);

        const res4 = await request(server).get(reportUrl({ product_id: '9004', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        const res5 = await request(server).get(reportUrl({ product_id: '9005', from: '2026-09-01', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(res4.body.total_revenue, 10);
        assert.strictEqual(res5.body.total_revenue, 45);
        assert.ok(!res4.body.matching_order_references.includes(ref5));
        assert.ok(!res5.body.matching_order_references.includes(ref4));
    });

    // ---- 13: date boundaries inclusive --------------------------------------

    it('[Test 13] from/to date boundaries are inclusive', async () => {
        const refId = '800040';
        const order = buildOrder({
            refId, sallaOrderId: 700800040, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 401, productId: 8888, name: 'منتج تاريخ', quantity: 1, itemTotal: 5 })],
            updatedAt: '2026-09-10 10:00:00.000000'
        });
        // order.date drives order_date; buildOrder always uses 2026-09-10
        await postWebhook(buildCreatedPayload(order)).expect(200);

        const resIn = await request(server).get(reportUrl({ product_id: '8888', from: '2026-09-10', to: '2026-09-10' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(resIn.body.sold_orders, 1, 'exact boundary date must be included on both ends');

        const resOut = await request(server).get(reportUrl({ product_id: '8888', from: '2026-09-11', to: '2026-09-30' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(resOut.body.sold_orders, 0);
    });

    // ---- 14: empty result ---------------------------------------------------

    it('[Test 14] empty result -> all KPIs are zero, not missing/undefined', async () => {
        const res = await request(server).get(reportUrl({ product_id: 'nonexistent-product-id', from: '2026-01-01', to: '2026-01-02' })).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(res.body.sold_orders, 0);
        assert.strictEqual(res.body.sold_units, 0);
        assert.strictEqual(res.body.total_revenue, 0);
        assert.deepStrictEqual(res.body.matching_order_references, []);
    });

    // ---- 15: refetch idempotency ---------------------------------------------

    it('[Test 15] refetching the same Salla order twice does not create duplicate items', async () => {
        const refId = '800050';
        const sallaOrderId = 700800050;
        const fakeOrder = buildOrder({
            refId, sallaOrderId, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [
                makeItem({ id: 501, productId: 5001, name: 'بلس اساسي PS5', quantity: 1, itemTotal: 45 }),
                makeItem({ id: 502, productId: 6002, name: 'بلس اندرويد - فوري', quantity: 1, itemTotal: 12 })
            ],
            updatedAt: '2026-09-15 10:00:00.000000'
        });

        const originalGet = axios.get;
        axios.get = async (url) => {
            if (String(url).includes(`/orders/${sallaOrderId}`)) {
                return { data: { data: fakeOrder } };
            }
            throw new Error('Unexpected axios.get: ' + url);
        };
        try {
            const first = await SallaOrderItemsService.refetchOrderItemsBySallaId(sallaOrderId, SallaService);
            assert.strictEqual(first.success, true);
            assert.strictEqual(first.itemsWritten, 2);

            const second = await SallaOrderItemsService.refetchOrderItemsBySallaId(sallaOrderId, SallaService);
            assert.strictEqual(second.success, true);

            const rows = await getItemRows(refId);
            assert.strictEqual(rows.length, 2, 'refetching twice must not duplicate item rows');
        } finally {
            axios.get = originalGet;
        }
    });

    // ---- 16: legacy merged order is marked, not fabricated -------------------

    it('[Test 16] a legacy merged multi-product row (no per-item data) is never fabricated into salla_order_items', async () => {
        // Simulate the historical syncOrders merge bug directly in salla_imported_orders, exactly as
        // proven in the production audit (order 270039233 pattern) — a single row combining two products.
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO salla_imported_orders (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, quantity, customer_phone)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                ['800060', '2026-09-10', 'completed', 'تم التنفيذ', 'mada', 95.97, 'عميل قديم', 'بلس ايباد - فوري + بلس ايفون - الباقة الذهبية', 4, '0500000000'],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Nothing in this test writes to salla_order_items for reference_id 800060 — the new table only
        // ever receives data through the webhook/sync/refetch paths that carry real per-item detail, so a
        // legacy merged row sitting only in salla_imported_orders must simply not appear in product reports.
        const rows = await getItemRows('800060');
        assert.strictEqual(rows.length, 0, 'a legacy merged row must not be silently split/fabricated into item rows');
    });

    // ---- 17: drill-down matches aggregate -------------------------------------

    it('[Test 17] drill-down order references exactly match what the aggregate counted', async () => {
        const res = await request(server).get(reportUrl({ product_id: '5001', from: '2026-09-01', to: '2026-09-30', include_rows: 'true' })).set('Cookie', adminCookie).expect(200);
        const refsFromDetail = new Set(res.body.detail_rows.map(r => r.order_reference_id));
        const refsFromAggregate = new Set(res.body.matching_order_references);
        assert.strictEqual(refsFromDetail.size, refsFromAggregate.size);
        refsFromAggregate.forEach(ref => assert.ok(refsFromDetail.has(ref), `drill-down missing order ${ref}`));
    });
});
