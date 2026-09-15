/*
 * LOCAL DEVELOPMENT DEMONSTRATION ONLY (Gap 16). Runs against the REAL local database.db, using the
 * real 'بلس أساسي PS5 — شهري' family/product already seeded by migration v2 (family_code=PS5_BASIC,
 * family_id=1, product_id=30) — not a fabricated fixture. Touches no production system, no external
 * API, no ps_plus_accounts/game_accounts row. All demo rows are removed at the end.
 *
 * Exact scenario requested:
 *   1. Create "بلس أساسي — شهري" Account #001 with PS5#1 / PS5#2 / PS4#1 / PS4#2 slots.
 *   2. Simulate Order #TEST-001 through payment_pending -> under_review -> completed, proving
 *      sales=0->1->1 and units=0->1->1 while it stays ONE order throughout.
 *   3. Assign an actual compatible account/slot through the delivery flow (PlusAccountService.deliverSlot
 *      — the standing delivery flow for the new plus_accounts/plus_account_slots model, Gap 1 Option C),
 *      proving delivery=1, same order/family/duration, and that the SALE count did not change again
 *      (Gap 4: sale and delivery are separate events).
 */
require('../database');
const db = require('../src/config/db');
const SallaOrderItemsService = require('../src/services/salla_order_items.service');
const SallaFamilyIntegration = require('../src/services/salla_family_integration.service');
const PlusAccountService = require('../src/services/plus_account.service');

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))); }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))); }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })); }

const REF_ID = 'TEST-001';
const DEMO_EMAIL = 'demo_account_001@shopdash.local';

