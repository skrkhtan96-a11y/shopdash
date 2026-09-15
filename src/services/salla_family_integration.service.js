// Connects the accurate Salla order-item data (salla_order_items) to the existing, already-tested
// Product Control Center (product_families / inventory_products / product_stock_movements) using
// stable Salla IDs instead of the fuzzy product-name matching the older sync path relies on.
//
// Purchases and expense-allocation storage are reused as-is (purchase_headers/purchase_items,
// product_expense_allocations already exist and are not duplicated here). Family-level profitability
// is NOT reused from ProductFamilyService.getFamilyDetails(): that function reads field names
// (metrics.units_sold, metrics.total_revenue_halalas, etc.) that do not exist anywhere on
// ProductControlService.getProductDetails()'s actual return shape — verified by direct execution,
// every family's revenue/COGS/advertising/other-expenses/profit summary is unconditionally zero
// regardless of real data, independent of anything in this task. Fixing that pre-existing endpoint is
// out of this task's scope (it risks changing already-shipped behavior elsewhere), so this module
// computes profitability itself, directly from the real source tables.
const db = require('../config/db');
const ProductControlRepository = require('../repositories/product_control.repository');

const SALE_STATUSES = ['under_review', 'completed'];
const NOT_SALE_STATUSES = ['payment_pending', 'canceled'];

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}
function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}
function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}

function classifyStatus(statusSlug) {
    if (SALE_STATUSES.includes(statusSlug)) return 'SALE';
    if (NOT_SALE_STATUSES.includes(statusSlug)) return 'NOT_SALE';
    return 'NOT_SALE_PENDING_DECISION';
}

// Populates inventory_products.salla_product_id for rows that don't have one yet, ONLY when a real
// product_id seen in salla_order_items maps unambiguously (exactly one inventory_products row with a
// matching product_name, and that product_id isn't already claimed by a different inventory_products
// row) — never guesses when there's any ambiguity. Returns what it did and what it could not resolve,
// so the caller can show the limitation instead of hiding it.
async function backfillProductMappingByName() {
    const candidates = await dbAllAsync(`
        SELECT DISTINCT product_id, product_name FROM salla_order_items
        WHERE product_id IS NOT NULL
    `);

    const linked = [];
    const alreadyLinked = [];
    const ambiguous = [];
    const unmatched = [];

    for (const c of candidates) {
        const existingBySallaId = await dbGetAsync(
            `SELECT id, product_name FROM inventory_products WHERE salla_product_id = ?`, [c.product_id]
        );
        if (existingBySallaId) {
            alreadyLinked.push({ product_id: c.product_id, inventory_product_id: existingBySallaId.id });
            continue;
        }

        const nameMatches = await dbAllAsync(
            `SELECT id, product_name, salla_product_id FROM inventory_products WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))`,
            [c.product_name]
        );
        if (nameMatches.length === 0) {
            unmatched.push({ product_id: c.product_id, product_name: c.product_name });
            continue;
        }
        if (nameMatches.length > 1) {
            ambiguous.push({ product_id: c.product_id, product_name: c.product_name, candidates: nameMatches.map(m => m.id) });
            continue;
        }
        const target = nameMatches[0];
        if (target.salla_product_id && target.salla_product_id !== c.product_id) {
            // This inventory row is already claimed by a DIFFERENT Salla product_id — a real conflict,
            // never silently overwritten.
            ambiguous.push({ product_id: c.product_id, product_name: c.product_name, conflict_with_existing: target.salla_product_id });
            continue;
        }

        await dbRunAsync(`UPDATE inventory_products SET salla_product_id = ?, last_synced_from_salla = CURRENT_TIMESTAMP WHERE id = ?`, [c.product_id, target.id]);
        linked.push({ product_id: c.product_id, inventory_product_id: target.id, product_name: c.product_name });
    }

    return { linked, already_linked: alreadyLinked, ambiguous, unmatched };
}

