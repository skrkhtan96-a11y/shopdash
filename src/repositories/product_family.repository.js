const ProductControlRepository = require('./product_control.repository');

const getSql = ProductControlRepository.getSql;
const allSql = ProductControlRepository.allSql;
const runSql = ProductControlRepository.runSql;

const ProductFamilyRepository = {
    getSql,
    allSql,
    runSql,

    getAllFamilies: async () => {
        return allSql(`
            SELECT f.*, 
                   COUNT(p.id) as variants_count,
                   COALESCE(SUM(p.quantity), 0) as total_stock
            FROM product_families f
            LEFT JOIN inventory_products p ON f.id = p.family_id
            GROUP BY f.id
            ORDER BY f.id ASC
        `);
    },

    getFamilyById: async (familyId) => {
        return getSql(`SELECT * FROM product_families WHERE id = ?`, [familyId]);
    },

    getFamilyByCode: async (familyCode) => {
        return getSql(`SELECT * FROM product_families WHERE family_code = ?`, [familyCode]);
    },

    getFamilyVariants: async (familyId) => {
        return allSql(`
            SELECT p.*,
                   COUNT(ic.id) as inventory_counts_count,
                   MAX(ic.inventory_at) as last_inventory_count_at
            FROM inventory_products p
            LEFT JOIN product_inventory_counts ic ON p.id = ic.product_id AND ic.is_deleted = 0
            WHERE p.family_id = ?
            GROUP BY p.id
            ORDER BY 
                CASE p.duration_code
                    WHEN 'MONTHLY' THEN 1
                    WHEN 'THREE_MONTHS' THEN 2
                    WHEN 'YEARLY' THEN 3
                    ELSE 4
                END ASC
        `, [familyId]);
    },

    getStandaloneProducts: async () => {
        return allSql(`
            SELECT p.*,
                   COUNT(ic.id) as inventory_counts_count,
                   MAX(ic.inventory_at) as last_inventory_count_at
            FROM inventory_products p
            LEFT JOIN product_inventory_counts ic ON p.id = ic.product_id AND ic.is_deleted = 0
            WHERE p.family_id IS NULL
            GROUP BY p.id
            ORDER BY p.id ASC
        `);
    },

    getCatalogItems: async () => {
        const families = await ProductFamilyRepository.getAllFamilies();
        const standalones = await ProductFamilyRepository.getStandaloneProducts();

        const catalog = [];

        for (const fam of families) {
            const variants = await ProductFamilyRepository.getFamilyVariants(fam.id);
            const totalValueHalalas = variants.reduce((acc, v) => acc + (v.inventory_value_halalas || 0), 0);
            
            catalog.push({
                type: 'FAMILY',
                id: fam.id,
                family_code: fam.family_code,
                product_name: fam.family_name,
                platform: fam.platform,
                tier: fam.tier,
                status: fam.status,
                variants_count: variants.length,
                total_stock: variants.reduce((acc, v) => acc + (v.quantity || 0), 0),
                total_value_sar: totalValueHalalas / 100,
                duration_badges: variants.map(v => v.duration_code),
                variants: variants.map(v => ({
                    id: v.id,
                    product_name: v.product_name,
                    duration_code: v.duration_code,
                    quantity: v.quantity,
                    cost_sar: (v.cost_halalas || 0) / 100,
                    price_sar: (v.price_halalas || 0) / 100,
                    current_control_status: v.current_control_status
                }))
            });
        }

        for (const st of standalones) {
            catalog.push({
                type: 'STANDALONE',
                id: st.id,
                product_name: st.product_name,
                sku: st.sku,
                salla_product_id: st.salla_product_id,
                duration_code: 'STANDALONE',
                quantity: st.quantity,
                cost_sar: (st.cost_halalas || 0) / 100,
                price_sar: (st.price_halalas || 0) / 100,
                inventory_value_sar: (st.inventory_value_halalas || 0) / 100,
                current_control_status: st.current_control_status,
                last_inventory_count_at: st.last_inventory_count_at
            });
        }

        return catalog;
    }
};

module.exports = ProductFamilyRepository;
