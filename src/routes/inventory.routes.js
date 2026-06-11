const express = require('express');
const router = express.Router();
const db = require('../config/db');
const ConfigRepository = require('../repositories/config.repository');
const { authenticateUser } = require('../middlewares/auth');

// --- CERTIFICATES ---

// Get all certificates
router.get('/certificates', authenticateUser, (req, res) => {
    db.all("SELECT * FROM certificates ORDER BY name ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a new certificate
router.post('/certificates', authenticateUser, (req, res) => {
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
    db.all("SELECT * FROM product_adjustments", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

router.post('/products/adjustments', authenticateUser, (req, res) => {
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
    if (req.user.role !== 'admin' && !req.user.can_delete) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف المخزون.' });
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
    if (req.user.role !== 'admin' && !req.user.can_delete) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف المخزون.' });
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
    db.all("SELECT * FROM inventory_products ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

router.post('/inventory/products', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_add) {
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
    if (req.user.role !== 'admin' && !req.user.can_edit) {
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
    if (req.user.role !== 'admin' && !req.user.can_delete) {
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
    if (req.user.role !== 'admin' && !req.user.can_delete) {
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

module.exports = router;
