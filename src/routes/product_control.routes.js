const express = require('express');
const router = express.Router();
const ProductControlController = require('../controllers/product_control.controller');
const { authenticateUser } = require('../middlewares/auth');

// Default-Deny Authorization Middleware for Write operations
const requireWritePermission = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً للمتابعة.', code: 'UNAUTHORIZED' });
    }
    const role = (req.user.role || '').toLowerCase();
    const allowedRoles = ['admin', 'manager', 'product_manager', 'supervisor'];
    if (!allowedRoles.includes(role)) {
        return res.status(403).json({ error: 'غير مصرح لك بإجراء عملية التعديل أو الإضافة على مركز التحكم بالمنتج.', code: 'FORBIDDEN' });
    }
    next();
};

// All Product Control routes require authenticated user
router.use(authenticateUser);

// 1. Overview & Details
router.get('/products', ProductControlController.getProductsOverview);
router.get('/products/:id', ProductControlController.getProductDetails);
router.get('/products/:id/details', ProductControlController.getProductDetails);

// 2. Inventory Count APIs
router.get('/products/:id/inventory', ProductControlController.getInventoryHistory);
router.get('/products/:id/inventory-counts', ProductControlController.getInventoryHistory);
router.post('/products/:id/inventory', requireWritePermission, ProductControlController.recordInventoryCount);
router.post('/products/:id/inventory-counts', requireWritePermission, ProductControlController.recordInventoryCount);
router.post('/inventory-counts', requireWritePermission, ProductControlController.recordInventoryCount);
router.delete('/products/:id/inventory', requireWritePermission, ProductControlController.cancelInventoryCount);

// 3. Purchase Invoice APIs
router.get('/products/:id/purchases', ProductControlController.getPurchasesHistory);
router.post('/purchases', requireWritePermission, ProductControlController.recordPurchaseInvoice);
router.post('/products/:id/purchases', requireWritePermission, ProductControlController.recordPurchaseInvoice);
router.delete('/products/:id/purchases', requireWritePermission, ProductControlController.cancelPurchaseInvoice);

// 4. Decision Engine
router.get('/products/:id/pre-purchase-check', ProductControlController.evaluatePrePurchase);
router.get('/pre-purchase-check', ProductControlController.evaluatePrePurchase);

// 5. Expense Allocations (Supports ADVERTISING and OTHER)
router.get('/products/:id/expense-allocations', ProductControlController.getExpenseAllocations);
router.get('/products/:id/expenses', ProductControlController.getExpenseAllocations);
router.post('/products/:id/expense-allocations', requireWritePermission, ProductControlController.recordExpenseAllocation);
router.post('/products/:id/expenses', requireWritePermission, ProductControlController.recordExpenseAllocation);
router.post('/expenses/allocate', requireWritePermission, ProductControlController.recordExpenseAllocation);
router.delete('/products/:id/expense-allocations', requireWritePermission, ProductControlController.deleteExpenseAllocation);

// 6. Sales History & Timeline & Status
router.get('/products/:id/sales', ProductControlController.getSalesHistory);
router.get('/products/:id/timeline', ProductControlController.getProductTimeline);
router.put('/products/:id/status', requireWritePermission, ProductControlController.updateProductStatus);

// 7. System Config
router.get('/config', ProductControlController.getConfigs);
router.put('/config', requireWritePermission, ProductControlController.updateConfig);

// 8. Mapping & Sales Sync
router.get('/mappings', ProductControlController.getMappings);
router.post('/mappings', requireWritePermission, ProductControlController.saveMapping);
router.post('/sync-sales', requireWritePermission, ProductControlController.syncSales);

module.exports = router;
