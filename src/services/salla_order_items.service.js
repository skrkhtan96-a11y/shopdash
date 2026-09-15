const axios = require('axios');
const db = require('../config/db');
const { extractSallaTimestamp } = require('../utils/salla_timestamp');

// Promisified db.run — resolves to the statement result (this.changes available on it).
function dbRunAsync(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbAllAsync(sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

// Extracts one normalized record per real item in a Salla order object. Prefers each item's own
// exact Salla-reported total (item.amounts.total.amount) — this is present on every real order/webhook
// payload observed in production (proven in the Salla sync audit). Only falls back to splitting the
// order's total evenly across items when Salla genuinely provides no per-item amount, and marks that
// row's revenue_source as 'equal_split' so it is never silently confused with an exact figure.
function extractOrderItems(o) {
    const items = o.items || [];
    if (items.length === 0) return [];

    const orderTotal = parseFloat(o.total?.amount ?? o.amounts?.total?.amount ?? 0);

    return items.map((item, idx) => {
        const hasExactAmount = item.amounts && item.amounts.total && typeof item.amounts.total.amount !== 'undefined';
        const quantity = parseInt(item.quantity) || 1;

        let itemTotal, revenueSource;
        if (hasExactAmount) {
            itemTotal = parseFloat(item.amounts.total.amount) || 0;
            revenueSource = 'exact';
        } else {
            itemTotal = items.length > 0 ? orderTotal / items.length : orderTotal;
            revenueSource = 'equal_split';
        }
        const unitPrice = quantity > 0 ? itemTotal / quantity : itemTotal;

        return {
            itemId: String(item.id || item.product_id || ('idx' + idx)),
            productId: item.product_id != null ? String(item.product_id) : null,
            variantId: item.variant_id != null ? String(item.variant_id) : null,
            sku: item.sku || null,
            productName: item.name || 'منتج مستورد',
            optionsJson: item.options ? JSON.stringify(item.options) : null,
            quantity,
            unitPrice,
            itemTotal,
            revenueSource
        };
    });
}

// Atomically inserts or updates one order-item row, guarded by external_updated_at so an
// out-of-order/older event can never overwrite a newer state — same idempotency contract as
// upsertSallaOrderRow() in salla.routes.js. Returns the number of rows changed (0 = rejected as stale).
async function upsertOrderItem(item, orderMeta) {
    const result = await dbRunAsync(`
        INSERT INTO salla_order_items (
            order_reference_id, salla_order_id, item_id, product_id, variant_id, sku,
            product_name, options_json, quantity, unit_price, item_total, revenue_source,
            status_slug, status_name, order_date, external_updated_at, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(order_reference_id, item_id) DO UPDATE SET
            salla_order_id = excluded.salla_order_id,
            product_id = excluded.product_id,
            variant_id = excluded.variant_id,
            sku = excluded.sku,
            product_name = excluded.product_name,
            options_json = excluded.options_json,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            item_total = excluded.item_total,
            revenue_source = excluded.revenue_source,
            status_slug = excluded.status_slug,
            status_name = excluded.status_name,
            order_date = excluded.order_date,
            external_updated_at = excluded.external_updated_at,
            source = excluded.source,
            updated_at = CURRENT_TIMESTAMP
        WHERE excluded.external_updated_at IS NULL
           OR salla_order_items.external_updated_at IS NULL
           OR excluded.external_updated_at >= salla_order_items.external_updated_at
    `, [
        orderMeta.orderReferenceId, orderMeta.sallaOrderId || null, item.itemId, item.productId, item.variantId, item.sku,
        item.productName, item.optionsJson, item.quantity, item.unitPrice, item.itemTotal, item.revenueSource,
        orderMeta.statusSlug, orderMeta.statusName, orderMeta.orderDate, orderMeta.externalUpdatedAt, orderMeta.source
    ]);
    return result.changes;
}

// Writes every item of one order into salla_order_items, then removes any sibling item rows for this
// same order that are no longer part of the current item set (e.g. an order was edited) — but only once
// at least one item in this call was accepted as fresh, so a stale/out-of-order event can never delete
// rows that a newer event already wrote correctly. Safe to call repeatedly with the same order (idempotent).
async function upsertOrderItemsForOrder(o, meta) {
    const items = extractOrderItems(o);
    if (items.length === 0) return { written: 0, items: [] };

    const orderMeta = {
        orderReferenceId: String(o.reference_id),
        sallaOrderId: o.id != null ? String(o.id) : null,
        statusSlug: meta.statusSlug,
        statusName: meta.statusName,
        orderDate: meta.orderDate,
        externalUpdatedAt: meta.externalUpdatedAt,
        source: meta.source || 'webhook'
    };

    const results = [];
    for (const item of items) {
        const changes = await upsertOrderItem(item, orderMeta);
        results.push({ itemId: item.itemId, changes });
    }

    const accepted = results.some(r => r.changes > 0);
    if (accepted) {
        const currentItemIds = results.map(r => r.itemId);
        const placeholders = currentItemIds.map(() => '?').join(',');
        await dbRunAsync(
            `DELETE FROM salla_order_items WHERE order_reference_id = ? AND item_id NOT IN (${placeholders})`,
            [orderMeta.orderReferenceId, ...currentItemIds]
        );
    }

    return { written: results.filter(r => r.changes > 0).length, items: results };
}

// Re-fetches one order directly from Salla by its own internal numeric id (order.id, not reference_id)
// and reconstructs its item-level rows from the authoritative source. Idempotent: calling this twice for
// the same order writes the same rows again (upsert), never duplicates. Used for historical rows whose
// per-item price/identity was lost to the old merged-row representation (see classify_salla_order_items.js).
async function refetchOrderItemsBySallaId(sallaOrderId, SallaServiceRef) {
    const token = await SallaServiceRef.getOrRefreshToken();
    if (!token) {
        return { success: false, error: 'SALLA_NOT_CONNECTED' };
    }

    const response = await axios.get(`https://api.salla.dev/admin/v2/orders/${sallaOrderId}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept-Language': 'ar' }
    });
    const o = response.data && response.data.data;
    if (!o || !o.reference_id) {
        return { success: false, error: 'ORDER_NOT_FOUND' };
    }

    let orderDate = new Date().toISOString().substring(0, 10);
    const rawDate = o.date || o.created_at;
    if (rawDate) {
        if (typeof rawDate === 'string') orderDate = rawDate.substring(0, 10);
        else if (typeof rawDate === 'object' && rawDate.date) orderDate = rawDate.date.substring(0, 10);
    }

    const result = await upsertOrderItemsForOrder(o, {
        statusSlug: o.status?.slug || 'completed',
        statusName: o.status?.name || 'تم التنفيذ',
        orderDate,
        externalUpdatedAt: extractSallaTimestamp(o.updated_at),
        source: 'refetch'
    });

    return { success: true, referenceId: String(o.reference_id), itemsWritten: result.written };
}

async function getProductSalesReport({ from, to, productId, productName, statusSlugs }) {
    const conditions = [];
    const params = [];

    if (from) {
        conditions.push('order_date >= ?');
        params.push(from);
    }
    if (to) {
        conditions.push('order_date <= ?');
        params.push(to);
    }
    if (productId) {
        conditions.push('product_id = ?');
        params.push(String(productId));
    } else if (productName) {
        conditions.push('product_name = ?');
        params.push(productName);
    }
    if (statusSlugs && statusSlugs.length > 0) {
        conditions.push(`status_slug IN (${statusSlugs.map(() => '?').join(',')})`);
        params.push(...statusSlugs);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await dbAllAsync(`SELECT * FROM salla_order_items ${where} ORDER BY order_date DESC`, params);

    const soldOrderRefs = new Set(rows.map(r => r.order_reference_id));
    const soldUnits = rows.reduce((sum, r) => sum + (r.quantity || 0), 0);
    const totalRevenue = rows.reduce((sum, r) => sum + (r.item_total || 0), 0);
    const approximateRevenueCount = rows.filter(r => r.revenue_source !== 'exact').length;

    return {
        sold_orders: soldOrderRefs.size,
        sold_units: soldUnits,
        total_revenue: totalRevenue,
        matching_order_references: Array.from(soldOrderRefs),
        approximate_revenue_row_count: approximateRevenueCount,
        rows
    };
}

module.exports = {
    extractOrderItems,
    upsertOrderItem,
    upsertOrderItemsForOrder,
    refetchOrderItemsBySallaId,
    getProductSalesReport,
    dbRunAsync,
    dbAllAsync
};
