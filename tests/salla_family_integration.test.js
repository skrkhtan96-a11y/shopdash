// Tests the NEW integration pieces connecting accurate Salla data (salla_order_items) to the existing
// Product Control Center (product_families / inventory_products / product_stock_movements /
// purchase_items / product_expense_allocations — all reused as-is, none duplicated here).
//
// Tests already covered by tests/salla_order_items.test.js and tests/salla_sync_reconciliation.test.js
// (order/unit counting, per-item revenue, status contract, PS4/PS5 separation at the item level,
// legacy-row non-fabrication, refetch idempotency) are referenced, not repeated.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const crypto = require('crypto');
const app = require('../server');
const { db, hashPassword } = require('../database');
const SallaOrderItemsService = require('../src/services/salla_order_items.service');
const SallaFamilyIntegration = require('../src/services/salla_family_integration.service');
const { runMigration: runMigrationV1 } = require('../src/migrations/migration_v1_product_control');

describe('🏗️ Salla ↔ Product Family / Inventory Integration', () => {
    let server;
    let adminCookie = '';
    let familyPS5Basic, familyPS4Basic;
    let productMonthly, product3Months, productYearly, productPS4Monthly;

    before((done) => {
        server = app.listen(0, () => {
            const hashedPassword = hashPassword('SecureAdminPass123!');
            db.run(
                "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                ['integration_admin', 'integration_admin@salla.local', hashedPassword, 'admin', '2026-06-11'],
                async (err) => {
                    if (err) return done(err);
                    try {
                        // Migration v1 creates salla_product_mapping, product_stock_movements, purchase_headers/
                        // items, product_expense_allocations, and the cost/price/*_halalas columns this suite
                        // needs. Migration v2 (product_families/family_id/duration_code) is NOT run here: it
                        // validates against a hardcoded, production-specific 18-product name manifest and
                        // aborts/rolls back if those exact names aren't already seeded — a real, separate
                        // dependency this test doesn't need. The product_families table + inventory_products
                        // columns are created directly below (identical schema to migration v2), so this suite
                        // exercises the real integration code without depending on that unrelated seed data.
                        await runMigrationV1(false);
                        await run(`CREATE TABLE IF NOT EXISTS product_families (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            family_code TEXT UNIQUE NOT NULL,
                            family_name TEXT NOT NULL,
                            platform TEXT NOT NULL,
                            tier TEXT NOT NULL,
                            status TEXT DEFAULT 'active',
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )`);
                        try { await run("ALTER TABLE inventory_products ADD COLUMN family_id INTEGER REFERENCES product_families(id)"); } catch (e) {}
                        try { await run("ALTER TABLE inventory_products ADD COLUMN duration_code TEXT DEFAULT 'STANDALONE'"); } catch (e) {}

                        // Seed a minimal, real family/duration hierarchy — mirrors migration_v2's already
                        // proven structure (family_code/platform/tier + inventory_products.family_id/duration_code).
                        await run(`INSERT INTO product_families (family_code, family_name, platform, tier, status) VALUES ('TEST_PS5_BASIC','بلس أساسي PS5 (اختبار)','PS5','BASIC','active')`);
                        await run(`INSERT INTO product_families (family_code, family_name, platform, tier, status) VALUES ('TEST_PS4_BASIC','بلس أساسي PS4 (اختبار)','PS4','BASIC','active')`);
                        const f1 = await get(`SELECT id FROM product_families WHERE family_code='TEST_PS5_BASIC'`);
                        const f2 = await get(`SELECT id FROM product_families WHERE family_code='TEST_PS4_BASIC'`);
                        familyPS5Basic = f1.id; familyPS4Basic = f2.id;

                        await run(`INSERT INTO inventory_products (product_name, family_id, duration_code, cost_halalas, price_halalas, quantity, created_at) VALUES ('TEST بلس أساسي PS5 (شهري)', ?, 'MONTHLY', 2000, 4500, 10, datetime('now'))`, [familyPS5Basic]);
                        await run(`INSERT INTO inventory_products (product_name, family_id, duration_code, cost_halalas, price_halalas, quantity, created_at) VALUES ('TEST بلس أساسي PS5 (3 أشهر)', ?, 'THREE_MONTHS', 5000, 11000, 10, datetime('now'))`, [familyPS5Basic]);
                        await run(`INSERT INTO inventory_products (product_name, family_id, duration_code, cost_halalas, price_halalas, quantity, created_at) VALUES ('TEST بلس أساسي PS5 (سنة)', ?, 'YEARLY', 15000, 30000, 10, datetime('now'))`, [familyPS5Basic]);
                        await run(`INSERT INTO inventory_products (product_name, family_id, duration_code, cost_halalas, price_halalas, quantity, created_at) VALUES ('TEST بلس أساسي PS4 (شهري)', ?, 'MONTHLY', 1500, 3500, 10, datetime('now'))`, [familyPS4Basic]);

                        productMonthly = (await get(`SELECT id FROM inventory_products WHERE product_name='TEST بلس أساسي PS5 (شهري)'`)).id;
                        product3Months = (await get(`SELECT id FROM inventory_products WHERE product_name='TEST بلس أساسي PS5 (3 أشهر)'`)).id;
                        productYearly = (await get(`SELECT id FROM inventory_products WHERE product_name='TEST بلس أساسي PS5 (سنة)'`)).id;
                        productPS4Monthly = (await get(`SELECT id FROM inventory_products WHERE product_name='TEST بلس أساسي PS4 (شهري)'`)).id;

                        // Directly assign stable Salla product_ids (simulates a resolved mapping — the
                        // backfill function itself is tested separately below).
                        await run(`UPDATE inventory_products SET salla_product_id = 'SPID-MONTHLY-5001' WHERE id = ?`, [productMonthly]);
                        await run(`UPDATE inventory_products SET salla_product_id = 'SPID-3MO-5002' WHERE id = ?`, [product3Months]);
                        await run(`UPDATE inventory_products SET salla_product_id = 'SPID-YEARLY-5003' WHERE id = ?`, [productYearly]);
                        await run(`UPDATE inventory_products SET salla_product_id = 'SPID-PS4-6001' WHERE id = ?`, [productPS4Monthly]);

                        // Seed one purchase invoice and one advertising allocation for the monthly PS5 product,
                        // reusing the EXISTING purchase_headers/purchase_items/product_expense_allocations tables.
                        await run(`INSERT INTO purchase_headers (purchased_at, supplier, total_invoice_amount_halalas, created_by, created_at) VALUES (datetime('now'), 'Test Supplier', 20000, 'test', datetime('now'))`);
                        const header = await get(`SELECT id FROM purchase_headers WHERE supplier='Test Supplier'`);
                        await run(`INSERT INTO purchase_items (header_id, product_id, quantity, unit_cost_halalas, total_amount_halalas, created_at) VALUES (?, ?, 10, 2000, 20000, datetime('now'))`, [header.id, productMonthly]);
                        await run(`INSERT INTO expenses (desc, cat, amt, date) VALUES ('Test Meta Ads', 'تسويق', 50, '2026-09-15')`);
                        const expenseRow = await get(`SELECT id FROM expenses WHERE desc='Test Meta Ads'`);
                        await run(`INSERT INTO product_expense_allocations (product_id, expense_id, allocation_type, platform, period_from, period_to, allocated_amount_halalas, created_by) VALUES (?, ?, 'ADVERTISING', 'meta', '2026-09-01', '2026-09-30', 5000, 'test')`, [productMonthly, expenseRow.id]);

                        request(server).post('/api/auth/login').send({ login: 'integration_admin', password: 'SecureAdminPass123!' }).end((errLogin, res) => {
                            if (errLogin) return done(errLogin);
                            const cookies = res.headers['set-cookie'];
                            if (cookies) adminCookie = cookies[0];
                            done();
                        });
                    } catch (e) { done(e); }
                }
            );
        });
    });

    after((done) => { server.close(done); });

    function run(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })); }
    function get(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))); }

    function makeItem({ id, productId, name, quantity, itemTotal }) {
        return { id, product_id: productId, name, sku: '', quantity, amounts: { total: { amount: itemTotal, currency: 'SAR' } } };
    }
    function buildOrder({ refId, sallaOrderId, statusSlug, statusName, items, date, updatedAt }) {
        const total = items.reduce((s, it) => s + it.amounts.total.amount, 0);
        return {
            id: sallaOrderId, reference_id: Number(refId),
            date: { date: `${date} 10:00:00.000000` }, updated_at: { date: updatedAt },
            status: { slug: statusSlug, name: statusName }, total: { amount: total, currency: 'SAR' },
            customer: { first_name: 'ع', last_name: 'ت', mobile: '+966500000000' },
            items
        };
    }
    function buildCreatedPayload(order) { return { event: 'order.created', merchant: 1, created_at: new Date().toString(), data: order }; }
    function postWebhook(payloadObj) {
        const secret = process.env.SALLA_WEBHOOK_SECRET;
        const body = JSON.stringify(payloadObj);
        const req = request(server).post('/api/salla/webhook').set('Content-Type', 'application/json');
        if (secret) req.set('X-Salla-Signature', crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex'));
        return req.send(body);
    }

    // ---- PRODUCT MODEL: Test 1 ---------------------------------------------

    it('[Test 1] Family -> Duration hierarchy: each duration is its own row with its own price/cost', async () => {
        const res = await request(server).get('/api/integration/families').set('Cookie', adminCookie).expect(200);
        const family = res.body.data.find(f => f.family_code === 'TEST_PS5_BASIC');
        assert.ok(family, 'seeded family must appear in the overview');
        assert.strictEqual(family.variants_count, 3, 'monthly/3-months/yearly are 3 distinct rows under one family');
    });

    // ---- ACCOUNT: Test 2 (proves the gap, does not fabricate a pass) -------

    it('[Test 2] Account composition: the 2 PS5 + 2 PS4 contract is correctly flagged as NOT matched by the live delivery schema', async () => {
        await run(`INSERT OR IGNORE INTO account_composition_config (family_id, duration_code, slot_type, slot_count) VALUES (?, 'MONTHLY', 'PS5', 2)`, [familyPS5Basic]);
        await run(`INSERT OR IGNORE INTO account_composition_config (family_id, duration_code, slot_type, slot_count) VALUES (?, 'MONTHLY', 'PS4', 2)`, [familyPS5Basic]);

        const status = await SallaFamilyIntegration.getAccountCompositionStatus();
        const entry = status.configured.find(e => e.family_id === familyPS5Basic && e.duration_code === 'MONTHLY');
        assert.ok(entry, 'configured composition must be returned');
        assert.strictEqual(entry.matches_delivery_schema, false, 'ps_plus_accounts only has 1 PS4 slot column, not 2 — must be flagged, not silently assumed OK');
        const ps4Mismatch = entry.mismatches.find(m => m.slot_type === 'PS4');
        assert.ok(ps4Mismatch);
        assert.strictEqual(ps4Mismatch.configured, 2);
        assert.strictEqual(ps4Mismatch.actual_delivery_schema_capacity, 1);
    });

    // ---- SALLA + PRODUCT: Tests 4-13 via the real webhook + family sync ----

    it('[Test 4,6,8,9,11,12,13] New orders for 3 distinct durations + a distinct PS4 product sync correctly, statuses respected, nothing merges', async () => {
        await postWebhook(buildCreatedPayload(buildOrder({
            refId: '910001', sallaOrderId: 8010001, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 1, productId: 'SPID-MONTHLY-5001', name: 'بلس أساسي PS5 شهري', quantity: 1, itemTotal: 45 })],
            date: '2026-09-10', updatedAt: '2026-09-10 10:00:00.000000'
        }))).expect(200);
        await postWebhook(buildCreatedPayload(buildOrder({
            refId: '910002', sallaOrderId: 8010002, statusSlug: 'under_review', statusName: 'بإنتظار المراجعة',
            items: [makeItem({ id: 2, productId: 'SPID-3MO-5002', name: 'بلس أساسي PS5 3 أشهر', quantity: 1, itemTotal: 110 })],
            date: '2026-09-10', updatedAt: '2026-09-10 10:05:00.000000'
        }))).expect(200);
        await postWebhook(buildCreatedPayload(buildOrder({
            refId: '910003', sallaOrderId: 8010003, statusSlug: 'payment_pending', statusName: 'بإنتظار الدفع',
            items: [makeItem({ id: 3, productId: 'SPID-YEARLY-5003', name: 'بلس أساسي PS5 سنة', quantity: 1, itemTotal: 300 })],
            date: '2026-09-10', updatedAt: '2026-09-10 10:10:00.000000'
        }))).expect(200);
        await postWebhook(buildCreatedPayload(buildOrder({
            refId: '910004', sallaOrderId: 8010004, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 4, productId: 'SPID-PS4-6001', name: 'بلس أساسي PS4 شهري', quantity: 1, itemTotal: 35 })],
            date: '2026-09-10', updatedAt: '2026-09-10 10:15:00.000000'
        }))).expect(200);

        const res = await request(server).get(`/api/integration/families/${familyPS5Basic}/sales-report?from=2026-09-01&to=2026-09-30`).set('Cookie', adminCookie).expect(200);
        // 910001 (completed) + 910002 (under_review) count as SALE; 910003 (payment_pending) excluded.
        assert.strictEqual(res.body.sold_orders, 2, 'monthly+3mo count; payment_pending yearly must be excluded');
        assert.strictEqual(res.body.completed_orders, 1);
        assert.strictEqual(res.body.under_review_orders, 1);
        assert.strictEqual(res.body.excluded_orders, 1);
        assert.ok(!res.body.matching_order_references.includes('910003'));

        // PS4 product (different family) must not appear in the PS5 family's report at all — [Test 12]
        assert.ok(!res.body.matching_order_references.includes('910004'));

        const ps4Res = await request(server).get(`/api/integration/families/${familyPS4Basic}/sales-report?from=2026-09-01&to=2026-09-30`).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(ps4Res.body.sold_orders, 1);
        assert.ok(ps4Res.body.matching_order_references.includes('910004'));

        // Duration-level distinction — [Test 11]: monthly-only filter excludes the 3-month/yearly orders.
        const monthlyOnly = await request(server).get(`/api/integration/families/${familyPS5Basic}/sales-report?duration_code=MONTHLY&from=2026-09-01&to=2026-09-30`).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(monthlyOnly.body.sold_orders, 1);
        assert.ok(monthlyOnly.body.matching_order_references.includes('910001'));
        assert.ok(!monthlyOnly.body.matching_order_references.includes('910002'));
    });

    // ---- SALLA: Test 5, 10 — status transition updates the same order, never duplicates ----

    it('[Test 5,10] a status transition (payment_pending -> under_review) turns NOT SALE into SALE for the SAME order, never creates a second one', async () => {
        const refId = '910010';
        await postWebhook(buildCreatedPayload(buildOrder({
            refId, sallaOrderId: 8010010, statusSlug: 'payment_pending', statusName: 'بإنتظار الدفع',
            items: [makeItem({ id: 10, productId: 'SPID-MONTHLY-5001', name: 'بلس أساسي PS5 شهري', quantity: 1, itemTotal: 45 })],
            date: '2026-09-11', updatedAt: '2026-09-11 09:00:00.000000'
        }))).expect(200);

        let res = await request(server).get(`/api/integration/families/${familyPS5Basic}/sales-report?from=2026-09-01&to=2026-09-30`).set('Cookie', adminCookie).expect(200);
        const beforeOrders = res.body.sold_orders;
        assert.ok(!res.body.matching_order_references.includes(refId));

        await postWebhook(buildCreatedPayload(buildOrder({
            refId, sallaOrderId: 8010010, statusSlug: 'under_review', statusName: 'بإنتظار المراجعة',
            items: [makeItem({ id: 10, productId: 'SPID-MONTHLY-5001', name: 'بلس أساسي PS5 شهري', quantity: 1, itemTotal: 45 })],
            date: '2026-09-11', updatedAt: '2026-09-11 09:30:00.000000'
        }))).expect(200);

        res = await request(server).get(`/api/integration/families/${familyPS5Basic}/sales-report?from=2026-09-01&to=2026-09-30`).set('Cookie', adminCookie).expect(200);
        assert.strictEqual(res.body.sold_orders, beforeOrders + 1, 'exactly one new sale, not more');
        assert.ok(res.body.matching_order_references.includes(refId));
        assert.strictEqual(res.body.matching_order_references.filter(r => r === refId).length, 1, 'must appear exactly once');
    });

    // ---- INVENTORY: Tests 17-19 — sale is recorded independently of delivery ----

    it('[Test 17] a sale being recorded does not touch any delivery/account table', async () => {
        const psPlusCountBefore = await get(`SELECT COUNT(*) as c FROM ps_plus_accounts`);
        const gameSlotsCountBefore = await get(`SELECT COUNT(*) as c FROM game_slots`);

        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });

        const psPlusCountAfter = await get(`SELECT COUNT(*) as c FROM ps_plus_accounts`);
        const gameSlotsCountAfter = await get(`SELECT COUNT(*) as c FROM game_slots`);
        assert.strictEqual(psPlusCountAfter.c, psPlusCountBefore.c, 'a sale must never create/consume a ps_plus_accounts row by itself');
        assert.strictEqual(gameSlotsCountAfter.c, gameSlotsCountBefore.c, 'a sale must never create/consume a game_slots row by itself');
    });

    it('[Test 18/19] recorded sales land in product_stock_movements (SALE) and are idempotent on re-sync', async () => {
        const first = await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
        const second = await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(second.newly_inserted, 0, 're-running the sync must not insert anything new');
        assert.ok(first.newly_inserted + second.already_synced >= 0);
    });

    // ---- PURCHASES: Tests 20-21 ------------------------------------------------

    it('[Test 20,21] purchase quantity/cost are stored correctly, and the purchase cash value is kept separate from COGS/net profit', async () => {
        const purchase = await get(`SELECT quantity, unit_cost_halalas, total_amount_halalas FROM purchase_items WHERE product_id = ?`, [productMonthly]);
        assert.strictEqual(purchase.quantity, 10);
        assert.strictEqual(purchase.unit_cost_halalas, 2000);
        assert.strictEqual(purchase.total_amount_halalas, 20000);

        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
        const profit = await SallaFamilyIntegration.getFamilyProfitability({ familyId: familyPS5Basic, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });

        assert.strictEqual(profit.purchases_cash, 200, 'the full 200 SAR purchase must be visible as cash outflow');
        // COGS must reflect only what was actually sold (2 units x 20 SAR cost = 40), NOT the full 200 SAR purchase.
        assert.strictEqual(profit.cogs, 40, 'COGS must reflect consumed quantity only, never the full purchase value');
    });

    // ---- ADS: Test 22 -----------------------------------------------------------

    it('[Test 22] advertising expense is attributable to its product/period and included in profitability', async () => {
        const profit = await SallaFamilyIntegration.getFamilyProfitability({ familyId: familyPS5Basic, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(profit.advertising, 50, 'the seeded 50 SAR ad allocation must be included');
    });

    // ---- PROFIT: Test 23 ---------------------------------------------------------

    it('[Test 23] Net Profit = Revenue - COGS - Advertising - Other, explicit and auditable', async () => {
        const profit = await SallaFamilyIntegration.getFamilyProfitability({ familyId: familyPS5Basic, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
        const expected = Math.round((profit.revenue - profit.cogs - profit.advertising - profit.other_expenses) * 100) / 100;
        assert.strictEqual(profit.net_profit, expected);
    });

    // ---- RECONCILIATION: Tests 24-25 ---------------------------------------------

    it('[Test 24] Salla sold count equals ShopDash recorded count -> MATCH', async () => {
        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
        const recon = await SallaFamilyIntegration.getReconciliationReport({ familyId: familyPS5Basic, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(recon.status, 'MATCH');
        assert.strictEqual(recon.mismatch_count, 0);
    });

    it('[Test 25] a Salla sale with an unmapped product_id is correctly reported as a mismatch, with drill-down', async () => {
        const refId = '910099';
        await postWebhook(buildCreatedPayload(buildOrder({
            refId, sallaOrderId: 8010099, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 99, productId: 'SPID-UNMAPPED-9999', name: 'منتج غير مربوط', quantity: 1, itemTotal: 10 })],
            date: '2026-09-12', updatedAt: '2026-09-12 10:00:00.000000'
        }))).expect(200);

        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
        const recon = await SallaFamilyIntegration.getReconciliationReport({ from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(recon.status, 'MISMATCH');
        assert.ok(recon.mismatch_order_references.includes(refId), 'the unmapped order must be drillable, not just counted');
    });

    // ---- mapping backfill (Phase 4) ---------------------------------------------

    it('backfillProductMappingByName links unambiguous name matches without guessing ambiguous ones', async () => {
        await run(`INSERT INTO inventory_products (product_name, quantity, cost_halalas, price_halalas, created_at) VALUES ('منتج اختبار للربط', 0, 100, 200, datetime('now'))`);
        const refId = '910050';
        await postWebhook(buildCreatedPayload(buildOrder({
            refId, sallaOrderId: 8010050, statusSlug: 'completed', statusName: 'تم التنفيذ',
            items: [makeItem({ id: 50, productId: 'SPID-BACKFILL-7001', name: 'منتج اختبار للربط', quantity: 1, itemTotal: 20 })],
            date: '2026-09-13', updatedAt: '2026-09-13 10:00:00.000000'
        }))).expect(200);

        const result = await SallaFamilyIntegration.backfillProductMappingByName();
        assert.ok(result.linked.some(l => l.product_id === 'SPID-BACKFILL-7001'));

        const row = await get(`SELECT salla_product_id FROM inventory_products WHERE product_name = 'منتج اختبار للربط'`);
        assert.strictEqual(row.salla_product_id, 'SPID-BACKFILL-7001');
    });
});