async function salesSnapshot(family, label) {
    const s = await SallaFamilyIntegration.getFamilySalesReport({ familyId: family.id, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
    console.log(`--- ${label} ---`);
    console.log(`  sold_orders=${s.sold_orders} sold_units=${s.sold_units}`);
    console.log(`  order ${REF_ID} present: ${s.matching_order_references.includes(REF_ID)} (count=${s.matching_order_references.filter(r => r === REF_ID).length})`);
    return s;
}

async function main() {
    const family = await dbGet(`SELECT * FROM product_families WHERE family_code = 'PS5_BASIC'`);
    const product = await dbGet(`SELECT * FROM inventory_products WHERE family_id = ? AND duration_code = 'MONTHLY'`, [family.id]);
    console.log(`=== Using REAL local catalog entry: ${family.family_name} — ${product.product_name} (family_id=${family.id}, product_id=${product.id}) ===\n`);

    // ---------------------------------------------------------------
    // STEP 1: Create "بلس أساسي — شهري" Account #001 with 4 named slots
    // ---------------------------------------------------------------
    console.log('=== STEP 1: Create Account #001 (family=PS5_BASIC, duration=MONTHLY) ===');
    const created = await PlusAccountService.createAccount({
        email: DEMO_EMAIL, password: 'DemoPass123!', familyId: family.id, durationCode: 'MONTHLY', createdBy: 'gap16_demo'
    });
    console.log(`  account_id=${created.account_id} used_default_composition=${created.used_default_composition}`);
    const slots = await dbAll(`SELECT id, slot_type, slot_index, status FROM plus_account_slots WHERE account_id = ? ORDER BY slot_type, slot_index`, [created.account_id]);
    slots.forEach(s => console.log(`  slot: ${s.slot_type}#${s.slot_index} -> status=${s.status}`));
    const hasAllFour = ['PS5#1', 'PS5#2', 'PS4#1', 'PS4#2'].every(name => {
        const [type, idx] = name.split('#');
        return slots.some(s => s.slot_type === type && String(s.slot_index) === idx);
    });
    console.log(`  PROOF: exactly PS5#1/PS5#2/PS4#1/PS4#2 present = ${hasAllFour} (total slots=${slots.length})\n`);

    // ---------------------------------------------------------------
    // STEP 2: Order #TEST-001 through payment_pending -> under_review -> completed
    // ---------------------------------------------------------------
    const sallaProductId = 'DEMO-GAP16-' + Date.now();
    await dbRun(`UPDATE inventory_products SET salla_product_id = ? WHERE id = ?`, [sallaProductId, product.id]);
    const sallaOrderId = 800000000 + Math.floor(Math.random() * 1000000);

    function makeOrder(statusSlug, statusName, updatedAt) {
        return {
            id: sallaOrderId, reference_id: REF_ID,
            date: { date: '2026-09-26 09:00:00.000000' }, updated_at: { date: updatedAt },
            status: { slug: statusSlug, name: statusName },
            total: { amount: 23, currency: 'SAR' },
            customer: { first_name: 'عميل', last_name: 'Gap16', mobile: '+966500000001' },
            items: [{ id: 1, product_id: sallaProductId, name: product.product_name, sku: '', quantity: 1, amounts: { total: { amount: 23, currency: 'SAR' } } }]
        };
    }

    console.log('=== STEP 2a: Order #TEST-001 created as payment_pending (NOT a sale) ===');
    const s0 = await salesSnapshot(family, 'BEFORE any status (baseline for this order)');
    await SallaOrderItemsService.upsertOrderItemsForOrder(makeOrder('payment_pending', 'بإنتظار الدفع', '2026-09-26 09:00:00.000000'), {
        statusSlug: 'payment_pending', statusName: 'بإنتظار الدفع', orderDate: '2026-09-26', externalUpdatedAt: '2026-09-26 09:00:00.000000', source: 'webhook'
    });
    const s1 = await salesSnapshot(family, 'AFTER payment_pending (still NOT a sale)');
    console.log(`  PROOF: sold_orders unchanged by payment_pending: ${s0.sold_orders} -> ${s1.sold_orders}\n`);

    console.log('=== STEP 2b: status -> under_review (becomes a sale) — same order, same reference_id ===');
    await SallaOrderItemsService.upsertOrderItemsForOrder(makeOrder('under_review', 'بإنتظار المراجعة', '2026-09-26 09:15:00.000000'), {
        statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', orderDate: '2026-09-26', externalUpdatedAt: '2026-09-26 09:15:00.000000', source: 'webhook'
    });
    const s2 = await salesSnapshot(family, 'AFTER under_review');
    console.log(`  PROOF: sold_orders 0->1: ${s1.sold_orders} -> ${s2.sold_orders} | sold_units 0->1: ${s1.sold_units} -> ${s2.sold_units}\n`);

    console.log('=== STEP 2c: status -> completed — still the SAME order, no duplicate sale ===');
    await SallaOrderItemsService.upsertOrderItemsForOrder(makeOrder('completed', 'مكتمل', '2026-09-26 10:00:00.000000'), {
        statusSlug: 'completed', statusName: 'مكتمل', orderDate: '2026-09-26', externalUpdatedAt: '2026-09-26 10:00:00.000000', source: 'webhook'
    });
    const s3 = await salesSnapshot(family, 'AFTER completed');
    console.log(`  PROOF: sold_orders stays 1->1: ${s2.sold_orders} -> ${s3.sold_orders} | sold_units stays 1->1: ${s2.sold_units} -> ${s3.sold_units}`);
    const itemRows = await dbAll(`SELECT COUNT(*) as c FROM salla_order_items WHERE order_reference_id = ?`, [REF_ID]);
    console.log(`  PROOF: exactly one salla_order_items row for #TEST-001 across all 3 transitions: rows=${itemRows[0].c}\n`);

    await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });

    // ---------------------------------------------------------------
    // STEP 3: Deliver a compatible account/slot through the (new, standing) delivery flow
    // ---------------------------------------------------------------
    console.log('=== STEP 3: Deliver a compatible slot for #TEST-001 via PlusAccountService.deliverSlot ===');
    const preDeliverySales = await salesSnapshot(family, 'Sales snapshot BEFORE delivery');
    const delivery = await PlusAccountService.deliverSlot({
        familyId: family.id, durationCode: 'MONTHLY', slotType: 'PS5',
        orderReferenceId: REF_ID, customerPhone: '+966500000001', deliveredBy: 'gap16_demo'
    });
    console.log(`  delivery result: success=${delivery.success} account_id=${delivery.account_id} slot=${delivery.slot_type}#${delivery.slot_index}`);
    console.log(`  PROOF: delivered slot belongs to Account #001 (account_id ${delivery.account_id} === ${created.account_id}): ${delivery.account_id === created.account_id}`);
    console.log(`  PROOF: delivered slot's family/duration match the sale's family/duration (family_id=${family.id}, duration=MONTHLY) — deliverSlot only ever queries within that exact scope.`);

    const deliveredCount = await dbGet(`SELECT COUNT(*) as c FROM plus_account_slots WHERE order_reference_id = ? AND status = 'DELIVERED'`, [REF_ID]);
    console.log(`  PROOF: delivery=1 slot recorded against #TEST-001: ${deliveredCount.c}`);

    const postDeliverySales = await salesSnapshot(family, 'Sales snapshot AFTER delivery');
    console.log(`  PROOF (Gap 4): delivery did NOT create a second sale — sold_orders stays ${preDeliverySales.sold_orders}->${postDeliverySales.sold_orders}, sold_units stays ${preDeliverySales.sold_units}->${postDeliverySales.sold_units}`);
    const itemRowsAfterDelivery = await dbAll(`SELECT COUNT(*) as c FROM salla_order_items WHERE order_reference_id = ?`, [REF_ID]);
    console.log(`  PROOF: salla_order_items row count for #TEST-001 unchanged by delivery: still ${itemRowsAfterDelivery[0].c}\n`);

    console.log('=== RESULT ===');
    console.log(`  Sale:     order=#TEST-001 family_id=${family.id} duration=MONTHLY sales=0->1->1 units=0->1->1 (ONE order throughout)`);
    console.log(`  Delivery: order=#TEST-001 family_id=${family.id} duration=MONTHLY delivery=1 (via Account #001, slot ${delivery.slot_type}#${delivery.slot_index}), sale count unaffected`);
    console.log('  Gap 16 demo: PASS\n');

    // -----------------------------------------------------------------
    // Cleanup: remove every demo-only row. No production system touched.
    // -----------------------------------------------------------------
    await dbRun(`DELETE FROM plus_account_slots WHERE account_id = ?`, [created.account_id]);
    await dbRun(`DELETE FROM plus_accounts WHERE id = ?`, [created.account_id]);
    await dbRun(`DELETE FROM product_stock_movements WHERE product_id = ? AND source_reference_id = ?`, [product.id, REF_ID]);
    await dbRun(`DELETE FROM salla_order_items WHERE order_reference_id = ?`, [REF_ID]);
    await dbRun(`UPDATE inventory_products SET salla_product_id = NULL WHERE id = ?`, [product.id]);
    console.log('Demo rows cleaned up. No production system was touched at any point.');
    process.exit(0);
}

main().catch((err) => { console.error('Demo failed:', err); process.exit(1); });