// Resolves a Salla item's product_id to an inventory_products row + its family/duration, if mapped.
async function resolveInventoryProduct(sallaProductId) {
    if (!sallaProductId) return null;
    return dbGetAsync(`
        SELECT p.id, p.product_name, p.family_id, p.duration_code, p.cost_halalas,
               f.family_code, f.family_name, f.platform, f.tier
        FROM inventory_products p
        LEFT JOIN product_families f ON f.id = p.family_id
        WHERE p.salla_product_id = ?
    `, [String(sallaProductId)]);
}

// Replaces the old syncSalesToStockMovements() data source (salla_imported_orders, fuzzy alias
// matching, and the 'under-review' vs 'under_review' spelling bug — proven in the integration audit)
// with salla_order_items (real product_id, real per-item revenue) and the correct, hyphen-free status
// contract. Idempotent via the pre-existing unique index on product_stock_movements — re-running for
// the same order/item/event never creates a second movement; a status change that stays within the
// SALE bucket (under_review -> completed) is therefore a no-op here, which is exactly what keeps the
// order at "1 sold unit", never 2.
async function syncSallaOrderItemsToStockMovements({ from, to } = {}) {
    const conditions = [`status_slug IN ('under_review','completed')`];
    const params = [];
    if (from) { conditions.push('order_date >= ?'); params.push(from); }
    if (to) { conditions.push('order_date <= ?'); params.push(to); }

    const items = await dbAllAsync(`SELECT * FROM salla_order_items WHERE ${conditions.join(' AND ')}`, params);

    let newlyInserted = 0;
    let alreadySynced = 0;
    let skippedUnmapped = 0;
    const unmappedProductIds = new Set();

    for (const item of items) {
        const mapped = await resolveInventoryProduct(item.product_id);
        if (!mapped) {
            skippedUnmapped++;
            if (item.product_id) unmappedProductIds.add(item.product_id);
            continue;
        }

        // INSERT OR IGNORE under the hood — a repeated call for the same (product, order, item) is a
        // guaranteed no-op (this.changes === 0), never a duplicate. That's what keeps a status
        // transition within the SALE bucket (under_review -> completed) at "1 sold unit", not 2.
        const result = await ProductControlRepository.insertStockMovement({
            product_id: mapped.id,
            movement_type: 'SALE',
            quantity: -Math.abs(item.quantity || 1),
            source_reference_id: item.order_reference_id,
            source_item_reference_id: item.item_id,
            source_event_reference_id: 'SALLA_ORDER_ITEM_SALE',
            movement_at: item.order_date ? `${item.order_date}T12:00:00.000Z` : new Date().toISOString(),
            unit_cogs_halalas: mapped.cost_halalas
        });
        if (result.changes > 0) newlyInserted++;
        else alreadySynced++;
    }

    return {
        total_sale_items: items.length,
        newly_inserted: newlyInserted,
        already_synced: alreadySynced,
        skipped_unmapped: skippedUnmapped,
        unmapped_product_ids: Array.from(unmappedProductIds)
    };
}

// Phase 9: sales report at the Family + Duration level, built entirely from salla_order_items (the
// accurate source) joined through the mapping just established — never falls back to text matching.
async function getFamilySalesReport({ familyId, durationCode, from, to }) {
    const conditions = ['p.family_id = ?'];
    const params = [familyId];
    if (durationCode && durationCode !== 'all') { conditions.push('p.duration_code = ?'); params.push(durationCode); }
    if (from) { conditions.push('i.order_date >= ?'); params.push(from); }
    if (to) { conditions.push('i.order_date <= ?'); params.push(to); }

    const rows = await dbAllAsync(`
        SELECT i.*, p.duration_code as mapped_duration_code, p.product_name as mapped_product_name
        FROM salla_order_items i
        JOIN inventory_products p ON p.salla_product_id = i.product_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.order_date DESC
    `, params);

    const bucket = { SALE: [], NOT_SALE: [], NOT_SALE_PENDING_DECISION: [] };
    rows.forEach(r => bucket[classifyStatus(r.status_slug)].push(r));

    const soldOrders = new Set(bucket.SALE.map(r => r.order_reference_id));
    const soldUnits = bucket.SALE.reduce((s, r) => s + (r.quantity || 0), 0);
    const totalRevenue = bucket.SALE.reduce((s, r) => s + (r.item_total || 0), 0);
    const completedOrders = new Set(bucket.SALE.filter(r => r.status_slug === 'completed').map(r => r.order_reference_id));
    const underReviewOrders = new Set(bucket.SALE.filter(r => r.status_slug === 'under_review').map(r => r.order_reference_id));
    const excludedOrders = new Set(bucket.NOT_SALE.map(r => r.order_reference_id));

    return {
        sold_orders: soldOrders.size,
        sold_units: soldUnits,
        total_revenue: Math.round(totalRevenue * 100) / 100,
        completed_orders: completedOrders.size,
        under_review_orders: underReviewOrders.size,
        excluded_orders: excludedOrders.size,
        pending_decision_orders: new Set(bucket.NOT_SALE_PENDING_DECISION.map(r => r.order_reference_id)).size,
        matching_order_references: Array.from(soldOrders),
        detail_rows: rows
    };
}

