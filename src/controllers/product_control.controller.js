const ProductControlService = require('../services/product_control.service');

const ProductControlController = {
    getProductsOverview: async (req, res, next) => {
        try {
            const { search = '', q = '', status = '', category = '', from = null, to = null, limit = 50, page = 1 } = req.query;

            if (from && to && new Date(from) > new Date(to)) {
                return res.status(400).json({
                    error: 'تاريخ البداية (from) لا يمكن أن يكون بعد تاريخ النهاية (to).',
                    code: 'INVALID_DATE_RANGE'
                });
            }

            const searchQuery = q || search;
            const overview = await ProductControlService.getProductsOverview(searchQuery, status, category, limit, page);
            res.json({
                success: true,
                count: overview.products.length,
                total: overview.total,
                page: overview.page,
                limit: overview.limit,
                pagination: {
                    total: overview.total,
                    count: overview.products.length,
                    per_page: overview.limit,
                    current_page: overview.page,
                    total_pages: Math.ceil(overview.total / overview.limit) || 1
                },
                data: overview.products
            });
        } catch (err) {
            next(err);
        }
    },

    getProductDetails: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { from = null, to = null } = req.query;
            const details = await ProductControlService.getProductDetails(id, from, to);
            res.json({
                success: true,
                ...details,
                data: details
            });
        } catch (err) {
            next(err);
        }
    },

    getInventoryHistory: async (req, res, next) => {
        try {
            const { id } = req.params;
            const details = await ProductControlService.getProductDetails(id);
            const counts = details.history.inventory_counts || [];
            res.json({
                success: true,
                count: counts.length,
                pagination: { total: counts.length, count: counts.length, per_page: 50, current_page: 1, total_pages: 1 },
                data: counts
            });
        } catch (err) {
            next(err);
        }
    },

    recordInventoryCount: async (req, res, next) => {
        try {
            const { id } = req.params;
            const countData = req.body;
            const result = await ProductControlService.recordInventoryCount(id, countData, req.user);
            res.status(200).json({
                success: true,
                message: 'تم تسجيل الجرد المخزني بنجاح.',
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    cancelInventoryCount: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { count_id, reason } = req.body;
            const countId = count_id || req.query.count_id;
            const result = await ProductControlService.cancelInventoryCount(id, countId, reason, req.user);
            res.json({
                success: true,
                message: 'تم إلغاء الجرد المخزني وإعادة الرصيد بنجاح.',
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    getPurchasesHistory: async (req, res, next) => {
        try {
            const { id } = req.params;
            const details = await ProductControlService.getProductDetails(id);
            const purchases = details.history.purchases || [];
            res.json({
                success: true,
                count: purchases.length,
                pagination: { total: purchases.length, count: purchases.length, per_page: 50, current_page: 1, total_pages: 1 },
                data: purchases
            });
        } catch (err) {
            next(err);
        }
    },

    recordPurchaseInvoice: async (req, res, next) => {
        try {
            const invoiceData = req.body;
            const result = await ProductControlService.recordPurchaseInvoice(invoiceData, req.user);
            res.status(200).json({
                success: true,
                message: 'تم تسجيل فاتورة الشراء وتحديث متوسط التكلفة WAC بنجاح.',
                purchase_id: result.header_id,
                header_id: result.header_id,
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    cancelPurchaseInvoice: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { header_id, reason } = req.body;
            const headerId = header_id || req.query.header_id;
            const result = await ProductControlService.cancelPurchaseInvoice(id, headerId, reason, req.user);
            res.json({
                success: true,
                message: 'تم إلغاء فاتورة الشراء وعكس حركات المخزون بنجاح.',
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    evaluatePrePurchase: async (req, res, next) => {
        try {
            const id = req.params.id || req.query.product_id;
            const decision = await ProductControlService.evaluatePrePurchase(id);
            res.json({
                success: true,
                allowed: decision.allowed,
                blocking_reasons: decision.blocking_reasons,
                warnings: decision.warnings,
                data: decision
            });
        } catch (err) {
            next(err);
        }
    },

    getExpenseAllocations: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { type = null } = req.query;
            const details = await ProductControlService.getProductDetails(id);
            let allocations = details.history.expense_allocations || [];
            if (type) {
                allocations = allocations.filter(a => a.allocation_type === type);
            }
            res.json({
                success: true,
                count: allocations.length,
                pagination: { total: allocations.length, count: allocations.length, per_page: 50, current_page: 1, total_pages: 1 },
                data: allocations
            });
        } catch (err) {
            next(err);
        }
    },

    recordExpenseAllocation: async (req, res, next) => {
        try {
            const id = req.params.id || req.body.product_id;
            const allocationData = {
                ...req.body,
                product_id: parseInt(id, 10)
            };
            const result = await ProductControlService.recordExpenseAllocation(allocationData, req.user);
            res.status(200).json({
                success: true,
                value: true,
                message: 'تم تسجيل توزيع المصروف بنجاح.',
                data: result
            });
        } catch (err) {
            if (err.details) {
                return res.status(400).json({
                    error: err.message,
                    details: err.details
                });
            }
            next(err);
        }
    },

    deleteExpenseAllocation: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { allocation_id } = req.body;
            const allocationId = allocation_id || req.query.allocation_id;
            const result = await ProductControlService.deleteExpenseAllocation(id, allocationId, req.user);
            res.json({
                success: true,
                message: 'تم حذف توزيع المصروف بنجاح.',
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    getProductTimeline: async (req, res, next) => {
        try {
            const { id } = req.params;
            const timeline = await ProductControlService.getProductTimeline(id);
            res.json({
                success: true,
                count: timeline.length,
                data: timeline
            });
        } catch (err) {
            next(err);
        }
    },

    getSalesHistory: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { from = null, to = null } = req.query;
            const details = await ProductControlService.getProductDetails(id, from, to);
            const movements = details.history.stock_movements || [];
            const CurrencyUtil = require('../utils/currency');
            const sales = movements.filter(m => m.movement_type === 'SALE' || m.movement_type === 'RETURN').map(s => ({
                salla_order_reference_id: s.source_reference_id || 'N/A',
                sale_at: s.movement_at,
                quantity: Math.abs(s.quantity),
                total_sar: s.unit_cogs_halalas ? CurrencyUtil.halalasToSar(Math.abs(s.quantity) * s.unit_cogs_halalas) : 0,
                order_status: s.movement_type === 'SALE' ? 'مكتمل' : 'مرتجع'
            }));
            res.json({
                success: true,
                count: sales.length,
                pagination: { total: sales.length, count: sales.length, per_page: 50, current_page: 1, total_pages: 1 },
                data: sales
            });
        } catch (err) {
            next(err);
        }
    },

    updateProductStatus: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { status, reason = '' } = req.body;
            const result = await ProductControlService.updateProductStatus(id, status, reason, req.user);
            res.json({
                success: true,
                message: 'تم تحديث حالة التحكم للمنتج بنجاح.',
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    getConfigs: async (req, res, next) => {
        try {
            const configs = await ProductControlService.getAllConfigs();
            res.json({
                success: true,
                data: configs
            });
        } catch (err) {
            next(err);
        }
    },

    updateConfig: async (req, res, next) => {
        try {
            const { key, value, description = '' } = req.body;
            if (!key || value === undefined || value === null) {
                return res.status(400).json({ error: 'يرجى تقديم مفتاح وقيمة الإعداد بشكل صحيح.' });
            }
            const result = await ProductControlService.setConfig(key, value, description, req.user);
            res.json({
                success: true,
                message: 'تم تحديث إعدادات مركز التحكم بنجاح.',
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    getMappings: async (req, res, next) => {
        try {
            const mappings = await ProductControlService.getAllMappings();
            const unmapped = await ProductControlService.getUnmappedOrdersProducts();
            res.json({
                success: true,
                data: {
                    mappings,
                    unmapped
                }
            });
        } catch (err) {
            next(err);
        }
    },

    saveMapping: async (req, res, next) => {
        try {
            const { product_id, salla_product_id, sku, alias_name, mapping_status = 'ACTIVE' } = req.body;
            const result = await ProductControlService.saveMapping(product_id, salla_product_id, sku, alias_name, mapping_status, req.user);
            res.json({
                success: true,
                message: 'تم تسجيل ربط المنتج بنجاح.',
                data: result
            });
        } catch (err) {
            next(err);
        }
    },

    syncSales: async (req, res, next) => {
        try {
            const syncedCount = await ProductControlService.syncSalesToStockMovements();
            res.json({
                success: true,
                message: `تمت مزامنة ${syncedCount} حركة بيع/مرتجع إلى سجل حركات المخزون بنجاح.`,
                synced_movements: syncedCount
            });
        } catch (err) {
            next(err);
        }
    },

    createProduct: async (req, res, next) => {
        try {
            const { product_name, sku, salla_product_id, quantity, opening_quantity, cost, price, status } = req.body;
            const username = req.user ? req.user.username : 'Admin';
            const userId = req.user ? req.user.id : null;

            const product = await ProductControlService.createProduct({
                product_name,
                sku,
                salla_product_id,
                opening_quantity: opening_quantity !== undefined ? opening_quantity : quantity,
                cost,
                price,
                status
            }, username, userId);

            res.json({
                success: true,
                message: `تم إضافة المنتج "${product.product_name}" بنجاح.`,
                data: product
            });
        } catch (err) {
            next(err);
        }
    }
};

module.exports = ProductControlController;
