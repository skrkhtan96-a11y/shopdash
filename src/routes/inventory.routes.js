const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/db');
const ConfigRepository = require('../repositories/config.repository');
const SallaService = require('../services/salla.service');
const { authenticateUser } = require('../middlewares/auth');

// --- CERTIFICATES ---

// Get all certificates
router.get('/certificates', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_certificates) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض الشهادات.' });
    }
    db.all("SELECT * FROM certificates ORDER BY name ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a new certificate
router.post('/certificates', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_add_certificates) {
        return res.status(403).json({ error: 'ليس لديك صلاحية إضافة شهادات.' });
    }
    const { name, total_subs, comp_subs, ads_spend, note } = req.body;
    if (!name) return res.status(400).json({ error: 'اسم الشهادة مطلوب.' });

    const total = parseInt(total_subs) || 0;
    const comp = parseInt(comp_subs) || 0;
    const spend = parseFloat(ads_spend) || 0;
    const updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.run(
        "INSERT INTO certificates (name, total_subs, comp_subs, ads_spend, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [name.trim(), total, comp, spend, note, updatedAt],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'اسم هذه الشهادة مسجل بالفعل.' });
                }
                return res.status(500).json({ error: err.message });
            }
            ConfigRepository.logActivity(req.user.username, 'ADD', 'certificates', `تم إضافة شهادة جديدة: ${name} (إجمالي ${total})`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Update a certificate
router.put('/certificates/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_certificates) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل الشهادات.' });
    }
    const { id } = req.params;
    const { name, total_subs, sold_subs, comp_subs, ads_spend, note, status } = req.body;
    if (!name) return res.status(400).json({ error: 'اسم الشهادة مطلوب.' });

    const total = parseInt(total_subs) || 0;
    const sold = parseInt(sold_subs) || 0;
    const comp = parseInt(comp_subs) || 0;
    const spend = parseFloat(ads_spend) || 0;
    const stat = status || 'active';
    const updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.run(
        "UPDATE certificates SET name = ?, total_subs = ?, sold_subs = ?, comp_subs = ?, ads_spend = ?, note = ?, status = ?, updated_at = ? WHERE id = ?",
        [name.trim(), total, sold, comp, spend, note, stat, updatedAt, id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            ConfigRepository.logActivity(req.user.username, 'UPDATE', 'certificates', `تم تعديل بيانات الشهادة: ${name} (إجمالي ${total}, تعويضات ${comp})`).catch(console.error);
            res.json({ success: true });
        }
    );
});

// Delete a certificate
router.delete('/certificates/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_delete_certificates) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف الشهادات.' });
    }
    const { id } = req.params;
    db.get("SELECT name FROM certificates WHERE id = ?", [id], (errFetch, row) => {
        const name = row ? row.name : 'غير معروف';
        db.run("DELETE FROM certificates WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            ConfigRepository.logActivity(req.user.username, 'DELETE', 'certificates', `تم حذف الشهادة: ${name}`).catch(console.error);
            res.json({ success: true });
        });
    });
});

// Get detailed certificate report with salla orders matching
router.get('/certificates/report', authenticateUser, async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_certificates) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض تقارير الشهادات.' });
    }
    db.all("SELECT * FROM certificates ORDER BY name ASC", [], (err, certs) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all("SELECT product_name, quantity FROM salla_imported_orders", [], (errOrders, orders) => {
            if (errOrders) return res.status(500).json({ error: errOrders.message });

            const report = certs.map(cert => {
                let sallaSales = 0;
                const searchName = cert.name.toLowerCase().trim();

                orders.forEach(o => {
                    const prodName = (o.product_name || '').toLowerCase().trim();
                    if (prodName.includes(searchName) || searchName.includes(prodName)) {
                        sallaSales += o.quantity || 1;
                    }
                });

                const total = cert.total_subs || 0;
                const comp = cert.comp_subs || 0;
                const remaining = total - sallaSales - comp;

                return {
                    id: cert.id,
                    name: cert.name,
                    total_subs: total,
                    sold_subs: sallaSales,
                    comp_subs: comp,
                    remaining: remaining,
                    ads_spend: cert.ads_spend || 0,
                    status: cert.status,
                    note: cert.note,
                    updated_at: cert.updated_at
                };
            });

            res.json(report);
        });
    });
});