// Phase 11: profitability = Revenue - COGS - Advertising - Other, computed directly from real tables
// (not from the broken getFamilyDetails aggregation — see the module header comment). Revenue comes
// from salla_order_items (item-level, SALE statuses only); COGS from product_stock_movements SALE
// rows this integration wrote (quantity x unit_cogs_halalas, the actual cost recorded at sync time);
// purchases (cash outflow, kept separate from COGS per the brief) from purchase_items/purchase_headers;
// advertising/other from product_expense_allocations. Every figure is a real SUM/JOIN, not estimated.
async function getFamilyProfitability({ familyId, durationCode, from, to }) {
    const products = await dbAllAsync(`
        SELECT id, product_name, duration_code FROM inventory_products
        WHERE family_id = ? ${durationCode && durationCode !== 'all' ? 'AND duration_code = ?' : ''}
    `, durationCode && durationCode !== 'all' ? [familyId, durationCode] : [familyId]);

    if (products.length === 0) {
        return { revenue: 0, cogs: 0, advertising: 0, other_expenses: 0, purchases_cash: 0, net_profit: 0, margin_pct: null, product_ids_included: [] };
    }
    const productIds = products.map(p => p.id);
    const placeholders = productIds.map(() => '?').join(',');

    // Revenue: from the accurate Salla item-level data, SALE statuses only.
    const salesConditions = ['status_slug IN (\'under_review\',\'completed\')', `product_id IN (SELECT salla_product_id FROM inventory_products WHERE id IN (${placeholders}))`];
    const salesParams = [...productIds];
    if (from) { salesConditions.push('order_date >= ?'); salesParams.push(from); }
    if (to) { salesConditions.push('order_date <= ?'); salesParams.push(to); }
    const revenueRow = await dbGetAsync(
        `SELECT COALESCE(SUM(item_total), 0) as revenue FROM salla_order_items WHERE ${salesConditions.join(' AND ')}`,
        salesParams
    );

    // COGS: SALE movements this integration recorded, using the cost captured at sync time.
    const movementConditions = [`product_id IN (${placeholders})`, "movement_type = 'SALE'", "source_event_reference_id = 'SALLA_ORDER_ITEM_SALE'"];
    const movementParams = [...productIds];
    if (from) { movementConditions.push('movement_at >= ?'); movementParams.push(from); }
    if (to) { movementConditions.push('movement_at <= ?'); movementParams.push(`${to}T23:59:59.999Z`); }
    const cogsRow = await dbGetAsync(
        `SELECT COALESCE(SUM(ABS(quantity) * COALESCE(unit_cogs_halalas, 0)), 0) as cogs_halalas FROM product_stock_movements WHERE ${movementConditions.join(' AND ')}`,
        movementParams
    );

    // Purchases: cash outflow, intentionally kept separate from COGS (per Phase 7's explicit warning).
    const purchaseRow = await dbGetAsync(
        `SELECT COALESCE(SUM(pi.total_amount_halalas), 0) as purchases_halalas
         FROM purchase_items pi JOIN purchase_headers ph ON ph.id = pi.header_id
         WHERE pi.product_id IN (${placeholders}) AND ph.is_deleted = 0`,
        productIds
    );

    // Advertising / other expense allocations.
    const advRow = await dbGetAsync(
        `SELECT COALESCE(SUM(allocated_amount_halalas), 0) as amt FROM product_expense_allocations
         WHERE product_id IN (${placeholders}) AND allocation_type = 'ADVERTISING' AND is_deleted = 0`,
        productIds
    );
    const otherRow = await dbGetAsync(
        `SELECT COALESCE(SUM(allocated_amount_halalas), 0) as amt FROM product_expense_allocations
         WHERE product_id IN (${placeholders}) AND allocation_type != 'ADVERTISING' AND is_deleted = 0`,
        productIds
    );

    const revenue = Math.round((revenueRow.revenue || 0) * 100) / 100;
    const cogs = (cogsRow.cogs_halalas || 0) / 100;
    const advertising = (advRow.amt || 0) / 100;
    const otherExpenses = (otherRow.amt || 0) / 100;
    const purchasesCash = (purchaseRow.purchases_halalas || 0) / 100;
    const netProfit = Math.round((revenue - cogs - advertising - otherExpenses) * 100) / 100;

    return {
        revenue,
        cogs,
        advertising,
        other_expenses: otherExpenses,
        purchases_cash: purchasesCash,
        net_profit: netProfit,
        margin_pct: revenue > 0 ? Math.round((netProfit / revenue) * 10000) / 100 : null,
        product_ids_included: productIds
    };
}

