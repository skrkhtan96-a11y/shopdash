const ProductControlRepository = require('../repositories/product_control.repository');
const CurrencyUtil = require('../utils/currency');

const ProductControlService = {
    /**
     * Get products overview CTE list with search, filters and pagination
     */
    getProductsOverview: async (search = '', statusFilter = '', categoryFilter = '', limit = 50, page = 1) => {
        const result = await ProductControlRepository.getProductsOverview(search, statusFilter, categoryFilter, limit, page);
        const data = result.rows.map(row => ({
            ...row,
            id: row.product_id,
            cost_sar: CurrencyUtil.halalasToSar(row.cost_halalas),
            price_sar: CurrencyUtil.halalasToSar(row.price_halalas),
            inventory_value_sar: CurrencyUtil.halalasToSar(row.inventory_value_halalas),
            total_sales_amount_sar: CurrencyUtil.halalasToSar(row.total_sales_amount_halalas),
            total_purchased_amount_sar: CurrencyUtil.halalasToSar(row.total_purchased_amount_halalas),
            total_allocated_ad_sar: CurrencyUtil.halalasToSar(row.total_allocated_ad_halalas)
        }));
        return {
            products: data,
            total: result.total,
            page: result.page,
            limit: result.limit
        };
    },

    /**
     * Get detailed product metrics and history with date range validation
     */
    getProductDetails: async (productId, fromDate = null, toDate = null) => {
        const product = await ProductControlRepository.getProductById(productId);
        if (!product) {
            const err = new Error('المنتج غير موجود.');
            err.status = 404;
            err.code = 'PRODUCT_NOT_FOUND';
            throw err;
        }

        // Date Range Validation (Requirement 8)
        let parsedFrom = fromDate;
        let parsedTo = toDate;

        if (fromDate) {
            const dFrom = new Date(fromDate);
            if (isNaN(dFrom.getTime())) {
                const err = new Error('صيغة تاريخ البداية (from) غير صالحة.');
                err.status = 400;
                err.code = 'INVALID_DATE';
                throw err;
            }
            parsedFrom = dFrom.toISOString();
        }

        if (toDate) {
            const dTo = new Date(toDate);
            if (isNaN(dTo.getTime())) {
                const err = new Error('صيغة تاريخ النهاية (to) غير صالحة.');
                err.status = 400;
                err.code = 'INVALID_DATE';
                throw err;
            }
            // Include end of day
            parsedTo = `${toDate.substring(0, 10)}T23:59:59.999Z`;
        }

        if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) {
            const err = new Error('تاريخ البداية (from) لا يمكن أن يكون بعد تاريخ النهاية (to).');
            err.status = 400;
            err.code = 'INVALID_DATE_RANGE';
            throw err;
        }

        const expectedStock = await ProductControlRepository.getCurrentStockFromMovements(productId);
        const lastInventory = await ProductControlRepository.getLastInventory(productId);
        const lastPurchase = await ProductControlRepository.getLastPurchaseItem(productId);

        const lastInvDate = lastInventory ? lastInventory.inventory_at : null;
        const lastPurDate = lastPurchase ? lastPurchase.purchased_at : null;

        const soldSinceLastPurchase = Math.abs(await ProductControlRepository.getMovementsSumSinceDate(productId, ['SALE', 'RETURN'], lastPurDate));
        const soldSinceLastInventory = Math.abs(await ProductControlRepository.getMovementsSumSinceDate(productId, ['SALE', 'RETURN'], lastInvDate));
        const purchasesSinceLastInventory = await ProductControlRepository.getMovementsSumSinceDate(productId, ['PURCHASE'], lastInvDate);

        const stockMovements = await ProductControlRepository.getStockMovements(productId, parsedFrom, parsedTo);
        const inventoryCounts = await ProductControlRepository.getInventoryCountsHistory(productId);
        const purchases = await ProductControlRepository.getPurchaseInvoicesHistory(productId);
        const expenseAllocations = await ProductControlRepository.getExpenseAllocations(productId);
        const statusHistory = await ProductControlRepository.getStatusHistory(productId);
        const mappings = await ProductControlRepository.getMappingByProductId(productId);

        const isCostAvailable = product.cost_halalas > 0 || (purchases && purchases.length > 0);

        return {
            product: {
                ...product,
                cost_sar: isCostAvailable ? CurrencyUtil.halalasToSar(product.cost_halalas) : null,
                price_sar: CurrencyUtil.halalasToSar(product.price_halalas),
                inventory_value_sar: isCostAvailable ? CurrencyUtil.halalasToSar(product.inventory_value_halalas) : null
            },
            cogs_status: isCostAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
            unit_cogs_halalas: isCostAvailable ? product.cost_halalas : null,
            unit_cogs_sar: isCostAvailable ? CurrencyUtil.halalasToSar(product.cost_halalas) : null,
            gross_profit_halalas: isCostAvailable ? (product.price_halalas - product.cost_halalas) : null,
            gross_profit_sar: isCostAvailable ? CurrencyUtil.halalasToSar(product.price_halalas - product.cost_halalas) : null,
            net_profit_halalas: null, // Hidden/null until complete allocation & COGS available
            net_profit_sar: null,
            metrics: {
                expected_stock: expectedStock,
                current_expected_stock: expectedStock,
                actual_stock: product.quantity,
                expected_stock_before_last_count: lastInventory ? lastInventory.expected_qty_at_count : null,
                last_inventory_actual_qty: lastInventory ? lastInventory.actual_qty : null,
                last_inventory_variance: lastInventory ? lastInventory.variance : null,
                last_inventory: lastInventory ? {
                    inventory_at: lastInventory.inventory_at,
                    actual_qty: lastInventory.actual_qty,
                    expected_qty_at_count: lastInventory.expected_qty_at_count,
                    variance: lastInventory.variance
                } : null,
                last_purchase: lastPurchase ? {
                    purchased_at: lastPurchase.purchased_at,
                    quantity: lastPurchase.quantity,
                    unit_cost_halalas: lastPurchase.unit_cost_halalas,
                    unit_cost_sar: CurrencyUtil.halalasToSar(lastPurchase.unit_cost_halalas),
                    supplier: lastPurchase.supplier,
                    invoice_ref: lastPurchase.invoice_ref
                } : null,
                sold_since_last_purchase: soldSinceLastPurchase,
                sold_since_last_inventory: soldSinceLastInventory,
                purchases_since_last_inventory: purchasesSinceLastInventory
            },
            history: {
                stock_movements: stockMovements,
                inventory_counts: inventoryCounts,
                purchases,
                expense_allocations: expenseAllocations,
                status_history: statusHistory,
                mappings
            }
        };
    },

    /**
     * Synchronize Salla sales/returns into idempotent product stock movements
     */
    syncSalesToStockMovements: async () => {
        return ProductControlRepository.executeTransaction(async () => {
            const orders = await ProductControlRepository.allSql(`
                SELECT o.id, o.reference_id, o.date, o.status_slug, o.product_name, o.quantity, o.amount
                FROM salla_imported_orders o
            `);

            let syncedCount = 0;

            for (const order of (orders || [])) {
                const name = (order.product_name || '').trim();
                if (!name) continue;

                // Find active mapping
                const mapping = await ProductControlRepository.getMappingByAlias(name);
                if (!mapping || mapping.mapping_status !== 'ACTIVE') {
                    // UNMAPPED or NEEDS_REVIEW: Skip stock movement to avoid attributing to wrong product
                    continue;
                }

                const productId = mapping.product_id;
                const statusSlug = (order.status_slug || '').toLowerCase();

                const isReturn = ['refunded', 'returned', 'canceled', 'cancelled'].includes(statusSlug);
                const isCompleted = ['completed', 'delivered', 'delivering', 'under-review'].includes(statusSlug);

                if (isCompleted) {
                    // Record SALE movement (negative quantity)
                    const product = await ProductControlRepository.getProductById(productId);
                    const unitCogs = product ? product.cost_halalas : null;

                    await ProductControlRepository.insertStockMovement({
                        product_id: productId,
                        movement_type: 'SALE',
                        quantity: -Math.abs(order.quantity || 1),
                        source_reference_id: order.reference_id,
                        source_item_reference_id: order.id,
                        source_event_reference_id: 'ORDER_SALE',
                        movement_at: order.date ? `${order.date}T12:00:00.000Z` : new Date().toISOString(),
                        unit_cogs_halalas: unitCogs
                    });
                    syncedCount++;
                } else if (isReturn) {
                    // Record RETURN movement (positive quantity)
                    const product = await ProductControlRepository.getProductById(productId);
                    const unitCogs = product ? product.cost_halalas : null;

                    await ProductControlRepository.insertStockMovement({
                        product_id: productId,
                        movement_type: 'RETURN',
                        quantity: Math.abs(order.quantity || 1),
                        source_reference_id: order.reference_id,
                        source_item_reference_id: order.id,
                        source_event_reference_id: `RETURN_${statusSlug.toUpperCase()}`,
                        movement_at: order.date ? `${order.date}T12:00:00.000Z` : new Date().toISOString(),
                        unit_cogs_halalas: unitCogs
                    });
                    syncedCount++;
                }
            }

            return syncedCount;
        });
    },

    /**
     * Record new physical inventory count
     */
    recordInventoryCount: async (productId, countData, user) => {
        if (typeof productId === 'object' && productId !== null) {
            user = countData || user;
            countData = productId;
            productId = countData.product_id;
        }

        return ProductControlRepository.executeTransaction(async () => {
            const product = await ProductControlRepository.getProductById(productId);
            if (!product) {
                const err = new Error('المنتج غير موجود.');
                err.status = 404;
                throw err;
            }

            const { actual_qty, inventory_at, counted_at, notes } = countData;
            const effectiveInventoryAt = inventory_at || counted_at;
            if (actual_qty === undefined || actual_qty === null || isNaN(actual_qty) || actual_qty < 0) {
                const err = new Error('كمية الجرد الفعلي غير صالحة.');
                err.status = 400;
                throw err;
            }

            const currentExpectedStock = await ProductControlRepository.getCurrentStockFromMovements(productId);
            const variance = actual_qty - currentExpectedStock;
            const inventoryTimestamp = inventory_at || new Date().toISOString();

            const countId = await ProductControlRepository.createInventoryCount({
                product_id: productId,
                inventory_at: inventoryTimestamp,
                actual_qty: parseInt(actual_qty, 10),
                expected_qty_at_count: currentExpectedStock,
                variance: variance,
                notes: notes || null,
                created_by: user ? (user.username || user.name || 'System') : 'System',
                user_id: user ? user.id : null
            });

            // Insert adjustment movement if variance != 0
            if (variance !== 0) {
                await ProductControlRepository.insertStockMovement({
                    product_id: productId,
                    movement_type: 'INVENTORY_COUNT',
                    quantity: variance,
                    source_reference_id: countId,
                    source_item_reference_id: productId,
                    source_event_reference_id: 'COUNT_ADJUSTMENT',
                    movement_at: inventoryTimestamp,
                    unit_cogs_halalas: product.cost_halalas
                });
            }

            const newStatus = (variance !== 0 && product.current_control_status !== 'needs_inventory') ? 'under_review' : 'normal';
            const newInventoryValue = parseInt(actual_qty, 10) * product.cost_halalas;

            await ProductControlRepository.updateProductStockAndValue(
                productId,
                parseInt(actual_qty, 10),
                product.cost_halalas,
                newInventoryValue,
                newStatus
            );

            await ProductControlRepository.logAudit(
                'INVENTORY_COUNT',
                countId,
                'CREATE',
                { expected_qty: currentExpectedStock, actual_qty: product.quantity },
                { expected_qty: currentExpectedStock, actual_qty: parseInt(actual_qty, 10), variance, status: newStatus },
                user ? user.id : null,
                user ? (user.username || user.name || 'System') : 'System'
            );

            return {
                count_id: countId,
                actual_qty: parseInt(actual_qty, 10),
                expected_qty: currentExpectedStock,
                variance: variance,
                status: newStatus
            };
        });
    },

    /**
     * Soft delete/cancel inventory count
     */
    cancelInventoryCount: async (productId, countId, reason, user) => {
        return ProductControlRepository.executeTransaction(async () => {
            const count = await ProductControlRepository.getInventoryCountById(countId);
            if (!count || count.product_id !== parseInt(productId, 10) || count.is_deleted === 1) {
                const err = new Error('سجل الجرد غير موجود أو ملغى سابقاً.');
                err.status = 404;
                throw err;
            }

            const username = user ? (user.username || user.name || 'System') : 'System';
            await ProductControlRepository.softDeleteInventoryCount(countId, username, reason);

            // Revert stock adjustment if variance was non-zero
            if (count.variance !== 0) {
                const product = await ProductControlRepository.getProductById(productId);
                const revertedQty = Math.max(0, product.quantity - count.variance);
                const revertedVal = revertedQty * product.cost_halalas;

                await ProductControlRepository.updateProductStockAndValue(
                    productId,
                    revertedQty,
                    product.cost_halalas,
                    revertedVal,
                    'normal'
                );

                await ProductControlRepository.insertStockMovement({
                    product_id: productId,
                    movement_type: 'INVENTORY_COUNT_REVERSAL',
                    quantity: -count.variance,
                    source_reference_id: countId,
                    source_item_reference_id: productId,
                    source_event_reference_id: 'COUNT_CANCELLATION',
                    movement_at: new Date().toISOString(),
                    unit_cogs_halalas: product.cost_halalas
                });
            }

            await ProductControlRepository.logAudit(
                'INVENTORY_COUNT',
                countId,
                'CANCEL',
                count,
                { is_deleted: 1, reason },
                user ? user.id : null,
                username
            );

            return { success: true };
        });
    },

    /**
     * Record new multi-item purchase invoice
     */
    recordPurchaseInvoice: async (invoiceData, user) => {
        return ProductControlRepository.executeTransaction(async () => {
            const { purchased_at, supplier, supplier_name, invoice_ref, expense_id, notes, items } = invoiceData;
            const effectiveSupplier = supplier || supplier_name || null;
            if (!items || !Array.isArray(items) || items.length === 0) {
                const err = new Error('يجب تضمين منتج واحد على الأقل في فاتورة الشراء.');
                err.status = 400;
                throw err;
            }

            // Calculate header total
            let totalHalalas = 0;
            for (const item of items) {
                if (item.unit_cost_halalas === undefined && item.unit_cost_sar !== undefined) {
                    item.unit_cost_halalas = CurrencyUtil.sarToHalalas(item.unit_cost_sar);
                }
                if (!item.product_id || !item.quantity || item.quantity <= 0 || item.unit_cost_halalas === undefined || item.unit_cost_halalas < 0) {
                    const err = new Error('بيانات صنف الشراء غير صالحة.');
                    err.status = 400;
                    throw err;
                }
                const itemTotal = parseInt(item.quantity, 10) * parseInt(item.unit_cost_halalas, 10);
                item.total_amount_halalas = itemTotal;
                totalHalalas += itemTotal;
            }

            const username = user ? (user.username || user.name || 'System') : 'System';
            const purchaseTimestamp = purchased_at || new Date().toISOString();

            const headerId = await ProductControlRepository.createPurchaseHeader({
                purchased_at: purchaseTimestamp,
                supplier: effectiveSupplier,
                invoice_ref: invoice_ref || null,
                expense_id: expense_id || null,
                total_invoice_amount_halalas: totalHalalas,
                notes: notes || null,
                created_by: username,
                user_id: user ? user.id : null
            });

            const createdItems = [];

            for (const item of items) {
                const product = await ProductControlRepository.getProductById(item.product_id);
                if (!product) {
                    throw new Error(`المنتج رقم ${item.product_id} غير موجود.`);
                }

                const itemId = await ProductControlRepository.createPurchaseItem({
                    header_id: headerId,
                    product_id: item.product_id,
                    quantity: parseInt(item.quantity, 10),
                    unit_cost_halalas: parseInt(item.unit_cost_halalas, 10),
                    total_amount_halalas: item.total_amount_halalas
                });

                // Insert stock movement
                await ProductControlRepository.insertStockMovement({
                    product_id: item.product_id,
                    movement_type: 'PURCHASE',
                    quantity: parseInt(item.quantity, 10),
                    source_reference_id: headerId,
                    source_item_reference_id: itemId,
                    source_event_reference_id: 'PURCHASE_MAIN',
                    movement_at: purchaseTimestamp,
                    unit_cogs_halalas: parseInt(item.unit_cost_halalas, 10)
                });

                // Recalculate WAC & update inventory_products
                const currQty = product.cost_halalas > 0 ? (product.quantity || 0) : 0;
                const currValue = product.cost_halalas > 0 ? (product.inventory_value_halalas || 0) : 0;
                const addQty = parseInt(item.quantity, 10);
                const addValue = item.total_amount_halalas;

                const newQty = (product.quantity || 0) + addQty;
                const newValue = currValue + addValue;
                const effectiveQtyForWac = currQty + addQty;
                const newWac = effectiveQtyForWac > 0 ? Math.round(newValue / effectiveQtyForWac) : parseInt(item.unit_cost_halalas, 10);
                const newStatus = (product.current_control_status === 'needs_inventory' || product.current_control_status === 'under_review') ? 'normal' : product.current_control_status;

                await ProductControlRepository.updateProductStockAndValue(
                    item.product_id,
                    newQty,
                    newWac,
                    newValue,
                    newStatus
                );

                createdItems.push({
                    item_id: itemId,
                    product_id: item.product_id,
                    quantity: addQty,
                    unit_cost_halalas: item.unit_cost_halalas,
                    total_amount_halalas: item.total_amount_halalas,
                    new_wac_halalas: newWac,
                    new_stock: newQty
                });
            }

            await ProductControlRepository.logAudit(
                'PURCHASE_HEADER',
                headerId,
                'CREATE',
                null,
                { header_id: headerId, total_halalas: totalHalalas, items_count: items.length },
                user ? user.id : null,
                username
            );

            return {
                header_id: headerId,
                purchased_at: purchaseTimestamp,
                supplier,
                invoice_ref,
                total_invoice_amount_halalas: totalHalalas,
                total_invoice_amount_sar: CurrencyUtil.halalasToSar(totalHalalas),
                items: createdItems
            };
        });
    },

    /**
     * Cancel / reverse purchase invoice atomically
     */
    cancelPurchaseInvoice: async (productId, headerId, reason, user) => {
        return ProductControlRepository.executeTransaction(async () => {
            const header = await ProductControlRepository.getPurchaseHeaderById(headerId);
            if (!header || header.is_deleted === 1) {
                const err = new Error('فاتورة الشراء غير موجودة أو ملغاة سابقاً.');
                err.status = 404;
                throw err;
            }

            const items = await ProductControlRepository.getPurchaseItemsByHeaderId(headerId);
            const username = user ? (user.username || user.name || 'System') : 'System';

            await ProductControlRepository.softDeletePurchaseHeader(headerId, username, reason);

            for (const item of (items || [])) {
                const prod = await ProductControlRepository.getProductById(item.product_id);
                if (prod) {
                    const newQty = Math.max(0, prod.quantity - item.quantity);
                    const newValue = Math.max(0, prod.inventory_value_halalas - item.total_amount_halalas);
                    const newWac = newQty > 0 ? Math.round(newValue / newQty) : prod.cost_halalas;

                    await ProductControlRepository.updateProductStockAndValue(
                        item.product_id,
                        newQty,
                        newWac,
                        newValue
                    );

                    await ProductControlRepository.insertStockMovement({
                        product_id: item.product_id,
                        movement_type: 'PURCHASE_REVERSAL',
                        quantity: -item.quantity,
                        source_reference_id: headerId,
                        source_item_reference_id: item.id,
                        source_event_reference_id: 'PURCHASE_CANCELLATION',
                        movement_at: new Date().toISOString(),
                        unit_cogs_halalas: item.unit_cost_halalas
                    });
                }
            }

            await ProductControlRepository.logAudit(
                'PURCHASE_HEADER',
                headerId,
                'CANCEL',
                header,
                { is_deleted: 1, reason },
                user ? user.id : null,
                username
            );

            return { success: true };
        });
    },

    /**
     * Record expense allocation (ADVERTISING or OTHER) with limit validation
     */
    recordExpenseAllocation: async (allocationData, user) => {
        return ProductControlRepository.executeTransaction(async () => {
            let {
                product_id,
                expense_id,
                allocation_type = 'ADVERTISING',
                platform,
                campaign_name,
                period_from,
                period_to,
                allocated_amount_halalas,
                allocated_amount_sar,
                amount_sar,
                reference,
                notes
            } = allocationData;

            if (allocated_amount_halalas === undefined || allocated_amount_halalas === null) {
                const sarVal = allocated_amount_sar !== undefined ? allocated_amount_sar : amount_sar;
                if (sarVal !== undefined && sarVal !== null) {
                    allocated_amount_halalas = CurrencyUtil.sarToHalalas(sarVal);
                }
            }

            if (!product_id || !expense_id || !allocated_amount_halalas || allocated_amount_halalas <= 0) {
                const err = new Error('بيانات التوزيع غير صالحة.');
                err.status = 400;
                throw err;
            }

            const product = await ProductControlRepository.getProductById(product_id);
            if (!product) {
                const err = new Error('المنتج غير موجود.');
                err.status = 404;
                throw err;
            }

            const expense = await ProductControlRepository.getExpenseById(expense_id);
            if (!expense) {
                const err = new Error('المصروف الأصلي غير موجود.');
                err.status = 404;
                throw err;
            }

            const originalExpenseHalalas = CurrencyUtil.sarToHalalas(expense.amt);
            const currentAllocatedSumHalalas = await ProductControlRepository.getExpenseAllocatedSum(expense_id);
            const proposedTotalHalalas = currentAllocatedSumHalalas + parseInt(allocated_amount_halalas, 10);

            if (proposedTotalHalalas > originalExpenseHalalas) {
                const err = new Error('قيمة التوزيع تزيد عن المبلغ المتبقي للمصروف.');
                err.status = 400;
                err.details = {
                    original_amount_halalas: originalExpenseHalalas,
                    allocated_amount_halalas: currentAllocatedSumHalalas,
                    remaining_amount_halalas: originalExpenseHalalas - currentAllocatedSumHalalas,
                    requested_amount_halalas: parseInt(allocated_amount_halalas, 10)
                };
                throw err;
            }

            const username = user ? (user.username || user.name || 'System') : 'System';

            const allocationId = await ProductControlRepository.createExpenseAllocation({
                product_id,
                expense_id,
                allocation_type,
                platform: platform || null,
                campaign_name: campaign_name || null,
                period_from: period_from || new Date().toISOString().substring(0, 10),
                period_to: period_to || new Date().toISOString().substring(0, 10),
                allocated_amount_halalas: parseInt(allocated_amount_halalas, 10),
                allocation_ratio: originalExpenseHalalas > 0 ? (parseInt(allocated_amount_halalas, 10) / originalExpenseHalalas) : 1.0,
                reference: reference || null,
                notes: notes || null,
                created_by: username
            });

            await ProductControlRepository.logAudit(
                'EXPENSE_ALLOCATION',
                allocationId,
                'CREATE',
                null,
                { allocation_id: allocationId, product_id, expense_id, allocated_amount_halalas },
                user ? user.id : null,
                username
            );

            return {
                allocation_id: allocationId,
                original_amount_halalas: originalExpenseHalalas,
                allocated_amount_halalas: currentAllocatedSumHalalas + parseInt(allocated_amount_halalas, 10),
                remaining_amount_halalas: originalExpenseHalalas - (currentAllocatedSumHalalas + parseInt(allocated_amount_halalas, 10))
            };
        });
    },

    /**
     * Delete expense allocation
     */
    deleteExpenseAllocation: async (productId, allocationId, user) => {
        return ProductControlRepository.executeTransaction(async () => {
            const allocation = await ProductControlRepository.getExpenseAllocationById(allocationId);
            if (!allocation || allocation.product_id !== parseInt(productId, 10) || allocation.is_deleted === 1) {
                const err = new Error('توزيع المصروف غير موجود أو محذوف.');
                err.status = 404;
                throw err;
            }

            await ProductControlRepository.softDeleteExpenseAllocation(allocationId);

            const username = user ? (user.username || user.name || 'System') : 'System';
            await ProductControlRepository.logAudit(
                'EXPENSE_ALLOCATION',
                allocationId,
                'DELETE',
                allocation,
                { is_deleted: 1 },
                user ? user.id : null,
                username
            );

            return { success: true };
        });
    },

    /**
     * Run Pre-Purchase Decision Engine
     */
    evaluatePrePurchase: async (productId) => {
        const product = await ProductControlRepository.getProductById(productId);
        if (!product) {
            const err = new Error('المنتج غير موجود.');
            err.status = 404;
            throw err;
        }

        const lastInventory = await ProductControlRepository.getLastInventory(productId);
        const lastPurchase = await ProductControlRepository.getLastPurchaseItem(productId);
        const expectedStock = await ProductControlRepository.getCurrentStockFromMovements(productId);

        const lastInvDate = lastInventory ? lastInventory.inventory_at : null;
        const lastPurDate = lastPurchase ? lastPurchase.purchased_at : null;

        const soldSinceLastPurchase = Math.abs(await ProductControlRepository.getMovementsSumSinceDate(productId, ['SALE', 'RETURN'], lastPurDate));
        const soldSinceLastInventory = Math.abs(await ProductControlRepository.getMovementsSumSinceDate(productId, ['SALE', 'RETURN'], lastInvDate));

        const requireInventoryConfig = await ProductControlRepository.getConfig('require_recent_inventory_before_purchase');
        const maxDaysConfig = await ProductControlRepository.getConfig('max_days_since_inventory');

        const blockingReasons = [];
        const warnings = [];

        // 1. Check if inventory count exists
        if (requireInventoryConfig === '1' && !lastInventory) {
            blockingReasons.push('لا يوجد جرد سابق للمنتج. يجب إجراء جرد افتتاحي أولاً قبل الشراء.');
        }

        // 2. Check days since last inventory
        if (lastInventory && maxDaysConfig) {
            const maxDays = parseInt(maxDaysConfig, 10) || 30;
            const invTime = new Date(lastInventory.inventory_at).getTime();
            const nowTime = Date.now();
            const daysDiff = Math.floor((nowTime - invTime) / (1000 * 60 * 60 * 24));
            if (daysDiff > maxDays) {
                blockingReasons.push(`الجرد أقدم من الحد المسموح به (${daysDiff} يوماً > ${maxDays} يوماً). يرجى تحديث الجرد قبل الشراء.`);
            }
        }

        // 3. Check product control status
        if (product.current_control_status === 'purchase_stopped') {
            blockingReasons.push('المنتج متوقف عن الشراء حالياً بقرار إداري.');
        }

        if (product.current_control_status === 'under_review') {
            blockingReasons.push('يوجد فرق مخزني يتطلب المراجعة والاعتماد قبل الشراء.');
        }

        if (product.current_control_status === 'needs_inventory') {
            warnings.push('المنتج يتطلب جرد افتتاحي لتأكيد الرصيد.');
        }

        return {
            allowed: blockingReasons.length === 0,
            blocking_reasons: blockingReasons,
            warnings: warnings,
            snapshot: {
                last_inventory_at: lastInvDate,
                last_purchase_at: lastPurDate,
                sold_since_last_purchase: soldSinceLastPurchase,
                sold_since_last_inventory: soldSinceLastInventory,
                expected_stock: expectedStock,
                actual_stock: product.quantity,
                control_status: product.current_control_status
            }
        };
    },

    /**
     * Update product control status (active, needs_inventory, under_review, purchase_stopped)
     */
    updateProductStatus: async (productId, newStatus, reason, user) => {
        const allowedStatuses = ['normal', 'needs_inventory', 'under_review', 'purchase_stopped'];
        if (!allowedStatuses.includes(newStatus)) {
            const err = new Error('حالة التحكم المحددة غير صالحة.');
            err.status = 400;
            throw err;
        }

        return ProductControlRepository.executeTransaction(async () => {
            const product = await ProductControlRepository.getProductById(productId);
            if (!product) {
                const err = new Error('المنتج غير موجود.');
                err.status = 404;
                throw err;
            }

            const oldStatus = product.current_control_status;
            const username = user ? (user.username || user.name || 'System') : 'System';

            await ProductControlRepository.updateProductControlStatus(productId, newStatus);
            await ProductControlRepository.insertStatusHistory(productId, oldStatus, newStatus, username, user ? user.id : null, reason);

            await ProductControlRepository.logAudit(
                'PRODUCT_STATUS',
                productId,
                'UPDATE_STATUS',
                { status: oldStatus },
                { status: newStatus, reason },
                user ? user.id : null,
                username
            );

            return {
                product_id: productId,
                old_status: oldStatus,
                new_status: newStatus
            };
        });
    },

    /**
     * Get combined chronological timeline feed for a product
     */
    getProductTimeline: async (productId) => {
        const product = await ProductControlRepository.getProductById(productId);
        if (!product) {
            const err = new Error('المنتج غير موجود.');
            err.status = 404;
            throw err;
        }

        const movements = await ProductControlRepository.getStockMovements(productId);
        const counts = await ProductControlRepository.getInventoryCountsHistory(productId);
        const purchases = await ProductControlRepository.getPurchaseInvoicesHistory(productId);
        const statusHistory = await ProductControlRepository.getStatusHistory(productId);
        const allocations = await ProductControlRepository.getExpenseAllocations(productId);

        const timeline = [];

        for (const m of (movements || [])) {
            timeline.push({
                event_type: 'STOCK_MOVEMENT',
                timestamp: m.movement_at || m.created_at,
                title: `حركة مخزنية: ${m.movement_type}`,
                details: {
                    movement_type: m.movement_type,
                    quantity: m.quantity,
                    unit_cogs_sar: m.unit_cogs_halalas ? CurrencyUtil.halalasToSar(m.unit_cogs_halalas) : null,
                    source_ref: m.source_reference_id
                }
            });
        }

        for (const c of (counts || [])) {
            timeline.push({
                event_type: 'INVENTORY_COUNT',
                timestamp: c.inventory_at || c.created_at,
                title: `جرد مخزني: ${c.actual_qty} قطعة`,
                details: {
                    actual_qty: c.actual_qty,
                    expected_qty: c.expected_qty_at_count,
                    variance: c.variance,
                    created_by: c.created_by
                }
            });
        }

        for (const p of (purchases || [])) {
            timeline.push({
                event_type: 'PURCHASE',
                timestamp: p.purchased_at || p.created_at,
                title: `شراء: ${p.quantity} قطعة من ${p.supplier || 'مورد'}`,
                details: {
                    quantity: p.quantity,
                    unit_cost_sar: CurrencyUtil.halalasToSar(p.unit_cost_halalas),
                    total_sar: CurrencyUtil.halalasToSar(p.total_amount_halalas),
                    supplier: p.supplier,
                    invoice_ref: p.invoice_ref
                }
            });
        }

        for (const s of (statusHistory || [])) {
            timeline.push({
                event_type: 'STATUS_CHANGE',
                timestamp: s.created_at,
                title: `تغيير حالة التحكم: ${s.old_status || 'جديد'} -> ${s.new_status}`,
                details: {
                    old_status: s.old_status,
                    new_status: s.new_status,
                    changed_by: s.changed_by,
                    reason: s.reason
                }
            });
        }

        for (const a of (allocations || [])) {
            timeline.push({
                event_type: 'EXPENSE_ALLOCATION',
                timestamp: a.created_at,
                title: `توزيع مصروف: ${CurrencyUtil.halalasToSar(a.allocated_amount_halalas)} ر.س (${a.allocation_type})`,
                details: {
                    allocation_type: a.allocation_type,
                    amount_sar: CurrencyUtil.halalasToSar(a.allocated_amount_halalas),
                    period: `${a.period_from} إلى ${a.period_to}`
                }
            });
        }

        // Sort descending by timestamp
        timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        return timeline;
    },

    /**
     * Get or set product control configs
     */
    getConfig: async (key) => {
        return ProductControlRepository.getConfig(key);
    },

    getAllConfigs: async () => {
        return ProductControlRepository.getAllConfigs();
    },

    setConfig: async (key, value, description = '', user) => {
        await ProductControlRepository.setConfig(key, value, description);
        const username = user ? (user.username || user.name || 'System') : 'System';
        await ProductControlRepository.logAudit(
            'CONFIG',
            null,
            'UPDATE_CONFIG',
            null,
            { key, value, description },
            user ? user.id : null,
            username
        );
        return { key, value };
    },

    /**
     * Product Mapping Service Methods
     */
    getAllMappings: async () => {
        return ProductControlRepository.getAllMappings();
    },

    getUnmappedOrdersProducts: async () => {
        return ProductControlRepository.getUnmappedOrdersProducts();
    },

    saveMapping: async (productId, sallaProductId, sku, aliasName, mappingStatus = 'ACTIVE', user) => {
        if (!productId || !aliasName || !aliasName.trim()) {
            const err = new Error('بيانات الربط غير صالحة.');
            err.status = 400;
            throw err;
        }

        const product = await ProductControlRepository.getProductById(productId);
        if (!product) {
            const err = new Error('المنتج المستهدف غير موجود.');
            err.status = 404;
            throw err;
        }

        await ProductControlRepository.upsertMapping(productId, sallaProductId, sku, aliasName, mappingStatus);
        const username = user ? (user.username || user.name || 'System') : 'System';

        await ProductControlRepository.logAudit(
            'PRODUCT_MAPPING',
            productId,
            'SAVE_MAPPING',
            null,
            { product_id: productId, salla_product_id: sallaProductId, sku, alias_name: aliasName, mapping_status: mappingStatus },
            user ? user.id : null,
            username
        );

        return { product_id: productId, alias_name: aliasName, mapping_status: mappingStatus };
    },

    /**
     * Create a new product manually in product control center
     */
    createProduct: async (data, username, userId = null) => {
        const { product_name, sku, salla_product_id, opening_quantity = 0, cost = 0, price = 0, status = 'normal' } = data;

        if (!product_name || !String(product_name).trim()) {
            const error = new Error('اسم المنتج مطلوب.');
            error.status = 400;
            throw error;
        }

        const cleanName = String(product_name).trim();
        const cleanSku = sku ? String(sku).trim() : null;
        const cleanSallaId = salla_product_id ? String(salla_product_id).trim() : null;
        const qty = Math.max(parseInt(opening_quantity, 10) || 0, 0);
        const unitCostHalalas = Math.max(Math.round((parseFloat(cost) || 0) * 100), 0);
        const unitPriceHalalas = Math.max(Math.round((parseFloat(price) || 0) * 100), 0);
        const totalValueHalalas = qty * unitCostHalalas;

        return ProductControlRepository.executeTransaction(async () => {
            const existing = await ProductControlRepository.getSql(
                "SELECT id FROM inventory_products WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))",
                [cleanName]
            );
            if (existing) {
                const error = new Error(`المنتج "${cleanName}" موجود بالفعل في قاعدة البيانات.`);
                error.status = 400;
                throw error;
            }

            const now = new Date().toISOString();
            const todayDate = now.split('T')[0];

            const res = await ProductControlRepository.runSql(
                `INSERT INTO inventory_products 
                (product_name, sku, salla_product_id, quantity, salla_quantity, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
                [cleanName, cleanSku, cleanSallaId, qty, unitCostHalalas, unitPriceHalalas, totalValueHalalas, status || 'normal', todayDate]
            );

            const productId = res.lastID;

            await ProductControlRepository.upsertMapping(productId, cleanSallaId, cleanSku, cleanName, 'ACTIVE');

            // Record initial inventory count to establish baseline for quality control purchase gate
            await ProductControlRepository.createInventoryCount({
                product_id: productId,
                inventory_at: now,
                actual_qty: qty,
                expected_qty_at_count: 0,
                variance: qty,
                notes: 'جرد افتتاحي مبدئي عند إضافة المنتج',
                created_by: username || 'System',
                user_id: userId
            });

            if (qty > 0) {
                await ProductControlRepository.insertStockMovement({
                    product_id: productId,
                    movement_type: 'INITIAL_STOCK',
                    quantity: qty,
                    source_reference_id: `INIT-${productId}`,
                    source_item_reference_id: `ITEM-INIT-${productId}`,
                    source_event_reference_id: 'MANUAL_CREATE',
                    movement_at: now,
                    unit_cogs_halalas: unitCostHalalas
                });
            }

            await ProductControlRepository.logAudit('PRODUCT', productId, 'MANUAL_CREATE', null, {
                product_name: cleanName,
                sku: cleanSku,
                salla_product_id: cleanSallaId,
                quantity: qty,
                cost_sar: unitCostHalalas / 100,
                price_sar: unitPriceHalalas / 100
            }, userId, username);

            return ProductControlRepository.getProductById(productId);
        });
    }
};

module.exports = ProductControlService;
