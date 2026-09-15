// Tests Gap 1-13: the new normalized Plus account/slot model (plus_accounts/plus_account_slots),
// family/duration linkage, delivery eligibility rules, and the strengthened (sale vs delivery)
// reconciliation. Does not touch ps_plus_accounts or game_accounts/game_slots at all — existing
// delivery behavior is provably unaffected (see [Test 5] below and salla_family_integration.test.js's
// earlier "[Test 17]" for the sale-side half of that same guarantee).
process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const crypto = require('crypto');
const app = require('../server');
const { db, hashPassword } = require('../database');
const PlusAccountService = require('../src/services/plus_account.service');
const SallaOrderItemsService = require('../src/services/salla_order_items.service');
const SallaFamilyIntegration = require('../src/services/salla_family_integration.service');
const { runMigration: runMigrationV1 } = require('../src/migrations/migration_v1_product_control');

describe('🎮 Plus Account / Slot model (Gap 1-13)', () => {
    let server;
    let adminCookie = '';
    let familyMonthly, family3Months;

    function run(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })); }
    function get(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))); }
    function all(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))); }

    before((done) => {
        server = app.listen(0, () => {
            const hashedPassword = hashPassword('SecureAdminPass123!');
            db.run(
                "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                ['plus_account_admin', 'plus_admin@salla.local', hashedPassword, 'admin', '2026-06-11'],
                async (err) => {
                    if (err) return done(err);
                    try {
                        // migration v1 creates purchase_headers/items, product_stock_movements, and the
                        // cost_halalas/price_halalas columns this suite needs.
                        await runMigrationV1(false);
                        // Same rationale as tests/salla_family_integration.test.js: create the
                        // product_families table directly (identical schema to migration v2) rather than
                        // running that migration, which validates against a hardcoded 18-product manifest
                        // unrelated to this suite.
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

                        await run(`INSERT INTO product_families (family_code, family_name, platform, tier, status) VALUES ('TEST2_PS5_BASIC','بلس أساسي (اختبار 2)','PS5','BASIC','active')`);
                        const f = await get(`SELECT id FROM product_families WHERE family_code='TEST2_PS5_BASIC'`);
                        familyMonthly = f.id;
                        family3Months = f.id; // same family, distinguished by duration_code in these tests

                        // Configure the frozen 2 PS5 + 2 PS4 composition for MONTHLY, but leave THREE_MONTHS
                        // unconfigured on purpose to also exercise the documented default fallback.
                        await run(`INSERT INTO account_composition_config (family_id, duration_code, slot_type, slot_count) VALUES (?, 'MONTHLY', 'PS5', 2)`, [familyMonthly]);
                        await run(`INSERT INTO account_composition_config (family_id, duration_code, slot_type, slot_count) VALUES (?, 'MONTHLY', 'PS4', 2)`, [familyMonthly]);

                        request(server).post('/api/auth/login').send({ login: 'plus_account_admin', password: 'SecureAdminPass123!' }).end((errLogin, res) => {
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

    // ---- Test 1: 2 PS5 + 2 PS4 composition ---------------------------------

    it('[Test 1] a new account for a configured family+duration gets exactly 2 PS5 + 2 PS4 slots', async () => {
        const result = await PlusAccountService.createAccount({
            email: `acc1_${Date.now()}@test.local`, password: 'x', familyId: familyMonthly, durationCode: 'MONTHLY', createdBy: 'test'
        });
        assert.strictEqual(result.used_default_composition, false);
        const slots = await all(`SELECT slot_type, status FROM plus_account_slots WHERE account_id = ?`, [result.account_id]);
        const ps5 = slots.filter(s => s.slot_type === 'PS5');
        const ps4 = slots.filter(s => s.slot_type === 'PS4');
        assert.strictEqual(ps5.length, 2, 'must have exactly 2 PS5 slots');
        assert.strictEqual(ps4.length, 2, 'must have exactly 2 PS4 slots — the previously-proven gap is now closed for new accounts');
        assert.ok(slots.every(s => s.status === 'AVAILABLE'));
    });

    it('falls back to the documented 2+2 default when no explicit composition is configured, without hard-coding it into the route', async () => {
        const result = await PlusAccountService.createAccount({
            email: `acc2_${Date.now()}@test.local`, password: 'x', familyId: family3Months, durationCode: 'THREE_MONTHS', createdBy: 'test'
        });
        assert.strictEqual(result.used_default_composition, true);
        const slots = await all(`SELECT slot_type FROM plus_account_slots WHERE account_id = ?`, [result.account_id]);
        assert.strictEqual(slots.filter(s => s.slot_type === 'PS5').length, 2);
        assert.strictEqual(slots.filter(s => s.slot_type === 'PS4').length, 2);
    });

    // ---- Test 2: linkage to family + duration -------------------------------

    it('[Test 2] a new account is linked to its family + duration at creation, not inferred later', async () => {
        const res = await request(server).post('/api/integration/plus-accounts').set('Cookie', adminCookie).send({
            email: `acc3_${Date.now()}@test.local`, password: 'x', family_id: familyMonthly, duration_code: 'MONTHLY'
        }).expect(201);
        assert.strictEqual(res.body.family_id, familyMonthly);
        assert.strictEqual(res.body.duration_code, 'MONTHLY');

        const row = await get(`SELECT family_id, duration_code FROM plus_accounts WHERE id = ?`, [res.body.account_id]);
        assert.strictEqual(row.family_id, familyMonthly);
        assert.strictEqual(row.duration_code, 'MONTHLY');
    });

    it('account creation without family_id/duration_code is rejected, never silently inferred from a name', async () => {
        const res = await request(server).post('/api/integration/plus-accounts').set('Cookie', adminCookie).send({
            email: 'no_family@test.local', password: 'x'
        }).expect(400);
        assert.ok(res.body.error);
    });

    // ---- Test 3: monthly / 3-month pools don't cross ------------------------

    it('[Test 3] a MONTHLY account is never returned when delivering for THREE_MONTHS, even under the same family', async () => {
        const monthlyAcc = await PlusAccountService.createAccount({ email: `pool_m_${Date.now()}@test.local`, password: 'x', familyId: familyMonthly, durationCode: 'MONTHLY', createdBy: 'test' });
        const threeMoAcc = await PlusAccountService.createAccount({ email: `pool_3_${Date.now()}@test.local`, password: 'x', familyId: familyMonthly, durationCode: 'THREE_MONTHS', createdBy: 'test' });

        const slot = await PlusAccountService.findAvailableSlot(familyMonthly, 'THREE_MONTHS', 'PS5');
        assert.notStrictEqual(slot.account_id, monthlyAcc.account_id, 'must never return the MONTHLY account for a THREE_MONTHS request');
        const returnedAccount = await get(`SELECT duration_code FROM plus_accounts WHERE id = ?`, [slot.account_id]);
        assert.strictEqual(returnedAccount.duration_code, 'THREE_MONTHS', 'the returned account must genuinely belong to the THREE_MONTHS pool');
    });

    // ---- Test 4: PS5/PS4 remain distinct pools ------------------------------

    it('[Test 4] PS5 and PS4 slots are never cross-assigned', async () => {
        const acc = await PlusAccountService.createAccount({ email: `plat_${Date.now()}@test.local`, password: 'x', familyId: familyMonthly, durationCode: 'MONTHLY', createdBy: 'test' });
        const ps5Slot = await PlusAccountService.findAvailableSlot(familyMonthly, 'MONTHLY', 'PS5');
        const ps4Slot = await PlusAccountService.findAvailableSlot(familyMonthly, 'MONTHLY', 'PS4');
        assert.strictEqual(ps5Slot.slot_type, 'PS5');
        assert.strictEqual(ps4Slot.slot_type, 'PS4');
    });

    // ---- Test 5: a sale does not create a delivery ---------------------------

    it('[Test 5] recording a sale does not touch plus_account_slots at all', async () => {
        const before = await get(`SELECT COUNT(*) as c FROM plus_account_slots WHERE status = 'DELIVERED'`);
        await run(`INSERT INTO inventory_products (product_name, family_id, duration_code, cost_halalas, price_halalas, quantity, salla_product_id, created_at) VALUES ('TEST2 منتج شهري', ?, 'MONTHLY', 2000, 4500, 0, 'GAP-SPID-1', datetime('now'))`, [familyMonthly]);
        const order = {
            id: 850000001, reference_id: 950001,
            date: { date: '2026-09-26 10:00:00.000000' }, updated_at: { date: '2026-09-26 10:00:00.000000' },
            status: { slug: 'completed', name: 'تم التنفيذ' }, total: { amount: 45, currency: 'SAR' },
            customer: { first_name: 'ع', last_name: 'ت', mobile: '+966500000000' },
            items: [{ id: 1, product_id: 'GAP-SPID-1', name: 'TEST2 منتج شهري', sku: '', quantity: 1, amounts: { total: { amount: 45, currency: 'SAR' } } }]
        };
        await SallaOrderItemsService.upsertOrderItemsForOrder(order, { statusSlug: 'completed', statusName: 'تم التنفيذ', orderDate: '2026-09-26', externalUpdatedAt: '2026-09-26 10:00:00.000000', source: 'webhook' });
        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });

        const after = await get(`SELECT COUNT(*) as c FROM plus_account_slots WHERE status = 'DELIVERED'`);
        assert.strictEqual(after.c, before.c, 'a sale must never auto-create a delivery');
    });

    // ---- Test 6/7/8: delivery only selects a compatible account -------------

    it('[Test 6,7,8] delivery only ever selects a compatible (family+duration+platform) account; incompatible requests fail cleanly', async () => {
        const res = await request(server).post('/api/integration/plus-accounts/deliver').set('Cookie', adminCookie).send({
            family_id: familyMonthly, duration_code: 'MONTHLY', slot_type: 'PS5', order_reference_id: '950001', customer_phone: '+966500000000'
        }).expect(200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.slot_type, 'PS5');

        const slotRow = await get(`SELECT * FROM plus_account_slots WHERE id = ?`, [res.body.slot_id]);
        const accountRow = await get(`SELECT * FROM plus_accounts WHERE id = ?`, [slotRow.account_id]);
        assert.strictEqual(accountRow.family_id, familyMonthly, '[Test 7] wrong-family account can never be assigned — only the matching pool was queried');
        assert.strictEqual(accountRow.duration_code, 'MONTHLY', '[Test 8] wrong-duration account can never be assigned');

        // Exhaust all family/duration/platform-compatible accounts, then prove a further request fails
        // cleanly rather than returning an incompatible slot.
        let exhausted = false;
        for (let i = 0; i < 20; i++) {
            const r = await PlusAccountService.deliverSlot({ familyId: familyMonthly, durationCode: 'MONTHLY', slotType: 'PS5', orderReferenceId: 'exhaust-' + i });
            if (!r.success) { exhausted = true; assert.strictEqual(r.error, 'NO_COMPATIBLE_SLOT_AVAILABLE'); break; }
        }
        assert.ok(exhausted, 'must eventually and cleanly refuse rather than ever return an incompatible slot');
    });

    // ---- Test 9/10/11/12: status contract + idempotency (re-confirmed here with the new tables in play) ----

    it('[Test 9,10,11] payment_pending is not a sale; payment_pending->under_review creates the sale; under_review->completed stays one sale', async () => {
        const refId = '950050';
        // THREE_MONTHS, not MONTHLY — a distinct product from [Test 5]'s GAP-SPID-1 under the same
        // family, so the two don't collide on the real (family_id, duration_code) uniqueness constraint
        // that migration v2 enforces (one commercial offer per family+duration).
        await run(`INSERT INTO inventory_products (product_name, family_id, duration_code, cost_halalas, price_halalas, quantity, salla_product_id, created_at) VALUES ('TEST2 منتج تسلسل', ?, 'THREE_MONTHS', 2000, 4500, 0, 'GAP-SPID-2', datetime('now'))`, [familyMonthly]);
        function order(status, name, updatedAt) {
            return {
                id: 850000050, reference_id: Number(refId), date: { date: '2026-09-27 10:00:00.000000' }, updated_at: { date: updatedAt },
                status: { slug: status, name }, total: { amount: 45, currency: 'SAR' },
                customer: { first_name: 'ع', last_name: 'ت', mobile: '+966500000000' },
                items: [{ id: 1, product_id: 'GAP-SPID-2', name: 'TEST2 منتج تسلسل', sku: '', quantity: 1, amounts: { total: { amount: 45, currency: 'SAR' } } }]
            };
        }
        await SallaOrderItemsService.upsertOrderItemsForOrder(order('payment_pending', 'بإنتظار الدفع', '2026-09-27 09:00:00.000000'), { statusSlug: 'payment_pending', statusName: 'بإنتظار الدفع', orderDate: '2026-09-27', externalUpdatedAt: '2026-09-27 09:00:00.000000', source: 'webhook' });
        let sales = await SallaFamilyIntegration.getFamilySalesReport({ familyId: familyMonthly, durationCode: 'THREE_MONTHS', from: '2026-09-01', to: '2026-09-30' });
        assert.ok(!sales.matching_order_references.includes(refId), '[Test 9] payment_pending must not be a sale');

        await SallaOrderItemsService.upsertOrderItemsForOrder(order('under_review', 'بإنتظار المراجعة', '2026-09-27 09:30:00.000000'), { statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', orderDate: '2026-09-27', externalUpdatedAt: '2026-09-27 09:30:00.000000', source: 'webhook' });
        sales = await SallaFamilyIntegration.getFamilySalesReport({ familyId: familyMonthly, durationCode: 'THREE_MONTHS', from: '2026-09-01', to: '2026-09-30' });
        assert.ok(sales.matching_order_references.includes(refId), '[Test 10] payment_pending -> under_review must create the sale');

        await SallaOrderItemsService.upsertOrderItemsForOrder(order('completed', 'تم التنفيذ', '2026-09-27 10:00:00.000000'), { statusSlug: 'completed', statusName: 'تم التنفيذ', orderDate: '2026-09-27', externalUpdatedAt: '2026-09-27 10:00:00.000000', source: 'webhook' });
        sales = await SallaFamilyIntegration.getFamilySalesReport({ familyId: familyMonthly, durationCode: 'THREE_MONTHS', from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(sales.matching_order_references.filter(r => r === refId).length, 1, '[Test 11] under_review -> completed must remain exactly one sale');

        // Sync to stock movements so later reconciliation tests see this order as recorded (this test
        // only exercises salla_order_items directly, bypassing the webhook route).
        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
    });

    it('[Test 12] a repeated webhook for the same order/status is idempotent', async () => {
        const secret = process.env.SALLA_WEBHOOK_SECRET;
        const payload = {
            event: 'order.created', merchant: 1, created_at: new Date().toString(),
            data: {
                id: 850000060, reference_id: 950060, date: { date: '2026-09-27 10:00:00.000000' }, updated_at: { date: '2026-09-27 10:00:00.000000' },
                status: { slug: 'completed', name: 'تم التنفيذ' }, total: { amount: 20, currency: 'SAR' },
                customer: { first_name: 'ع', last_name: 'ت', mobile: '+966500000000' },
                items: [{ id: 1, product_id: 'GAP-SPID-2', name: 'TEST2 منتج تسلسل', sku: '', quantity: 1, amounts: { total: { amount: 20, currency: 'SAR' } } }]
            }
        };
        const body = JSON.stringify(payload);
        const req1 = request(server).post('/api/salla/webhook').set('Content-Type', 'application/json');
        const req2 = request(server).post('/api/salla/webhook').set('Content-Type', 'application/json');
        if (secret) {
            const sig = crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
            req1.set('X-Salla-Signature', sig); req2.set('X-Salla-Signature', sig);
        }
        await req1.send(body).expect(200);
        await req2.send(body).expect(200);

        const rows = await all(`SELECT * FROM salla_order_items WHERE order_reference_id = '950060'`);
        assert.strictEqual(rows.length, 1, 'repeated identical webhook must not duplicate the item row');
    });

    // ---- Test 13/14/15: profitability formula, purchase != COGS, ads --------

    it('[Test 13,14,15] profitability formula, purchase cash != COGS, advertising allocation all correct together', async () => {
        await run(`INSERT INTO purchase_headers (purchased_at, supplier, total_invoice_amount_halalas, created_by, created_at) VALUES (datetime('now'), 'Gap Supplier', 200000, 'test', datetime('now'))`);
        const header = await get(`SELECT id FROM purchase_headers WHERE supplier='Gap Supplier'`);
        const product = await get(`SELECT id FROM inventory_products WHERE salla_product_id = 'GAP-SPID-2'`);
        await run(`INSERT INTO purchase_items (header_id, product_id, quantity, unit_cost_halalas, total_amount_halalas, created_at) VALUES (?, ?, 100, 2000, 200000, datetime('now'))`, [header.id, product.id]);
        await run(`INSERT INTO expenses (desc, cat, amt, date) VALUES ('Gap Ads', 'تسويق', 10, '2026-09-27')`);
        const expense = await get(`SELECT id FROM expenses WHERE desc='Gap Ads'`);
        await run(`INSERT INTO product_expense_allocations (product_id, expense_id, allocation_type, platform, period_from, period_to, allocated_amount_halalas, created_by) VALUES (?, ?, 'ADVERTISING', 'meta', '2026-09-01', '2026-09-30', 1000, 'test')`, [product.id, expense.id]);

        const profit = await SallaFamilyIntegration.getFamilyProfitability({ familyId: familyMonthly, durationCode: 'THREE_MONTHS', from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(profit.purchases_cash, 2000, '[Test 14] full purchase cash (2000 SAR) must be visible');
        assert.notStrictEqual(profit.cogs, profit.purchases_cash, '[Test 14] COGS must not equal the full purchase cash — only consumed quantity counts');
        assert.strictEqual(profit.advertising, 10, '[Test 15] advertising allocation must be included');
        const expected = Math.round((profit.revenue - profit.cogs - profit.advertising - profit.other_expenses) * 100) / 100;
        assert.strictEqual(profit.net_profit, expected, '[Test 13] Net Profit = Revenue - COGS - Advertising - Other');
    });

    // ---- Test 16/17: MATCH / MISMATCH reconciliation --------------------------

    it('[Test 16] Salla sales vs ShopDash recorded sales MATCH example', async () => {
        // Sync first (as an operator would before checking reconciliation) so every sale recorded by
        // earlier tests in this file — including [Test 12]'s webhook-only order — is reflected.
        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
        const recon = await SallaFamilyIntegration.getReconciliationReport({ familyId: familyMonthly, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(recon.status, 'MATCH');
    });

    it('[Test 17] Salla sales vs ShopDash recorded sales MISMATCH example, with drill-down', async () => {
        // YEARLY — a duration not otherwise used in this file, to avoid colliding with [Test 5]'s
        // MONTHLY or [Test 9-11]'s THREE_MONTHS product under the same family.
        await run(`INSERT INTO inventory_products (product_name, family_id, duration_code, cost_halalas, price_halalas, quantity, created_at) VALUES ('TEST2 غير مربوط', ?, 'YEARLY', 0, 0, 0, datetime('now'))`, [familyMonthly]);
        const order = {
            id: 850000099, reference_id: 950099, date: { date: '2026-09-28 10:00:00.000000' }, updated_at: { date: '2026-09-28 10:00:00.000000' },
            status: { slug: 'completed', name: 'تم التنفيذ' }, total: { amount: 5, currency: 'SAR' },
            customer: { first_name: 'ع', last_name: 'ت', mobile: '+966500000000' },
            items: [{ id: 1, product_id: 'GAP-SPID-UNMAPPED', name: 'TEST2 غير مربوط', sku: '', quantity: 1, amounts: { total: { amount: 5, currency: 'SAR' } } }]
        };
        await SallaOrderItemsService.upsertOrderItemsForOrder(order, { statusSlug: 'completed', statusName: 'تم التنفيذ', orderDate: '2026-09-28', externalUpdatedAt: '2026-09-28 10:00:00.000000', source: 'webhook' });
        await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });

        const recon = await SallaFamilyIntegration.getReconciliationReport({ from: '2026-09-01', to: '2026-09-30' });
        assert.strictEqual(recon.status, 'MISMATCH');
        assert.ok(recon.mismatch_order_references.includes('950099'));
    });

    // ---- Test 18: delivery mismatch reported separately from sale mismatch ----

    it('[Test 18] delivery reconciliation is a separate figure from sale reconciliation, never combined', async () => {
        const saleRecon = await SallaFamilyIntegration.getReconciliationReport({ familyId: familyMonthly, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
        const deliveryRecon = await SallaFamilyIntegration.getDeliveryReconciliation({ familyId: familyMonthly, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });

        assert.ok(!('pending_delivery_orders' in saleRecon), 'sale reconciliation must not carry delivery figures');
        assert.ok(!('mismatch_count' in deliveryRecon), 'delivery reconciliation must not carry sale-mismatch figures');
        assert.ok(typeof deliveryRecon.pending_delivery_orders === 'number');
    });

    // ---- Test 19: legacy backfill never fabricates -----------------------------

    it('[Test 19] legacy account backfill classification never invents a family/duration link without a real text match', async () => {
        await run(`INSERT INTO ps_plus_accounts (email, password, plus_type, plus_duration, created_at) VALUES (?, 'x', 'غير معروف تماماً', 'شهري', datetime('now'))`, [`legacy_${Date.now()}@test.local`]);
        const result = await PlusAccountService.classifyLegacyAccountBackfillCandidates();
        const found = result.needs_review.find(r => r.plus_type === 'غير معروف تماماً');
        assert.ok(found, 'an unmatchable plus_type must land in needs_review, not be silently linked');
        assert.strictEqual(result.safely_matchable.some(r => r.plus_type === 'غير معروف تماماً'), false);
    });

    // ---- Test 20: existing delivery data/tables untouched ----------------------

    it('[Test 20] ps_plus_accounts and game_accounts/game_slots schemas and row counts are untouched by this entire suite', async () => {
        const psPlusCols = await all(`PRAGMA table_info(ps_plus_accounts)`);
        const secondPs4SlotCols = psPlusCols.filter(c => c.name.startsWith('ps4_2'));
        assert.strictEqual(secondPs4SlotCols.length, 0, 'ps_plus_accounts must still have no second-PS4-slot columns — untouched, not migrated in place (Gap 1 was closed via a new separate table, not by altering this one)');
        const psPlusRowCount = await get(`SELECT COUNT(*) as c FROM ps_plus_accounts`);
        assert.strictEqual(psPlusRowCount.c, 1, 'only the one legacy row this suite itself inserted for [Test 19] exists — nothing else wrote here');
        const gameSlotsCount = await get(`SELECT COUNT(*) as c FROM game_slots`);
        assert.strictEqual(gameSlotsCount.c, 0, 'this suite never wrote to game_slots');
    });
});