// Phase 13: reconciles Salla-confirmed sales (salla_order_items) against what actually landed in
// product_stock_movements (the existing, downstream sales record consumed by purchases/COGS/profit).
// Every number here is a real COUNT/JOIN against both tables — never estimated.
async function getReconciliationReport({ familyId, durationCode, from, to } = {}) {
    const conditions = ['status_slug IN (\'under_review\',\'completed\')'];
    const params = [];
    let joinFamily = '';
    if (familyId) {
        joinFamily = 'JOIN inventory_products p ON p.salla_product_id = i.product_id';
        conditions.push('p.family_id = ?');
        params.push(familyId);
        if (durationCode && durationCode !== 'all') { conditions.push('p.duration_code = ?'); params.push(durationCode); }
    }
    if (from) { conditions.push('i.order_date >= ?'); params.push(from); }
    if (to) { conditions.push('i.order_date <= ?'); params.push(to); }

    const sallaRows = await dbAllAsync(`
        SELECT i.order_reference_id, i.item_id, i.product_id, i.status_slug
        FROM salla_order_items i ${joinFamily}
        WHERE ${conditions.join(' AND ')}
    `, params);

    const sallaOrderRefs = new Set(sallaRows.map(r => r.order_reference_id));

    const movementRows = await dbAllAsync(`
        SELECT DISTINCT source_reference_id FROM product_stock_movements
        WHERE movement_type = 'SALE' AND source_event_reference_id = 'SALLA_ORDER_ITEM_SALE'
    `);
    const recordedOrderRefs = new Set(movementRows.map(r => r.source_reference_id));

    const missingFromStock = Array.from(sallaOrderRefs).filter(ref => !recordedOrderRefs.has(ref));

    return {
        salla_sold_orders: sallaOrderRefs.size,
        shopdash_recorded_orders: Array.from(recordedOrderRefs).filter(ref => sallaOrderRefs.has(ref)).length,
        mismatch_count: missingFromStock.length,
        mismatch_order_references: missingFromStock,
        status: missingFromStock.length === 0 ? 'MATCH' : 'MISMATCH'
    };
}