// --- PRODUCTS ADJUSTMENTS (Manual stock audit & cost/price override) ---

router.get('/products/adjustments', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض تسويات المنتجات.' });
    }
    db.all("SELECT * FROM product_adjustments", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

router.post('/products/adjustments', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية جرد وتعديل مخزون المنتجات.' });
    }
    const { product_name, stock_offset, cost, price } = req.body;
    if (!product_name) {
        return res.status(400).json({ error: 'يرجى تقديم اسم المنتج لإجراء الجرد.' });
    }

    db.run(
        "INSERT INTO product_adjustments (product_name, stock_offset, cost, price) VALUES (?, ?, ?, ?) ON CONFLICT(product_name) DO UPDATE SET stock_offset = ?, cost = ?, price = ?",
        [
            product_name,
            parseInt(stock_offset) || 0,
            parseFloat(cost) || 0,
            parseFloat(price) || 0,
            parseInt(stock_offset) || 0,
            parseFloat(cost) || 0,
            parseFloat(price) || 0
        ],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true });
        }
    );
});

router.post('/products/adjustments/bulk', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية جرد وتعديل مخزون المنتجات.' });
    }
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ error: 'يرجى تقديم مصفوفة منتجات صالحة.' });
    }
    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO product_adjustments (product_name, stock_offset, cost, price) 
            VALUES (?, ?, ?, ?)
        `);
        products.forEach(p => {
            stmt.run([
                String(p.product_name).trim(),
                parseInt(p.stock_offset) || 0,
                parseFloat(p.cost) || 0,
                parseFloat(p.price) || 0
            ]);
        });
        stmt.finalize((err) => {
            if (err) {
                console.error('خطأ أثناء استيراد المنتجات:', err.message);
                return res.status(500).json({ error: 'فشل حفظ المنتجات في قاعدة البيانات.' });
            }
            res.json({ success: true, count: products.length });
        });
    });
});

router.delete('/products/adjustments', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية جرد وتعديل مخزون المنتجات.' });
    }
    const { product_name } = req.body;
    if (!product_name) {
        return res.status(400).json({ error: 'اسم المنتج مطلوب لحذف تسويته.' });
    }
    db.run("DELETE FROM product_adjustments WHERE product_name = ?", [product_name], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        ConfigRepository.logActivity(req.user.username, 'DELETE', 'product_adjustments', `تم حذف تسوية المنتج: ${product_name}`).catch(console.error);
        res.json({ success: true, changes: this.changes });
    });
});

router.delete('/products/adjustments/clear', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية جرد وتعديل مخزون المنتجات.' });
    }
    db.run("DELETE FROM product_adjustments", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        ConfigRepository.logActivity(req.user.username, 'CLEAR', 'product_adjustments', `تم حذف وتصفير جميع تسويات المخزون`).catch(console.error);
        res.json({ success: true, changes: this.changes });
    });
});

// --- INDEPENDENT INVENTORY PRODUCTS ---

router.get('/inventory/products', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض منتجات المخزون.' });
    }
    db.all("SELECT * FROM inventory_products ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

router.post('/inventory/products', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية إضافة منتجات للمخزون.' });
    }
    const { product_name, sku, quantity, cost, price, category, notes } = req.body;
    if (!product_name) {
        return res.status(400).json({ error: 'اسم المنتج مطلوب.' });
    }
    const dateStr = new Date().toISOString().split('T')[0];
    db.run(
        "INSERT INTO inventory_products (product_name, sku, quantity, cost, price, category, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            product_name.trim(),
            sku ? sku.trim() : null,
            parseInt(quantity) || 0,
            parseFloat(cost) || 0,
            parseFloat(price) || 0,
            category ? category.trim() : 'عام',
            notes ? notes.trim() : null,
            dateStr
        ],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'المنتج مسجل بالفعل في المخزون.' });
                }
                return res.status(500).json({ error: err.message });
            }
            ConfigRepository.logActivity(req.user.username, 'ADD', 'inventory_products', `تم إضافة منتج جديد: ${product_name} للمخزون`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

router.put('/inventory/products/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل منتجات المخزون.' });
    }
    const { id } = req.params;
    const { product_name, sku, quantity, cost, price, category, notes } = req.body;
    if (!product_name) {
        return res.status(400).json({ error: 'اسم المنتج مطلوب.' });
    }
    db.run(
        "UPDATE inventory_products SET product_name = ?, sku = ?, quantity = ?, cost = ?, price = ?, category = ?, notes = ? WHERE id = ?",
        [
            product_name.trim(),
            sku ? sku.trim() : null,
            parseInt(quantity) || 0,
            parseFloat(cost) || 0,
            parseFloat(price) || 0,
            category ? category.trim() : 'عام',
            notes ? notes.trim() : null,
            id
        ],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'الاسم الجديد للمنتج مستخدم بالفعل.' });
                }
                return res.status(500).json({ error: err.message });
            }
            ConfigRepository.logActivity(req.user.username, 'UPDATE', 'inventory_products', `تم تعديل بيانات منتج المخزون: ${product_name}`).catch(console.error);
            res.json({ success: true });
        }
    );
});

router.delete('/inventory/products/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف منتجات المخزون.' });
    }
    const { id } = req.params;
    
    db.get("SELECT product_name FROM inventory_products WHERE id = ?", [id], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'المنتج غير موجود.' });
        }
        const name = row.product_name;
        db.run("DELETE FROM inventory_products WHERE id = ?", [id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            ConfigRepository.logActivity(req.user.username, 'DELETE', 'inventory_products', `تم حذف المنتج ${name} من المخزون`).catch(console.error);
            res.json({ success: true });
        });
    });
});

router.post('/inventory/products/clear', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تفريغ المخزون.' });
    }
    db.run("DELETE FROM inventory_products", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        ConfigRepository.logActivity(req.user.username, 'CLEAR', 'inventory_products', `تم تفريغ وحذف كافة منتجات المخزون المستقل`).catch(console.error);
        res.json({ success: true });
    });
});

router.post('/inventory/products/bulk', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية استيراد منتجات المخزون.' });
    }
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ error: 'يرجى تقديم مصفوفة منتجات صالحة.' });
    }
    const dateStr = new Date().toISOString().split('T')[0];
    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT INTO inventory_products (product_name, quantity, cost, price, category, created_at) 
            VALUES (?, ?, ?, ?, 'عام', ?)
            ON CONFLICT(product_name) DO UPDATE SET 
                quantity = excluded.quantity,
                cost = CASE WHEN excluded.cost > 0 THEN excluded.cost ELSE cost END,
                price = CASE WHEN excluded.price > 0 THEN excluded.price ELSE price END
        `);
        products.forEach(p => {
            stmt.run([
                String(p.product_name).trim(),
                parseInt(p.stock_offset) || 0,
                parseFloat(p.cost) || 0,
                parseFloat(p.price) || 0,
                dateStr
            ]);
        });
        stmt.finalize((err) => {
            if (err) {
                console.error('خطأ أثناء استيراد المنتجات للمخزون المستقل:', err.message);
                return res.status(500).json({ error: 'فشل حفظ المنتجات في قاعدة البيانات.' });
            }
            ConfigRepository.logActivity(req.user.username, 'IMPORT', 'inventory_products', `تم استيراد وتحديث ${products.length} منتج في المخزون المستقل`).catch(console.error);
            res.json({ success: true, count: products.length });
        });
    });
});

