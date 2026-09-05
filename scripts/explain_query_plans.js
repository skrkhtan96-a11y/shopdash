const db = require('../src/config/db');

function allSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function explainQueries() {
    console.log("=================================================================");
    console.log("📊 EXPLAIN QUERY PLAN ANALYSIS FOR PRODUCT CONTROL CENTER");
    console.log("=================================================================\n");

    const sqlOverview = `
        EXPLAIN QUERY PLAN
        SELECT 
            p.id AS product_id,
            p.product_name,
            p.salla_product_id,
            p.sku,
            p.quantity AS current_stock,
            p.cost_halalas,
            p.price_halalas,
            p.inventory_value_halalas,
            p.category,
            p.current_control_status,
            p.reorder_threshold,
            p.salla_quantity,

            inv.last_inventory_at,
            inv.last_inventory_actual,
            inv.last_inventory_variance,

            pur.last_purchase_at,
            pur.last_purchase_qty,
            pur.last_purchase_unit_cost_halalas,

            COALESCE(sales.total_units_sold, 0) AS total_units_sold,
            COALESCE(sales.total_sales_amount_halalas, 0) AS total_sales_amount_halalas,
            COALESCE(purch.total_purchased_amount_halalas, 0) AS total_purchased_amount_halalas,
            COALESCE(alloc.total_allocated_ad_halalas, 0) AS total_allocated_ad_halalas

        FROM inventory_products p

        LEFT JOIN (
            SELECT product_id, inventory_at AS last_inventory_at, actual_qty AS last_inventory_actual, variance AS last_inventory_variance
            FROM product_inventory_counts
            WHERE is_deleted = 0 AND id IN (
                SELECT MAX(id) FROM product_inventory_counts WHERE is_deleted = 0 GROUP BY product_id
            )
        ) inv ON inv.product_id = p.id

        LEFT JOIN (
            SELECT pi.product_id, ph.purchased_at AS last_purchase_at, pi.quantity AS last_purchase_qty, pi.unit_cost_halalas AS last_purchase_unit_cost_halalas
            FROM purchase_items pi
            JOIN purchase_headers ph ON ph.id = pi.header_id
            WHERE ph.is_deleted = 0 AND pi.id IN (
                SELECT MAX(pi2.id) 
                FROM purchase_items pi2 
                JOIN purchase_headers ph2 ON ph2.id = pi2.header_id 
                WHERE ph2.is_deleted = 0 
                GROUP BY pi2.product_id
            )
        ) pur ON pur.product_id = p.id

        LEFT JOIN (
            SELECT map.product_id, SUM(o.quantity) AS total_units_sold, ROUND(SUM(o.amount) * 100) AS total_sales_amount_halalas
            FROM salla_imported_orders o
            JOIN salla_product_mapping map ON LOWER(TRIM(o.product_name)) = LOWER(TRIM(map.alias_name))
            WHERE map.mapping_status = 'ACTIVE' AND o.status_slug IN ('completed', 'delivered', 'delivering', 'under-review')
            GROUP BY map.product_id
        ) sales ON sales.product_id = p.id

        LEFT JOIN (
            SELECT pi.product_id, SUM(pi.total_amount_halalas) AS total_purchased_amount_halalas
            FROM purchase_items pi
            JOIN purchase_headers ph ON ph.id = pi.header_id
            WHERE ph.is_deleted = 0
            GROUP BY pi.product_id
        ) purch ON purch.product_id = p.id

        LEFT JOIN (
            SELECT product_id, SUM(allocated_amount_halalas) AS total_allocated_ad_halalas
            FROM product_expense_allocations
            WHERE is_deleted = 0 AND allocation_type = 'ADVERTISING'
            GROUP BY product_id
        ) alloc ON alloc.product_id = p.id

        ORDER BY p.id DESC
    `;

    const planRows = await allSql(sqlOverview);
    console.log("1. GET /api/product-control/products Overview Plan:");
    console.table(planRows);

    process.exit(0);
}

explainQueries();
