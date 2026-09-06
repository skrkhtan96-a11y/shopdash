const db = require('../config/db');

function runSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

let transactionLock = Promise.resolve();

const ProductControlRepository = {
    runSql,
    getSql,
    allSql,

    /**
     * Executes atomic SQLite transaction using BEGIN IMMEDIATE with serialization queue
     */
    executeTransaction: async (callback) => {
        let releaseLock;
        const lockPromise = new Promise(resolve => { releaseLock = resolve; });
        const currentLock = transactionLock;
        transactionLock = transactionLock.then(() => lockPromise);

        await currentLock;

        try {
            await runSql("BEGIN IMMEDIATE TRANSACTION");
            try {
                const result = await callback();
                await runSql("COMMIT");
                return result;
            } catch (err) {
                try { await runSql("ROLLBACK"); } catch (rbErr) {}
                throw err;
            }
        } finally {
            releaseLock();
        }
    },

    /**
     * Single CTE query to fetch product overview list without N+1 queries (with pagination)
     */
    getProductsOverview: async (search = '', statusFilter = '', categoryFilter = '', limit = 50, page = 1) => {
        let whereConditions = ['1=1'];
        let params = [];

        if (search) {
            whereConditions.push('(LOWER(p.product_name) LIKE LOWER(?) OR LOWER(p.sku) LIKE LOWER(?) OR LOWER(CAST(p.salla_product_id AS TEXT)) LIKE LOWER(?))');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (statusFilter) {
            whereConditions.push('p.current_control_status = ?');
            params.push(statusFilter);
        }
        if (categoryFilter) {
            whereConditions.push('p.category = ?');
            params.push(categoryFilter);
        }

        const whereSql = whereConditions.join(' AND ');

        // Get total matching count
        const countRow = await getSql(`SELECT COUNT(*) AS total FROM inventory_products p WHERE ${whereSql}`, params);
        const totalCount = countRow ? parseInt(countRow.total, 10) : 0;

        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (parsedPage - 1) * parsedLimit;

        const sql = `
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

                -- أحدث جرد
                inv.last_inventory_at,
                inv.last_inventory_actual,
                inv.last_inventory_variance,

                -- أحدث شراء
                pur.last_purchase_at,
                pur.last_purchase_qty,
                pur.last_purchase_unit_cost_halalas,

                -- مبيعات وإعلانات تراكمية
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

            WHERE ${whereSql}
            ORDER BY p.id DESC
            LIMIT ? OFFSET ?
        `;

        const queryParams = [...params, parsedLimit, offset];
        const rows = await allSql(sql, queryParams);
        return {
            rows,
            total: totalCount,
            page: parsedPage,
            limit: parsedLimit
        };
    },

    getProductById: async (productId) => {
        return getSql("SELECT * FROM inventory_products WHERE id = ?", [productId]);
    },

    updateProductStockAndValue: async (productId, newQty, newCostHalalas, newValueHalalas, newStatus = null) => {
        if (newStatus) {
            return runSql(
                `UPDATE inventory_products 
                 SET quantity = ?, cost_halalas = ?, inventory_value_halalas = ?, current_control_status = ? 
                 WHERE id = ?`,
                [newQty, newCostHalalas, newValueHalalas, newStatus, productId]
            );
        } else {
            return runSql(
                `UPDATE inventory_products 
                 SET quantity = ?, cost_halalas = ?, inventory_value_halalas = ? 
                 WHERE id = ?`,
                [newQty, newCostHalalas, newValueHalalas, productId]
            );
        }
    },

    updateProductControlStatus: async (productId, status) => {
        return runSql(
            `UPDATE inventory_products SET current_control_status = ? WHERE id = ?`,
            [status, productId]
        );
    },

    // --- Mapping Repository Methods ---
    getMappingByProductId: async (productId) => {
        return allSql("SELECT * FROM salla_product_mapping WHERE product_id = ?", [productId]);
    },

    getMappingByAlias: async (aliasName) => {
        return getSql("SELECT * FROM salla_product_mapping WHERE LOWER(TRIM(alias_name)) = LOWER(TRIM(?))", [aliasName]);
    },

    getAllMappings: async () => {
        return allSql(`
            SELECT m.*, p.product_name 
            FROM salla_product_mapping m
            JOIN inventory_products p ON p.id = m.product_id
            ORDER BY m.id DESC
        `);
    },

    getUnmappedOrdersProducts: async () => {
        return allSql(`
            SELECT DISTINCT o.product_name, COUNT(o.id) as order_count, SUM(o.amount) as total_revenue
            FROM salla_imported_orders o
            LEFT JOIN salla_product_mapping m ON LOWER(TRIM(o.product_name)) = LOWER(TRIM(m.alias_name)) AND m.mapping_status = 'ACTIVE'
            WHERE m.id IS NULL AND o.product_name IS NOT NULL AND o.product_name != ''
            GROUP BY o.product_name
            ORDER BY order_count DESC
        `);
    },

    upsertMapping: async (productId, sallaProductId, sku, aliasName, mappingStatus = 'ACTIVE') => {
        const now = new Date().toISOString();
        return runSql(
            `INSERT INTO salla_product_mapping (product_id, salla_product_id, sku, alias_name, mapping_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(alias_name) DO UPDATE SET 
                product_id = excluded.product_id,
                salla_product_id = excluded.salla_product_id,
                sku = excluded.sku,
                mapping_status = excluded.mapping_status`,
            [productId, sallaProductId || null, sku || null, aliasName.trim(), mappingStatus, now]
        );
    },

    // --- Stock Movements Repository Methods ---
    insertStockMovement: async (data) => {
        const {
            product_id,
            movement_type,
            quantity,
            source_reference_id,
            source_item_reference_id,
            source_event_reference_id = 'MAIN',
            movement_at,
            unit_cogs_halalas = null
        } = data;

        const now = new Date().toISOString();
        return runSql(
            `INSERT OR IGNORE INTO product_stock_movements 
            (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at, unit_cogs_halalas, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                product_id,
                movement_type,
                quantity,
                String(source_reference_id),
                String(source_item_reference_id),
                String(source_event_reference_id),
                movement_at || now,
                unit_cogs_halalas !== null && unit_cogs_halalas !== undefined ? parseInt(unit_cogs_halalas, 10) : null,
                now
            ]
        );
    },

    getStockMovements: async (productId, fromDate = null, toDate = null) => {
        let sql = `SELECT * FROM product_stock_movements WHERE product_id = ?`;
        let params = [productId];

        if (fromDate) {
            sql += ` AND datetime(movement_at) >= datetime(?)`;
            params.push(fromDate);
        }
        if (toDate) {
            sql += ` AND datetime(movement_at) <= datetime(?)`;
            params.push(toDate);
        }
        sql += ` ORDER BY datetime(movement_at) DESC, id DESC`;

        return allSql(sql, params);
    },

    getCurrentStockFromMovements: async (productId) => {
        const row = await getSql(
            `SELECT COALESCE(SUM(quantity), 0) AS expected_stock 
             FROM product_stock_movements 
             WHERE product_id = ?`,
            [productId]
        );
        return row ? parseInt(row.expected_stock, 10) : 0;
    },

    getMovementsSumSinceDate: async (productId, movementTypes = [], sinceDate = null) => {
        let sql = `SELECT COALESCE(SUM(quantity), 0) AS total_qty FROM product_stock_movements WHERE product_id = ?`;
        let params = [productId];

        if (movementTypes && movementTypes.length > 0) {
            const placeholders = movementTypes.map(() => '?').join(',');
            sql += ` AND movement_type IN (${placeholders})`;
            params.push(...movementTypes);
        }
        if (sinceDate) {
            sql += ` AND datetime(movement_at) > datetime(?)`;
            params.push(sinceDate);
        }

        const row = await getSql(sql, params);
        return row ? parseInt(row.total_qty, 10) : 0;
    },

    getMovementsSummaryUpToDate: async (productId, upToDate = null) => {
        let sql = `
            SELECT 
                COALESCE(SUM(CASE WHEN movement_type = 'PURCHASE' THEN quantity ELSE 0 END), 0) AS total_purchased,
                COALESCE(SUM(CASE WHEN movement_type IN ('SALE', 'RETURN') THEN ABS(quantity) ELSE 0 END), 0) AS total_sold
            FROM product_stock_movements
            WHERE product_id = ?
        `;
        let params = [productId];
        if (upToDate) {
            sql += ` AND datetime(movement_at) <= datetime(?)`;
            params.push(upToDate);
        }
        const row = await getSql(sql, params);
        return {
            total_purchased: row ? parseInt(row.total_purchased, 10) : 0,
            total_sold: row ? parseInt(row.total_sold, 10) : 0
        };
    },

    // --- Inventory Count Repository Methods ---
    createInventoryCount: async (data) => {
        const {
            product_id,
            inventory_at,
            actual_qty,
            expected_qty_at_count,
            variance,
            notes,
            created_by,
            user_id
        } = data;
        const now = new Date().toISOString();

        const res = await runSql(
            `INSERT INTO product_inventory_counts 
            (product_id, inventory_at, actual_qty, expected_qty_at_count, variance, notes, created_by, user_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                product_id,
                inventory_at || now,
                actual_qty,
                expected_qty_at_count,
                variance,
                notes || null,
                created_by,
                user_id || null,
                now
            ]
        );
        return res.lastID;
    },

    getInventoryCountById: async (countId) => {
        return getSql("SELECT * FROM product_inventory_counts WHERE id = ?", [countId]);
    },

    getLastInventory: async (productId) => {
        return getSql(
            `SELECT * FROM product_inventory_counts 
             WHERE product_id = ? AND is_deleted = 0 
             ORDER BY datetime(inventory_at) DESC, id DESC LIMIT 1`,
            [productId]
        );
    },

    getInventoryCountsHistory: async (productId) => {
        return allSql(
            `SELECT * FROM product_inventory_counts 
             WHERE product_id = ? AND is_deleted = 0 
             ORDER BY datetime(inventory_at) DESC, id DESC`,
            [productId]
        );
    },

    softDeleteInventoryCount: async (countId, deletedBy, reason) => {
        const now = new Date().toISOString();
        return runSql(
            `UPDATE product_inventory_counts 
             SET is_deleted = 1, deleted_by = ?, deleted_at = ?, cancellation_reason = ? 
             WHERE id = ?`,
            [deletedBy, now, reason || null, countId]
        );
    },

    // --- Purchase Repository Methods ---
    createPurchaseHeader: async (data) => {
        const {
            purchased_at,
            supplier,
            invoice_ref,
            expense_id,
            total_invoice_amount_halalas,
            notes,
            created_by,
            user_id
        } = data;
        const now = new Date().toISOString();

        const res = await runSql(
            `INSERT INTO purchase_headers 
            (purchased_at, supplier, invoice_ref, expense_id, total_invoice_amount_halalas, notes, created_by, user_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                purchased_at || now,
                supplier || null,
                invoice_ref || null,
                expense_id || null,
                total_invoice_amount_halalas,
                notes || null,
                created_by,
                user_id || null,
                now
            ]
        );
        return res.lastID;
    },

    createPurchaseItem: async (data) => {
        const {
            header_id,
            product_id,
            quantity,
            unit_cost_halalas,
            total_amount_halalas
        } = data;
        const now = new Date().toISOString();

        const res = await runSql(
            `INSERT INTO purchase_items 
            (header_id, product_id, quantity, unit_cost_halalas, total_amount_halalas, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [header_id, product_id, quantity, unit_cost_halalas, total_amount_halalas, now]
        );
        return res.lastID;
    },

    getPurchaseHeaderById: async (headerId) => {
        return getSql("SELECT * FROM purchase_headers WHERE id = ?", [headerId]);
    },

    getPurchaseItemsByHeaderId: async (headerId) => {
        return allSql("SELECT pi.*, p.product_name FROM purchase_items pi JOIN inventory_products p ON p.id = pi.product_id WHERE pi.header_id = ?", [headerId]);
    },

    getLastPurchaseItem: async (productId) => {
        return getSql(
            `SELECT pi.*, ph.purchased_at, ph.supplier, ph.invoice_ref, ph.expense_id
             FROM purchase_items pi
             JOIN purchase_headers ph ON ph.id = pi.header_id
             WHERE pi.product_id = ? AND ph.is_deleted = 0
             ORDER BY datetime(ph.purchased_at) DESC, pi.id DESC LIMIT 1`,
            [productId]
        );
    },

    getPurchaseInvoicesHistory: async (productId) => {
        return allSql(
            `SELECT pi.*, ph.purchased_at, ph.supplier, ph.invoice_ref, ph.expense_id, ph.created_by, ph.notes
             FROM purchase_items pi
             JOIN purchase_headers ph ON ph.id = pi.header_id
             WHERE pi.product_id = ? AND ph.is_deleted = 0
             ORDER BY datetime(ph.purchased_at) DESC, pi.id DESC`,
            [productId]
        );
    },

    softDeletePurchaseHeader: async (headerId, deletedBy, reason) => {
        const now = new Date().toISOString();
        return runSql(
            `UPDATE purchase_headers 
             SET is_deleted = 1, deleted_by = ?, deleted_at = ?, cancellation_reason = ? 
             WHERE id = ?`,
            [deletedBy, now, reason || null, headerId]
        );
    },

    // --- Expense Allocations Repository Methods ---
    createExpenseAllocation: async (data) => {
        const {
            product_id,
            expense_id,
            allocation_type = 'ADVERTISING',
            platform,
            campaign_name,
            period_from,
            period_to,
            allocated_amount_halalas,
            allocation_ratio = 1.0,
            reference,
            notes,
            created_by
        } = data;
        const now = new Date().toISOString();

        const res = await runSql(
            `INSERT INTO product_expense_allocations 
            (product_id, expense_id, allocation_type, platform, campaign_name, period_from, period_to, allocated_amount_halalas, allocation_ratio, reference, notes, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                product_id,
                expense_id,
                allocation_type,
                platform || null,
                campaign_name || null,
                period_from,
                period_to,
                allocated_amount_halalas,
                allocation_ratio,
                reference || null,
                notes || null,
                created_by,
                now
            ]
        );
        return res.lastID;
    },

    getExpenseAllocationById: async (allocationId) => {
        return getSql("SELECT * FROM product_expense_allocations WHERE id = ?", [allocationId]);
    },

    getExpenseAllocations: async (productId, allocationType = null) => {
        let sql = `SELECT * FROM product_expense_allocations WHERE product_id = ? AND is_deleted = 0`;
        let params = [productId];
        if (allocationType) {
            sql += ` AND allocation_type = ?`;
            params.push(allocationType);
        }
        sql += ` ORDER BY period_from DESC, id DESC`;
        return allSql(sql, params);
    },

    getExpenseAllocatedSum: async (expenseId, excludeAllocationId = null) => {
        let sql = `SELECT SUM(allocated_amount_halalas) as total_allocated 
                   FROM product_expense_allocations 
                   WHERE expense_id = ? AND is_deleted = 0`;
        let params = [expenseId];
        if (excludeAllocationId) {
            sql += ` AND id != ?`;
            params.push(excludeAllocationId);
        }
        const row = await getSql(sql, params);
        return row && row.total_allocated ? parseInt(row.total_allocated, 10) : 0;
    },

    getExpenseById: async (expenseId) => {
        return getSql("SELECT * FROM expenses WHERE id = ?", [expenseId]);
    },

    softDeleteExpenseAllocation: async (allocationId) => {
        return runSql("UPDATE product_expense_allocations SET is_deleted = 1 WHERE id = ?", [allocationId]);
    },

    // --- Product Status & Audit Methods ---
    insertStatusHistory: async (productId, oldStatus, newStatus, changedBy, userId = null, reason = null) => {
        const now = new Date().toISOString();
        return runSql(
            `INSERT INTO product_status_history (product_id, old_status, new_status, changed_by, user_id, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [productId, oldStatus || null, newStatus, changedBy, userId || null, reason || null, now]
        );
    },

    getStatusHistory: async (productId) => {
        return allSql(
            `SELECT * FROM product_status_history 
             WHERE product_id = ? 
             ORDER BY created_at DESC, id DESC`,
            [productId]
        );
    },

    getConfig: async (key) => {
        const row = await getSql("SELECT value FROM product_control_config WHERE key = ?", [key]);
        return row ? row.value : null;
    },

    getAllConfigs: async () => {
        return allSql("SELECT * FROM product_control_config ORDER BY key ASC");
    },

    setConfig: async (key, value, description = '') => {
        const now = new Date().toISOString();
        return runSql(
            `INSERT INTO product_control_config (key, value, description, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, String(value), description, now]
        );
    },

    logAudit: async (entityType, entityId, action, beforeJson, afterJson, userId, username) => {
        const now = new Date().toISOString();
        return runSql(
            `INSERT INTO product_control_audit_logs 
            (entity_type, entity_id, action, before_json, after_json, user_id, username, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                entityType,
                entityId,
                action,
                beforeJson ? JSON.stringify(beforeJson) : null,
                afterJson ? JSON.stringify(afterJson) : null,
                userId || null,
                username || 'System',
                now
            ]
        );
    },

    getAuditLogsForEntity: async (entityType, entityId) => {
        return allSql(
            `SELECT * FROM product_control_audit_logs 
             WHERE entity_type = ? AND entity_id = ? 
             ORDER BY created_at DESC, id DESC`,
            [entityType, entityId]
        );
    }
};

module.exports = ProductControlRepository;

