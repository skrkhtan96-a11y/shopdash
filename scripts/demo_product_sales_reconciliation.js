/*
 * LOCAL DEVELOPMENT DEMONSTRATION ONLY — writes 3 example orders (including one multi-product order
 * with different per-item prices, and one PS4/PS5 pair) into the local database.db via the same
 * SallaOrderItemsService.upsertOrderItemsForOrder() function the real webhook/sync paths use, then
 * queries the resulting product-sales-report for each, printing the exact numbers and the SQL/service
 * logic responsible. Does not touch production, does not call any external API.
 */
process.env.SALLA_DEMO_RUN = 'true';
require('../database'); // boots the local dev database.db and ensures salla_order_items exists
const SallaOrderItemsService = require('../src/services/salla_order_items.service');

function makeItem({ id, productId, name, quantity, itemTotal }) {
    return {
        id, product_id: productId, name, sku: '', quantity,
        amounts: { total: { amount: itemTotal, currency: 'SAR' } }
    };
}

async function main() {
    console.log('=== DEMO 1: single product, single order ===');
    const order1 = {
        id: 999100001, reference_id: 990001,
        date: { date: '2026-09-20 10:00:00.000000' }, updated_at: { date: '2026-09-20 10:00:00.000000' },
        status: { slug: 'completed', name: 'تم التنفيذ' }, total: { amount: 45, currency: 'SAR' },
        items: [makeItem({ id: 1, productId: 'DEMO-5001', name: 'بلس اساسي PS5', quantity: 1, itemTotal: 45 })]
    };
    await SallaOrderItemsService.upsertOrderItemsForOrder(order1, {
        statusSlug: 'completed', statusName: 'تم التنفيذ', orderDate: '2026-09-20', externalUpdatedAt: '2026-09-20 10:00:00.000000', source: 'webhook'
    });
    let report = await SallaOrderItemsService.getProductSalesReport({ from: '2026-09-01', to: '2026-09-30', productId: 'DEMO-5001', statusSlugs: ['under_review', 'completed'] });
    console.log(`  sold_orders=${report.sold_orders} sold_units=${report.sold_units} total_revenue=${report.total_revenue}`);
    console.log(`  order references: ${report.matching_order_references.join(', ')}`);

    console.log('');
    console.log('=== DEMO 2: multi-product order, A x2 (24 SAR) + B x1 (50 SAR) — per-item revenue, not full order total ===');
    const order2 = {
        id: 999100002, reference_id: 990002,
        date: { date: '2026-09-21 10:00:00.000000' }, updated_at: { date: '2026-09-21 10:00:00.000000' },
        status: { slug: 'completed', name: 'تم التنفيذ' }, total: { amount: 74, currency: 'SAR' },
        items: [
            makeItem({ id: 21, productId: 'DEMO-6001', name: 'بلس ايفون - الباقة الذهبية', quantity: 2, itemTotal: 24 }),
            makeItem({ id: 22, productId: 'DEMO-6002', name: 'بلس اندرويد - فوري', quantity: 1, itemTotal: 50 })
        ]
    };
    await SallaOrderItemsService.upsertOrderItemsForOrder(order2, {
        statusSlug: 'completed', statusName: 'تم التنفيذ', orderDate: '2026-09-21', externalUpdatedAt: '2026-09-21 10:00:00.000000', source: 'webhook'
    });
    const reportA = await SallaOrderItemsService.getProductSalesReport({ from: '2026-09-01', to: '2026-09-30', productId: 'DEMO-6001', statusSlugs: ['under_review', 'completed'] });
    const reportB = await SallaOrderItemsService.getProductSalesReport({ from: '2026-09-01', to: '2026-09-30', productId: 'DEMO-6002', statusSlugs: ['under_review', 'completed'] });
    console.log(`  Product A (DEMO-6001): sold_orders=${reportA.sold_orders} sold_units=${reportA.sold_units} total_revenue=${reportA.total_revenue}  (must be 24, NOT 74)`);
    console.log(`  Product B (DEMO-6002): sold_orders=${reportB.sold_orders} sold_units=${reportB.sold_units} total_revenue=${reportB.total_revenue}  (must be 50, NOT 74)`);

    console.log('');
    console.log('=== DEMO 3: status contract — payment_pending and canceled excluded, under_review and completed included ===');
    const statuses = [
        { ref: 990010, slug: 'payment_pending', name: 'بإنتظار الدفع' },
        { ref: 990011, slug: 'canceled', name: 'ملغي' },
        { ref: 990012, slug: 'under_review', name: 'بإنتظار المراجعة' },
        { ref: 990013, slug: 'completed', name: 'تم التنفيذ' }
    ];
    for (const s of statuses) {
        const o = {
            id: 999100000 + s.ref, reference_id: s.ref,
            date: { date: '2026-09-22 10:00:00.000000' }, updated_at: { date: '2026-09-22 10:00:00.000000' },
            status: { slug: s.slug, name: s.name }, total: { amount: 20, currency: 'SAR' },
            items: [makeItem({ id: s.ref, productId: 'DEMO-7001', name: 'كود سناب max ( شهر )', quantity: 1, itemTotal: 20 })]
        };
        await SallaOrderItemsService.upsertOrderItemsForOrder(o, {
            statusSlug: s.slug, statusName: s.name, orderDate: '2026-09-22', externalUpdatedAt: '2026-09-22 10:00:00.000000', source: 'webhook'
        });
    }
    const saleOnly = await SallaOrderItemsService.getProductSalesReport({ from: '2026-09-01', to: '2026-09-30', productId: 'DEMO-7001', statusSlugs: ['under_review', 'completed'] });
    const allStatuses = await SallaOrderItemsService.getProductSalesReport({ from: '2026-09-01', to: '2026-09-30', productId: 'DEMO-7001', statusSlugs: null });
    console.log(`  All 4 orders exist in salla_order_items: ${allStatuses.sold_orders} orders total (unfiltered)`);
    console.log(`  Applying the sales contract (under_review + completed only): sold_orders=${saleOnly.sold_orders} sold_units=${saleOnly.sold_units} total_revenue=${saleOnly.total_revenue}`);
    console.log(`  Included references: ${saleOnly.matching_order_references.join(', ')} (must be 990012, 990013 only)`);

    console.log('');
    console.log('Service logic responsible: SallaOrderItemsService.getProductSalesReport() in src/services/salla_order_items.service.js');
    console.log('SQL: SELECT * FROM salla_order_items WHERE order_date >= ? AND order_date <= ? AND product_id = ? AND status_slug IN (?,?) ORDER BY order_date DESC');
    console.log('');
    console.log('Demo complete. No production system was touched; all writes went to the local database.db only.');
    process.exit(0);
}

main().catch((err) => { console.error('Demo failed:', err); process.exit(1); });