// Sync and import products from Salla (supports direct OAuth API and offline fallback from imported orders)
router.post('/inventory/products/sync-salla', authenticateUser, async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_salla_products) {
        return res.status(403).json({ error: 'ليس لديك صلاحية استيراد منتجات سلة.' });
    }
    
    try {
        const SallaService = require('../services/salla.service');
        const token = await SallaService.getOrRefreshToken();
        
        if (!token) {
            // FALLBACK: Offline mode or Salla not connected.
            // Extract unique products from salla_imported_orders!
            db.all(
                "SELECT DISTINCT product_name, AVG(amount) as avg_price FROM salla_imported_orders GROUP BY product_name",
                [],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!rows || rows.length === 0) {
                        return res.status(400).json({ error: 'منصة سلة غير متصلة، ولم يتم العثور على أي مبيعات مستوردة مسبقاً لاستخراج المنتجات منها.' });
                    }
                    
                    const dateStr = new Date().toISOString().split('T')[0];
                    db.serialize(() => {
                        const stmt = db.prepare(`
                            INSERT INTO inventory_products (product_name, quantity, cost, price, category, created_at) 
                            VALUES (?, 0, 0, ?, 'عام', ?)
                            ON CONFLICT(product_name) DO NOTHING
                        `);
                        rows.forEach(r => {
                            if (r.product_name && r.product_name !== 'طلب بدون عناصر') {
                                stmt.run([r.product_name.trim(), parseFloat(r.avg_price) || 0, dateStr]);
                            }
                        });
                        stmt.finalize((errFinal) => {
                            if (errFinal) return res.status(500).json({ error: errFinal.message });
                            ConfigRepository.logActivity(req.user.username, 'SYNC', 'inventory_products', `تم استخراج وتوحيـد ${rows.length} منتج من المبيعات المستوردة (أوفلاين)`).catch(console.error);
                            res.json({ success: true, source: 'offline_orders', count: rows.length });
                        });
                    });
                }
            );
        } else {
            // ONLINE MODE: Fetch from Salla API!
            console.log('[SallaService] جاري سحب المنتجات من منصة سلة...');
            const response = await axios.get('https://api.salla.dev/admin/v2/products?per_page=20', {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Accept-Language': 'ar'
                }
            });
            
            const products = response.data?.data || [];
            if (products.length === 0) {
                return res.json({ success: true, source: 'salla_api', count: 0 });
            }
            
            const dateStr = new Date().toISOString().split('T')[0];
            db.serialize(() => {
                const stmt = db.prepare(`
                    INSERT INTO inventory_products (product_name, sku, quantity, cost, price, category, created_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(product_name) DO UPDATE SET 
                        sku = COALESCE(excluded.sku, sku),
                        cost = CASE WHEN excluded.cost > 0 THEN excluded.cost ELSE cost END,
                        price = CASE WHEN excluded.price > 0 THEN excluded.price ELSE price END
                `);
                
                products.forEach(p => {
                    const name = String(p.name).trim();
                    const sku = p.sku ? String(p.sku).trim() : null;
                    const price = parseFloat(p.price?.amount) || 0;
                    const cost = parseFloat(p.cost_price) || 0;
                    const stock = parseInt(p.quantity) || 0;
                    
                    stmt.run([name, sku, stock, cost, price, 'عام', dateStr]);
                });
                
                stmt.finalize((errFinal) => {
                    if (errFinal) return res.status(500).json({ error: errFinal.message });
                    ConfigRepository.logActivity(req.user.username, 'SYNC', 'inventory_products', `تم استيراد ومزامنة ${products.length} منتج مباشرة من منصة سلة (أونلاين)`).catch(console.error);
                    res.json({ success: true, source: 'salla_api', count: products.length });
                });
            });
        }
    } catch (e) {
        console.error('[Sync Salla Products Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- PRODUCT PRICING RULES ---

// جلب جميع قواعد التسعير
router.get('/inventory/pricing-rules', authenticateUser, (req, res) => {
    db.all("SELECT * FROM product_pricing_rules ORDER BY product_name ASC, period ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// إضافة أو تحديث قاعدة تسعير (Upsert)
router.post('/inventory/pricing-rules', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل إعدادات الأسعار.' });
    }
    const { product_name, period, purchase_price, selling_price, copies_per_unit, free_bundle_product, free_bundle_qty_multiplier, notes } = req.body;
    if (!product_name) {
        return res.status(400).json({ error: 'اسم المنتج مطلوب.' });
    }
    db.run(
        `INSERT INTO product_pricing_rules (product_name, period, purchase_price, selling_price, copies_per_unit, free_bundle_product, free_bundle_qty_multiplier, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_name, period) DO UPDATE SET
            purchase_price = excluded.purchase_price,
            selling_price = excluded.selling_price,
            copies_per_unit = excluded.copies_per_unit,
            free_bundle_product = excluded.free_bundle_product,
            free_bundle_qty_multiplier = excluded.free_bundle_qty_multiplier,
            notes = excluded.notes`,
        [
            product_name.trim(),
            (period || '').trim(),
            parseFloat(purchase_price) || 0,
            parseFloat(selling_price) || 0,
            parseInt(copies_per_unit) || 1,
            free_bundle_product ? free_bundle_product.trim() : null,
            parseFloat(free_bundle_qty_multiplier) || 0,
            notes ? notes.trim() : null
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            ConfigRepository.logActivity(req.user.username, 'UPSERT', 'product_pricing_rules', `تم تحديث تسعير: ${product_name} (${period || 'بدون فترة'})`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// حذف قاعدة تسعير
router.delete('/inventory/pricing-rules/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف إعدادات الأسعار.' });
    }
    db.run("DELETE FROM product_pricing_rules WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
ConfigRepository.logActivity(req.user.username, 'DELETE', 'product_pricing_rules', `تم حذف قاعدة تسعير ID: ${req.params.id}`).catch(console.error);
        res.json({ success: true });
    });
});

// ─── GET /api/inventory/product-overview ───
router.get('/inventory/product-overview', authenticateUser, (req, res) => {
    const { from, to } = req.query;
    const params = [];

    let expDateFilter = '';
    if (from) {
        expDateFilter += ' AND date(date) >= date(?)';
        params.push(from);
    }
    if (to) {
        expDateFilter += ' AND date(date) <= date(?)';
        params.push(to);
    }

    let ordersDateFilter = '';
    if (from) {
        ordersDateFilter += ' AND date(date) >= date(?)';
        params.push(from);
    }
    if (to) {
        ordersDateFilter += ' AND date(date) <= date(?)';
        params.push(to);
    }

    const sql = `
        SELECT
            ip.product_name,
            ip.salla_product_id,
            ip.last_synced_from_salla,

            -- مخزون المشتريات (من المصروفات المجمّعة)
            COALESCE(p.total_purchased_qty, 0)  AS total_purchased_qty,
            COALESCE(p.total_purchase_cost, 0)  AS total_purchase_cost,
            COALESCE(p.avg_unit_cost, 0)        AS avg_unit_cost,
            ip.quantity                         AS purchase_stock,

            -- مخزون سلة
            ip.salla_quantity                   AS salla_stock,

            -- الفارق (سلة − مشتريات)
            (ip.salla_quantity - ip.quantity)   AS stock_diff,

            -- طلبات سلة
            COALESCE(s.salla_qty, 0)            AS salla_orders_qty,
            COALESCE(s.pending_qty, 0)          AS salla_orders_pending,
            COALESCE(s.completed_qty, 0)        AS salla_orders_completed,

            -- المتبقي المحسوب (من مخزون سلة كمصدر رئيسي)
            (ip.salla_quantity - COALESCE(s.pending_qty, 0)) AS remaining_stock,

            COALESCE(ip.reorder_threshold, 3)   AS reorder_threshold,
            p.last_purchase_date

        FROM inventory_products ip

        LEFT JOIN (
            SELECT
                product_name,
                SUM(quantity)                              AS total_purchased_qty,
                SUM(amt)                                   AS total_purchase_cost,
                ROUND(SUM(amt)/NULLIF(SUM(quantity),0),2)  AS avg_unit_cost,
                MAX(date)                                  AS last_purchase_date
            FROM expenses
            WHERE cat = 'مشتريات' AND product_name IS NOT NULL AND product_name != '' ${expDateFilter}
            GROUP BY product_name
        ) p ON LOWER(TRIM(p.product_name)) = LOWER(TRIM(ip.product_name))

        LEFT JOIN (
            SELECT
                product_name,
                SUM(quantity) AS salla_qty,
                SUM(CASE WHEN status_slug = 'under-review' THEN quantity ELSE 0 END) AS pending_qty,
                SUM(CASE WHEN status_slug = 'completed'    THEN quantity ELSE 0 END) AS completed_qty
            FROM salla_imported_orders
            WHERE status_slug IN ('under-review', 'completed') AND product_name IS NOT NULL AND product_name != '' ${ordersDateFilter}
            GROUP BY product_name
        ) s ON LOWER(TRIM(s.product_name)) = LOWER(TRIM(ip.product_name))

        ORDER BY 
            ABS(ip.salla_quantity - ip.quantity) DESC,  -- الفارق الأكبر أولاً
            remaining_stock ASC
    `;

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

// ─── POST /api/inventory/sync-from-salla ───
router.post('/inventory/sync-from-salla', authenticateUser, async (req, res) => {
    try {
        const token = await SallaService.getOrRefreshToken();
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                error: 'انتهت صلاحية ربط سلة — أعد تفويض التطبيق' 
            });
        }

        // جلب قائمة المنتجات من سلة (مع pagination)
        let allProducts = [];
        let cursor = null;

        do {
            const url = cursor
                ? `https://api.salla.dev/admin/v2/products?cursor=${cursor}&per_page=50`
                : `https://api.salla.dev/admin/v2/products?per_page=50`;

            const response = await axios.get(url, {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Accept-Language': 'ar'
                }
            });

            if (response.status !== 200) {
                throw new Error(`سلة API خطأ: ${response.status}`);
            }

            const data = response.data;
            allProducts = allProducts.concat(data.data || []);
            cursor = data.pagination?.next_cursor || null;

        } while (cursor);

        // تحديث salla_quantity لكل منتج
        let updatedCount = 0;
        let notFoundCount = 0;
        const unmatched = [];
        const now = new Date().toISOString();
        const todayDate = now.split('T')[0];

        for (const product of allProducts) {
            const sallaQty   = product.quantity ?? 0;
            const sallaId    = String(product.id);
            const sallaName  = product.name;

            // حاول المطابقة بالمعرّف أولاً، ثم بالاسم
            await new Promise((resolve) => {
                db.run(`
                    UPDATE inventory_products
                    SET 
                        salla_quantity          = ?,
                        salla_product_id        = ?,
                        last_synced_from_salla  = ?
                    WHERE 
                        salla_product_id = ?
                        OR LOWER(TRIM(product_name)) = LOWER(TRIM(?))
                `, [sallaQty, sallaId, now, sallaId, sallaName],
                async function(err) {
                    if (!err && this.changes > 0) {
                        updatedCount++;
                    } else {
                        // منتج سلة غير موجود في inventory_products → أضفه تلقائياً
                        await new Promise((resolveInsert) => {
                            db.run(`
                                INSERT OR IGNORE INTO inventory_products
                                    (product_name, quantity, salla_quantity, salla_product_id, last_synced_from_salla, created_at)
                                VALUES (?, 0, ?, ?, ?, ?)
                            `, [sallaName, sallaQty, sallaId, now, todayDate], function(errInsert) {
                                if (!errInsert && this.changes > 0) {
                                    notFoundCount++;
                                    unmatched.push({ name: sallaName, salla_product_id: sallaId, quantity: sallaQty });
                                }
                                resolveInsert();
                            });
                        });
                    }
                    resolve();
                });
            });
        }

        res.json({
            success: true,
            message: `تم تحديث ${updatedCount} منتج بنجاح، وإضافة ${notFoundCount} منتج جديد من سلة.`,
            stats: {
                total_from_salla : allProducts.length,
                updated          : updatedCount,
                new_added        : notFoundCount
            },
            unmatched: unmatched // إرجاع قائمة المنتجات غير المطابقة محلياً
        });

    } catch (error) {
        console.error('sync-from-salla error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PATCH /api/inventory/update-purchase-stock ───
router.patch('/inventory/update-purchase-stock', authenticateUser, (req, res) => {
    const { product_name, quantity, mode = 'add' } = req.body;

    if (!product_name || quantity === undefined) {
        return res.status(400).json({ 
            success: false, 
            error: 'product_name و quantity مطلوبان' 
        });
    }

    const qty = parseInt(quantity);
    if (isNaN(qty) || qty < 0) {
        return res.status(400).json({ 
            success: false, 
            error: 'الكمية يجب أن تكون رقماً موجباً' 
        });
    }

    const sql = mode === 'add'
        ? `UPDATE inventory_products 
           SET quantity = quantity + ?
           WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))`
        : `UPDATE inventory_products 
           SET quantity = ?
           WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))`;

    db.run(sql, [qty, product_name], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) {
            // المنتج غير موجود → أنشئه
            const todayDate = new Date().toISOString().split('T')[0];
            db.run(`
                INSERT INTO inventory_products (product_name, quantity, salla_quantity, created_at)
                VALUES (?, ?, 0, ?)
            `, [product_name, qty, todayDate], (err2) => {
                if (err2) return res.status(500).json({ success: false, error: err2.message });
                res.json({ success: true, updated: 1, created: true });
            });
        } else {
            res.json({ success: true, updated: this.changes });
        }
    });
});

// ─── PATCH /api/inventory/push-to-salla ───
router.patch('/inventory/push-to-salla', authenticateUser, async (req, res) => {
    const { salla_product_id, new_quantity } = req.body;

    if (!salla_product_id || new_quantity === undefined) {
        return res.status(400).json({ 
            success: false, 
            error: 'salla_product_id و new_quantity مطلوبان' 
        });
    }

    try {
        const token = await SallaService.getOrRefreshToken();
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                error: 'انتهت صلاحية ربط سلة — أعد تفويض التطبيق' 
            });
        }

        const url = `https://api.salla.dev/admin/v2/products/${salla_product_id}`;
        const response = await axios.put(url, {
            quantity: new_quantity
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status !== 200) {
            throw new Error(`سلة API خطأ: ${response.status}`);
        }

        // حدّث salla_quantity محلياً أيضاً
        db.run(`
            UPDATE inventory_products 
            SET salla_quantity = ?, last_synced_from_salla = ?
            WHERE salla_product_id = ?
        `, [new_quantity, new Date().toISOString(), salla_product_id]);

        res.json({ 
            success: true, 
            message: `تم تحديث مخزون سلة بنجاح إلى ${new_quantity} وحدة.` 
        });

    } catch (error) {
        console.error('push-to-salla error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/inventory/product-detail ───
router.get('/inventory/product-detail', authenticateUser, (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'اسم المنتج مطلوب.' });

    // جلب آخر 5 طلبات
    const ordersSql = `
        SELECT reference_id, date, status_name, amount, quantity, customer_name
        FROM salla_imported_orders
        WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))
        ORDER BY date DESC LIMIT 5
    `;

    // جلب أحدث 5 عمليات شراء
    const purchasesSql = `
        SELECT id, desc, amt, date, quantity, purchase_price, note
        FROM expenses
        WHERE cat = 'مشتريات' AND LOWER(TRIM(product_name)) = LOWER(TRIM(?))
        ORDER BY date DESC LIMIT 5
    `;

    db.all(ordersSql, [name], (errOrders, orders) => {
        if (errOrders) return res.status(500).json({ error: errOrders.message });

        db.all(purchasesSql, [name], (errPurchases, purchases) => {
            if (errPurchases) return res.status(500).json({ error: errPurchases.message });

            // جلب عتبة إعادة الطلب الافتراضية
            db.get("SELECT reorder_threshold FROM inventory_products WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))", [name], (errMap, mapRow) => {
                const threshold = mapRow ? mapRow.reorder_threshold : 3;
                
                res.json({
                    success: true,
                    product_name: name,
                    reorder_threshold: threshold,
                    recent_orders: orders || [],
                    recent_purchases: purchases || []
                });
            });
        });
    });
});

module.exports = router;