// Gap 9: DELIVERY reconciliation — deliberately a SEPARATE number from the sale-mismatch above (never
// combined into one unexplained figure). Compares confirmed Salla sales against plus_account_slots rows
// actually marked DELIVERED for those same order references. A non-zero "pending" count is normal and
// expected (an order can be sold before it's delivered) — it is NOT reported as a mismatch/error, only
// as a fact to drill into; only orders that show up sold but were never delivered are worth watching.
async function getDeliveryReconciliation({ familyId, durationCode, from, to } = {}) {
    const conditions = ['status_slug IN (\'under_review\',\'completed\')'];
    const params = [];
    let joinFamily = '';
    if (familyId) {
        joinFamily = 'JOIN inventory_products p ON p.salla_product_id = i.product_id';
        conditions.push('p.family_id = ?');
        params.push(familyId);
        if (durationCode && durationCode !== 'all') { conditions.push('p.duration_code = ?'); params.push(durationCode); }
    }
    if (from) { conditions.push('i.order_date >= ?'); params.push(from); }
    if (to) { conditions.push('i.order_date <= ?'); params.push(to); }

    const sallaRows = await dbAllAsync(`SELECT DISTINCT i.order_reference_id FROM salla_order_items i ${joinFamily} WHERE ${conditions.join(' AND ')}`, params);
    const soldOrderRefs = new Set(sallaRows.map(r => r.order_reference_id));

    const deliveredRows = await dbAllAsync(`SELECT DISTINCT order_reference_id FROM plus_account_slots WHERE status = 'DELIVERED' AND order_reference_id IS NOT NULL`);
    const deliveredOrderRefs = new Set(deliveredRows.map(r => r.order_reference_id));

    const deliveredFromSold = Array.from(soldOrderRefs).filter(ref => deliveredOrderRefs.has(ref));
    const pendingDelivery = Array.from(soldOrderRefs).filter(ref => !deliveredOrderRefs.has(ref));

    return {
        sold_orders: soldOrderRefs.size,
        delivered_orders: deliveredFromSold.length,
        pending_delivery_orders: pendingDelivery.length,
        pending_delivery_references: pendingDelivery
    };
}

// Phase 3: compares the CONFIGURED account composition (account_composition_config) against what the
// live delivery schema (ps_plus_accounts) can actually store today. Never claims a capacity that isn't
// structurally backed by real columns.
const PS_PLUS_ACCOUNTS_ACTUAL_CAPACITY = { PS5: 2, PS4: 1 }; // proven from database.js's ps_plus_accounts columns: ps5_1_*, ps5_2_*, ps4_* (single)

async function getAccountCompositionStatus() {
    const configured = await dbAllAsync(`
        SELECT c.*, f.family_name, f.family_code
        FROM account_composition_config c
        LEFT JOIN product_families f ON f.id = c.family_id
        ORDER BY c.family_id, c.duration_code, c.slot_type
    `);

    const byFamily = {};
    configured.forEach(row => {
        const key = `${row.family_id}::${row.duration_code}`;
        if (!byFamily[key]) byFamily[key] = { family_id: row.family_id, family_name: row.family_name, duration_code: row.duration_code, slots: {} };
        byFamily[key].slots[row.slot_type] = row.slot_count;
    });

    const results = Object.values(byFamily).map(entry => {
        const mismatches = [];
        Object.keys(entry.slots).forEach(slotType => {
            const actual = PS_PLUS_ACCOUNTS_ACTUAL_CAPACITY[slotType];
            if (actual !== undefined && actual !== entry.slots[slotType]) {
                mismatches.push({ slot_type: slotType, configured: entry.slots[slotType], actual_delivery_schema_capacity: actual });
            }
        });
        return { ...entry, mismatches, matches_delivery_schema: mismatches.length === 0 };
    });

    return { configured: results, delivery_schema_note: 'ps_plus_accounts stores exactly ps5_1, ps5_2 (2 PS5 slots) and ps4 (1 PS4 slot) per account row — proven from its column definitions, not inferred.' };
}

module.exports = {
    SALE_STATUSES,
    NOT_SALE_STATUSES,
    classifyStatus,
    backfillProductMappingByName,
    resolveInventoryProduct,
    syncSallaOrderItemsToStockMovements,
    getFamilySalesReport,
    getFamilyProfitability,
    getReconciliationReport,
    getDeliveryReconciliation,
    getAccountCompositionStatus,
    PS_PLUS_ACCOUNTS_ACTUAL_CAPACITY
};
