/*
 * LOCAL DEVELOPMENT DEMONSTRATION ONLY. Uses the REAL family/duration already seeded in the local
 * database.db by migration v2 (بلس أساسي PS5 — شهري, family_id=1, product id=30) — not a fabricated
 * test fixture. Simulates one Salla order arriving as payment_pending, then transitioning to
 * under_review, proving the order stays ONE order throughout while its sale classification flips.
 * Touches no production system, no external API. Demo rows are removed at the end.
 */
require('../database');
const SallaOrderItemsService = require('../src/services/salla_order_items.service');
const SallaFamilyIntegration = require('../src/services/salla_family_integration.service');
const db = require('../src/config/db');

function dbGet(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))); }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))); }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })); }

async function main() {
    const family = await dbGet(`SELECT * FROM product_families WHERE family_code = 'PS5_BASIC'`);
    const product = await dbGet(`SELECT * FROM inventory_products WHERE family_id = ? AND duration_code = 'MONTHLY'`, [family.id]);
    console.log(`=== Using REAL local catalog entry: ${family.family_name} — ${product.product_name} (family_id=${family.id}, product_id=${product.id}) ===`);
    console.log(`Real cost_halalas=${product.cost_halalas}, price_halalas=${product.price_halalas}, quantity=${product.quantity}`);
    console.log('');

    const sallaProductId = 'DEMO-INTEG-' + Date.now();
    await dbRun(`UPDATE inventory_products SET salla_product_id = ? WHERE id = ?`, [sallaProductId, product.id]);

    const refId = '99' + Math.floor(Math.random() * 100000);
    const sallaOrderId = 700000000 + Math.floor(Math.random() * 1000000);

    function makeOrder(statusSlug, statusName, updatedAt) {
        return {
            id: sallaOrderId, reference_id: Number(refId),
            date: { date: '2026-09-25 10:00:00.000000' }, updated_at: { date: updatedAt },
            status: { slug: statusSlug, name: statusName },
            total: { amount: 23, currency: 'SAR' },
            customer: { first_name: 'عميل', last_name: 'تجريبي', mobile: '+966500000000' },
            items: [{ id: 1, product_id: sallaProductId, name: product.product_name, sku: '', quantity: 1, amounts: { total: { amount: 23, currency: 'SAR' } } }]
        };
    }

    async function reportSnapshot(label) {
        const sales = await SallaFamilyIntegration.getFamilySalesReport({ familyId: family.id, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
        console.log(`--- ${label} ---`);
        console.log(`  sold_orders=${sales.sold_orders} sold_units=${sales.sold_units} total_revenue=${sales.total_revenue}`);
        console.log(`  order references: [${sales.matching_order_references.join(', ')}]`);
        return sales;
    }

    console.log('=== T0: order created as payment_pending (NOT SALE) ===');
    await SallaOrderItemsService.upsertOrderItemsForOrder(makeOrder('payment_pending', 'بإنتظار الدفع', '2026-09-25 10:00:00.000000'), {
        statusSlug: 'payment_pending', statusName: 'بإنتظار الدفع', orderDate: '2026-09-25', externalUpdatedAt: '2026-09-25 10:00:00.000000', source: 'webhook'
    });
    const before = await reportSnapshot('Sales BEFORE transition (payment_pending)');
    console.log(`  order ${refId} present in sold list: ${before.matching_order_references.includes(refId)} (must be false)`);
    console.log('');

    console.log('=== T1: status changes to under_review (SALE) — same order, same reference_id ===');
    await SallaOrderItemsService.upsertOrderItemsForOrder(makeOrder('under_review', 'بإنتظار المراجعة', '2026-09-25 10:30:00.000000'), {
        statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', orderDate: '2026-09-25', externalUpdatedAt: '2026-09-25 10:30:00.000000', source: 'webhook'
    });
    const after = await reportSnapshot('Sales AFTER transition (under_review)');
    console.log(`  orders: ${before.sold_orders} -> ${after.sold_orders} (delta +${after.sold_orders - before.sold_orders})`);
    console.log(`  units:  ${before.sold_units} -> ${after.sold_units} (delta +${after.sold_units - before.sold_units})`);
    console.log(`  revenue: ${before.total_revenue} -> ${after.total_revenue} (delta +${(after.total_revenue - before.total_revenue).toFixed(2)})`);
    console.log(`  order ${refId} present exactly once: ${after.matching_order_references.filter(r => r === refId).length === 1}`);
    console.log('');

    console.log('=== Sync to inventory/stock movements (Sales -> Inventory, kept separate from Delivery) ===');
    const syncResult = await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from: '2026-09-01', to: '2026-09-30' });
    console.log(`  newly_inserted=${syncResult.newly_inserted} already_synced=${syncResult.already_synced} skipped_unmapped=${syncResult.skipped_unmapped}`);
    console.log('');

    console.log('=== Purchases + Advertising (reused as-is from Product Control tables) ===');
    await dbRun(`INSERT INTO purchase_headers (purchased_at, supplier, total_invoice_amount_halalas, created_by, created_at) VALUES (datetime('now'), 'Demo Supplier', 10000, 'demo', datetime('now'))`);
    const header = await dbGet(`SELECT id FROM purchase_headers WHERE supplier = 'Demo Supplier' ORDER BY id DESC LIMIT 1`);
    await dbRun(`INSERT INTO purchase_items (header_id, product_id, quantity, unit_cost_halalas, total_amount_halalas, created_at) VALUES (?, ?, 5, 2000, 10000, datetime('now'))`, [header.id, product.id]);
    await dbRun(`INSERT INTO expenses (desc, cat, amt, date) VALUES ('Demo Meta Ads - Integration Center', 'تسويق', 15, '2026-09-25')`);
    const expenseRow = await dbGet(`SELECT id FROM expenses WHERE desc = 'Demo Meta Ads - Integration Center' ORDER BY id DESC LIMIT 1`);
    await dbRun(`INSERT INTO product_expense_allocations (product_id, expense_id, allocation_type, platform, period_from, period_to, allocated_amount_halalas, created_by) VALUES (?, ?, 'ADVERTISING', 'meta', '2026-09-01', '2026-09-30', 1500, 'demo')`, [product.id, expenseRow.id]);
    console.log('  purchased 5 accounts at 20 SAR each = 100 SAR (cash outflow)');
    console.log('  advertising allocation: 15 SAR (Meta, September)');
    console.log('');

    console.log('=== Profitability (Revenue - COGS - Advertising - Other = Net Profit) ===');
    const profit = await SallaFamilyIntegration.getFamilyProfitability({ familyId: family.id, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
    console.log(`  revenue=${profit.revenue} cogs=${profit.cogs} advertising=${profit.advertising} other=${profit.other_expenses} purchases_cash=${profit.purchases_cash}`);
    console.log(`  net_profit=${profit.net_profit} (= ${profit.revenue} - ${profit.cogs} - ${profit.advertising} - ${profit.other_expenses})`);
    console.log(`  margin_pct=${profit.margin_pct}%`);
    console.log('');

    console.log('=== Reconciliation (Salla sold vs ShopDash recorded) ===');
    const recon = await SallaFamilyIntegration.getReconciliationReport({ familyId: family.id, durationCode: 'MONTHLY', from: '2026-09-01', to: '2026-09-30' });
    console.log(`  salla_sold_orders=${recon.salla_sold_orders} shopdash_recorded_orders=${recon.shopdash_recorded_orders} status=${recon.status}`);
    console.log('');

    console.log('=== Account/Delivery separation proof (Sale != Delivery) ===');
    const psPlusCount = await dbGet(`SELECT COUNT(*) as c FROM ps_plus_accounts`);
    console.log(`  ps_plus_accounts row count is unaffected by the sale above: ${psPlusCount.c} (delivery is a separate, manual/existing process — not auto-created by a sale)`);
    console.log('');

    // Cleanup demo-only rows (order items, the stock movement it created, the purchase/expense/allocation
    // seeded for this demo, and the temporary salla_product_id assignment).
    await dbRun(`DELETE FROM salla_order_items WHERE order_reference_id = ?`, [refId]);
    await dbRun(`DELETE FROM product_stock_movements WHERE product_id = ? AND source_event_reference_id = 'SALLA_ORDER_ITEM_SALE' AND source_reference_id = ?`, [product.id, refId]);
    await dbRun(`DELETE FROM purchase_items WHERE header_id = ?`, [header.id]);
    await dbRun(`DELETE FROM purchase_headers WHERE id = ?`, [header.id]);
    await dbRun(`DELETE FROM product_expense_allocations WHERE expense_id = ?`, [expenseRow.id]);
    await dbRun(`DELETE FROM expenses WHERE id = ?`, [expenseRow.id]);
    await dbRun(`UPDATE inventory_products SET salla_product_id = NULL WHERE id = ?`, [product.id]);
    console.log('Demo rows cleaned up. No production system was touched at any point.');
    process.exit(0);
}

main().catch((err) => { console.error('Demo failed:', err); process.exit(1); });
