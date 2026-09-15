const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateUser } = require('../middlewares/auth');
const SallaFamilyIntegration = require('../services/salla_family_integration.service');
const PlusAccountService = require('../services/plus_account.service');
const ProductFamilyRepository = require('../repositories/product_family.repository');

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

const requireWritePermission = (req, res, next) => {
    const role = (req.user.role || '').toLowerCase();
    const allowedRoles = ['admin', 'manager', 'product_manager', 'supervisor'];
    if (!allowedRoles.includes(role)) {
        return res.status(403).json({ error: 'غير مصرح لك بإجراء هذه العملية.', code: 'FORBIDDEN' });
    }
    next();
};

router.use(authenticateUser);

// 1. Families overview (reused as-is from the existing, tested Product Family repository)
router.get('/families', async (req, res, next) => {
    try {
        const families = await ProductFamilyRepository.getAllFamilies();
        res.json({ success: true, data: families });
    } catch (e) { next(e); }
});

// 2. Mapping status — exposes exactly which Salla products are/aren't linked to inventory_products
// by a stable ID, so gaps are visible instead of silently assumed resolved (Phase 12, section 2 & 8).
router.get('/mapping-status', async (req, res, next) => {
    try {
        const distinctSallaProducts = await dbAllAsync(`
            SELECT product_id, product_name, COUNT(*) as row_count FROM salla_order_items
            WHERE product_id IS NOT NULL GROUP BY product_id, product_name
        `);
        const mapped = await dbAllAsync(`SELECT salla_product_id FROM inventory_products WHERE salla_product_id IS NOT NULL`);
        const mappedIds = new Set(mapped.map(m => m.salla_product_id));

        const unmapped = distinctSallaProducts.filter(p => !mappedIds.has(p.product_id));
        const missingProductIdItems = await dbAllAsync(`SELECT COUNT(*) as c FROM salla_order_items WHERE product_id IS NULL`);

        res.json({
            success: true,
            total_distinct_salla_products: distinctSallaProducts.length,
            mapped_count: distinctSallaProducts.length - unmapped.length,
            unmapped_count: unmapped.length,
            unmapped_products: unmapped,
            order_items_missing_product_id: missingProductIdItems[0] ? missingProductIdItems[0].c : 0
        });
    } catch (e) { next(e); }
});

// 3. Trigger the safe, non-destructive mapping backfill (Phase 4) — only links when unambiguous.
router.post('/mapping-backfill', requireWritePermission, async (req, res, next) => {
    try {
        const result = await SallaFamilyIntegration.backfillProductMappingByName();
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 4. Trigger the corrected Salla -> stock-movements sync (Phase 5/6) for a date range (or all).
router.post('/sync-stock-movements', requireWritePermission, async (req, res, next) => {
    try {
        const { from, to } = req.body || {};
        const result = await SallaFamilyIntegration.syncSallaOrderItemsToStockMovements({ from, to });
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 5. Family sales report (Phase 9) — server is the sole source of truth for these aggregates.
router.get('/families/:familyId/sales-report', async (req, res, next) => {
    try {
        const familyId = parseInt(req.params.familyId, 10);
        const { duration_code, from, to } = req.query;
        const result = await SallaFamilyIntegration.getFamilySalesReport({ familyId, durationCode: duration_code, from, to });
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 6. Family profitability (Phase 11).
router.get('/families/:familyId/profitability', async (req, res, next) => {
    try {
        const familyId = parseInt(req.params.familyId, 10);
        const { duration_code, from, to } = req.query;
        const result = await SallaFamilyIntegration.getFamilyProfitability({ familyId, durationCode: duration_code, from, to });
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 7. Reconciliation (Phase 13) — optionally scoped to one family/duration, or store-wide.
router.get('/reconciliation', async (req, res, next) => {
    try {
        const { family_id, duration_code, from, to } = req.query;
        const result = await SallaFamilyIntegration.getReconciliationReport({
            familyId: family_id ? parseInt(family_id, 10) : null, durationCode: duration_code, from, to
        });
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 8. Account composition status (Phase 3) — configured intent vs proven delivery-schema capacity.
router.get('/account-composition', async (req, res, next) => {
    try {
        const result = await SallaFamilyIntegration.getAccountCompositionStatus();
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 9. Create a new Plus account (Gap 1/2) — family_id + duration_code required; slot composition is
// read from account_composition_config (data-driven), creating a 2 PS5 + 2 PS4 account when configured.
router.post('/plus-accounts', requireWritePermission, async (req, res, next) => {
    try {
        const { email, password, family_id, duration_code } = req.body || {};
        const result = await PlusAccountService.createAccount({
            email, password, familyId: family_id, durationCode: duration_code, createdBy: req.user.username
        });
        res.status(201).json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 10. Deliver a compatible slot for a sold order (Gap 4/5) — never crosses family/duration/platform.
router.post('/plus-accounts/deliver', requireWritePermission, async (req, res, next) => {
    try {
        const { family_id, duration_code, slot_type, order_reference_id, customer_phone } = req.body || {};
        const result = await PlusAccountService.deliverSlot({
            familyId: family_id, durationCode: duration_code, slotType: slot_type,
            orderReferenceId: order_reference_id, customerPhone: customer_phone, deliveredBy: req.user.username
        });
        res.json({ success: result.success, ...result });
    } catch (e) { next(e); }
});

// 11. Account/slot inventory dashboard (Gap 13) — real counts only.
router.get('/families/:familyId/inventory', async (req, res, next) => {
    try {
        const familyId = parseInt(req.params.familyId, 10);
        const durationCode = req.query.duration_code || 'MONTHLY';
        const result = await PlusAccountService.getInventoryDashboard(familyId, durationCode);
        res.json({ success: true, family_id: familyId, duration_code: durationCode, ...result });
    } catch (e) { next(e); }
});

// 12. Delivery-level reconciliation (Gap 9) — deliberately separate from sale-level mismatch.
router.get('/delivery-reconciliation', async (req, res, next) => {
    try {
        const { family_id, duration_code, from, to } = req.query;
        const result = await SallaFamilyIntegration.getDeliveryReconciliation({
            familyId: family_id ? parseInt(family_id, 10) : null, durationCode: duration_code, from, to
        });
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// 13. Legacy account backfill classification (Gap 11) — read-only, never writes.
router.get('/legacy-account-backfill-candidates', async (req, res, next) => {
    try {
        const result = await PlusAccountService.classifyLegacyAccountBackfillCandidates();
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

module.exports = router;
