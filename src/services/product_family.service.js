const ProductFamilyRepository = require('../repositories/product_family.repository');
const ProductControlService = require('./product_control.service');

const ProductFamilyService = {
    getCatalog: async (filters = {}) => {
        const { search, status } = filters;
        const catalog = await ProductFamilyRepository.getCatalogItems();

        return catalog.filter(item => {
            if (search && String(search).trim()) {
                const s = String(search).trim().toLowerCase();
                const matchName = item.product_name && item.product_name.toLowerCase().includes(s);
                const matchSku = item.sku && item.sku.toLowerCase().includes(s);
                const matchSallaId = item.salla_product_id && String(item.salla_product_id).includes(s);
                const matchVariant = item.variants && item.variants.some(v => 
                    (v.product_name && v.product_name.toLowerCase().includes(s))
                );
                if (!matchName && !matchSku && !matchSallaId && !matchVariant) return false;
            }

            if (status && status !== 'all') {
                if (item.type === 'STANDALONE') {
                    if (item.current_control_status !== status) return false;
                } else if (item.type === 'FAMILY') {
                    const hasStatus = item.variants && item.variants.some(v => v.current_control_status === status);
                    if (!hasStatus && item.status !== status) return false;
                }
            }

            return true;
        });
    },

    getFamilyDetails: async (familyId, queryParams = {}) => {
        const family = await ProductFamilyRepository.getFamilyById(familyId);
        if (!family) {
            const err = new Error('عائلة المنتج غير موجودة.');
            err.status = 404;
            throw err;
        }

        const variants = await ProductFamilyRepository.getFamilyVariants(familyId);
        const { duration = 'all', from, to, date_preset } = queryParams;
        const targetDuration = String(duration).trim().toUpperCase();

        // Fetch details for each variant using ProductControlService
        const variantDetails = [];
        for (const v of variants) {
            try {
                const detail = await ProductControlService.getProductDetails(v.id, from, to);
                variantDetails.push({
                    variant_id: v.id,
                    duration_code: v.duration_code,
                    product_name: v.product_name,
                    sku: v.sku,
                    quantity: v.quantity,
                    cost_sar: (v.cost_halalas || 0) / 100,
                    price_sar: (v.price_halalas || 0) / 100,
                    current_control_status: v.current_control_status,
                    detail: detail
                });
            } catch (e) {
                console.error(`Error fetching detail for variant ${v.id}:`, e.message);
            }
        }

        // If a specific duration is requested (e.g. MONTHLY)
        if (targetDuration !== 'ALL' && ['MONTHLY', 'THREE_MONTHS', 'YEARLY'].includes(targetDuration)) {
            const selected = variantDetails.find(vd => vd.duration_code === targetDuration);
            if (!selected) {
                const err = new Error(`المدة الفرعية (${targetDuration}) غير متوفرة لهذه العائلة.`);
                err.status = 404;
                throw err;
            }

            return {
                family: {
                    id: family.id,
                    family_code: family.family_code,
                    family_name: family.family_name,
                    platform: family.platform,
                    tier: family.tier,
                    status: family.status
                },
                selected_duration: targetDuration,
                variants_list: variants.map(v => ({ id: v.id, duration_code: v.duration_code, name: v.product_name })),
                selected_variant: selected
            };
        }

        // Aggregated view across ALL durations
        let totalStock = 0;
        let totalRevenueHalalas = 0;
        let totalPurchasesHalalas = 0;
        let totalCogsHalalas = 0;
        let totalAdvHalalas = 0;
        let totalOtherExpHalalas = 0;
        let totalGrossProfitHalalas = 0;
        let totalNetProfitHalalas = 0;
        let totalUnitsSold = 0;
        let hasUnavailableCogs = false;

        const breakdown = [];
        const variantStatuses = [];
        let criticalVariantCount = 0;

        for (const vd of variantDetails) {
            const m = vd.detail.metrics || {};
            const rev = m.total_revenue_halalas || 0;
            const pur = m.total_purchases_halalas || 0;
            const cogs = m.total_cogs_halalas || 0;
            const adv = m.advertising_expenses_halalas || 0;
            const oth = m.other_expenses_halalas || 0;
            const gp = m.gross_profit_halalas || 0;
            const np = m.net_profit_halalas || 0;
            const sold = m.units_sold || 0;

            totalStock += vd.quantity;
            totalRevenueHalalas += rev;
            totalPurchasesHalalas += pur;
            totalCogsHalalas += cogs;
            totalAdvHalalas += adv;
            totalOtherExpHalalas += oth;
            totalGrossProfitHalalas += gp;
            totalNetProfitHalalas += np;
            totalUnitsSold += sold;

            if (m.cogs_status === 'UNAVAILABLE') {
                hasUnavailableCogs = true;
            }

            if (['needs_inventory', 'under_review', 'purchase_stopped'].includes(vd.current_control_status)) {
                criticalVariantCount++;
            }

            variantStatuses.push({
                variant_id: vd.variant_id,
                duration_code: vd.duration_code,
                status: vd.current_control_status
            });

            breakdown.push({
                variant_id: vd.variant_id,
                duration_code: vd.duration_code,
                duration_label: vd.duration_code === 'MONTHLY' ? 'شهري' : (vd.duration_code === 'THREE_MONTHS' ? '3 أشهر' : 'سنوي'),
                product_name: vd.product_name,
                stock: vd.quantity,
                unit_cost_sar: vd.cost_sar,
                unit_price_sar: vd.price_sar,
                last_inventory_at: m.last_inventory ? m.last_inventory.inventory_at : null,
                last_purchase_at: m.last_purchase ? m.last_purchase.purchased_at : null,
                sold_count: sold,
                revenue_sar: rev / 100,
                cogs_sar: cogs / 100,
                cogs_status: m.cogs_status || 'AVAILABLE',
                net_profit_sar: np / 100,
                control_status: vd.current_control_status
            });
        }

        const familyCogsStatus = hasUnavailableCogs ? 'INCOMPLETE' : 'AVAILABLE';

        return {
            family: {
                id: family.id,
                family_code: family.family_code,
                family_name: family.family_name,
                platform: family.platform,
                tier: family.tier,
                status: family.status,
                has_attention_required: criticalVariantCount > 0,
                critical_variant_count: criticalVariantCount,
                variant_statuses: variantStatuses
            },
            selected_duration: 'ALL',
            variants_list: variants.map(v => ({ id: v.id, duration_code: v.duration_code, name: v.product_name })),
            summary_metrics: {
                total_stock: totalStock,
                total_units_sold: totalUnitsSold,
                total_revenue_sar: totalRevenueHalalas / 100,
                total_purchases_sar: totalPurchasesHalalas / 100,
                total_cogs_sar: totalCogsHalalas / 100,
                advertising_expenses_sar: totalAdvHalalas / 100,
                other_expenses_sar: totalOtherExpHalalas / 100,
                gross_profit_sar: totalGrossProfitHalalas / 100,
                net_profit_sar: totalNetProfitHalalas / 100,
                family_cogs_status: familyCogsStatus,
                is_incomplete_cogs: hasUnavailableCogs
            },
            breakdown: breakdown,
            variant_details: variantDetails
        };
    }
};

module.exports = ProductFamilyService;
