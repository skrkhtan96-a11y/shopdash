const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const ConfigRepository = require('../repositories/config.repository');
const { authenticateUser, requireRole } = require('../middlewares/auth');

// --- ACTIVITY LOGS ---

// Get activity logs (accessible to authenticated users)
router.get('/activity-logs', authenticateUser, (req, res) => {
    db.all("SELECT * FROM activity_logs ORDER BY id DESC LIMIT 500", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- DATABASE BACKUP & RESTORE (Admin Only) ---

router.get('/database/backup', authenticateUser, requireRole(['admin']), (req, res) => {
    const mainDbPath = path.join(__dirname, '..', '..', 'database.db');
    res.download(mainDbPath, `database_backup_${Date.now()}.db`, (err) => {
        if (err) {
            console.error('Error downloading DB:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'فشل تحميل ملف قاعدة البيانات.' });
            }
        }
    });
});

router.post('/database/restore', authenticateUser, requireRole(['admin']), (req, res) => {
    const { dbFileBase64 } = req.body;
    if (!dbFileBase64) {
        return res.status(400).json({ error: 'لم يتم توفير ملف قاعدة البيانات المرفوع.' });
    }

    try {
        const buffer = Buffer.from(dbFileBase64, 'base64');
        const signature = Buffer.from("SQLite format 3\0", "utf8");
        
        if (buffer.length < 16 || !buffer.slice(0, 16).equals(signature)) {
            return res.status(400).json({ error: 'الملف المرفوع ليس ملف قاعدة بيانات SQLite صالح.' });
        }

        const tempPath = path.join(__dirname, '..', '..', 'database_temp.db');
        fs.writeFileSync(tempPath, buffer);

        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err);
                return res.status(500).json({ error: 'فشل إغلاق الاتصال بقاعدة البيانات الحالية.' });
            }

            const mainDbPath = path.join(__dirname, '..', '..', 'database.db');
            fs.copyFile(tempPath, mainDbPath, (copyErr) => {
                if (copyErr) {
                    console.error('Error copying database file:', copyErr);
                    return res.status(500).json({ error: 'فشل استبدال ملف قاعدة البيانات.' });
                }

                fs.unlink(tempPath, () => {});
                
                res.json({ 
                    success: true, 
                    message: 'تم استعادة قاعدة البيانات بنجاح. سيتم إعادة تشغيل اللوحة تلقائياً خلال ثانيتين لتطبيق التغييرات.' 
                });

                // Exit process to trigger PM2 restart
                setTimeout(() => {
                    process.exit(0);
                }, 2000);
            });
        });
    } catch (e) {
        console.error('Database restore error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- MONTHLY ARCHIVES ---

// Get all archives
router.get('/archives', authenticateUser, (req, res) => {
    db.all("SELECT key, name, month, archived_at FROM archives ORDER BY key DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Get archived month details
router.get('/archives/:key', authenticateUser, (req, res) => {
    const { key } = req.params;
    db.get("SELECT * FROM archives WHERE key = ?", [key], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'الأرشيف غير موجود' });
        }
        res.json({
            key: row.key,
            name: row.name,
            month: row.month,
            archived_at: row.archived_at,
            expenses: JSON.parse(row.expenses_json || '[]'),
            sales: JSON.parse(row.sales_json || '[]'),
            wallet: JSON.parse(row.wallet_json || '[]')
        });
    });
});

// Archive current month and start fresh month
router.post('/archives', authenticateUser, async (req, res) => {
    const { name, month, sales_json, wallet_json } = req.body;
    if (!name || !month) {
        return res.status(400).json({ error: 'يرجى إرسال اسم الأرشيف والشهر.' });
    }

    const key = `${month}-${Date.now()}`;
    const archivedAt = new Date().toLocaleDateString('ar-SA');

    db.all("SELECT * FROM expenses WHERE archived_in IS NULL", [], (err, expenses) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const expensesJson = JSON.stringify(expenses);

        db.serialize(() => {
            db.run(
                "INSERT INTO archives (key, name, month, archived_at, expenses_json, sales_json, wallet_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [key, name, month, archivedAt, expensesJson, sales_json || '[]', wallet_json || '[]'],
                function (err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }

                    db.run("UPDATE expenses SET archived_in = ? WHERE archived_in IS NULL", [key], (err) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        res.json({ success: true, key });
                    });
                }
            );
        });
    });
});

// Delete a monthly archive
router.delete('/archives/:key', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_delete) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف الأرشيف الشهري.' });
    }
    const { key } = req.params;
    db.run("DELETE FROM archives WHERE key = ?", [key], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// --- EXTERNAL SALES ---

// Get external sales
router.get('/external-sales', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'sales_employee' && !req.user.can_view_external_sales) {
        return res.status(403).json({ error: 'غير مصرح لك باستعراض المبيعات الخارجية.' });
    }

    db.all("SELECT * FROM external_sales ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const stats = {
            total: 0,
            wathiqa: 0,
            najm: 0,
            qutaibi: 0,
            kuraimi: 0,
            usd: 0,
            zad: 0
        };

        rows.forEach(r => {
            const amt = parseFloat(r.amount) || 0;
            stats.total += amt;
            if (r.bank_account === 'حساب الوثيقة') stats.wathiqa += amt;
            else if (r.bank_account === 'حساب نجم') stats.najm += amt;
            else if (r.bank_account === 'حساب القطيبي') stats.qutaibi += amt;
            else if (r.bank_account === 'حساب الكريمي') stats.kuraimi += amt;
            else if (r.bank_account === 'حساب USD') stats.usd += amt;
            else if (r.bank_account === 'حساب زاد') stats.zad += amt;
        });

        res.json({ sales: rows, stats });
    });
});

// Create new external sale
router.post('/external-sales', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'sales_employee' && !req.user.can_view_external_sales) {
        return res.status(403).json({ error: 'غير مصرح لك بإدخال مبيعات خارجية.' });
    }

    const { product_name, quantity, amount, bank_account, customer_name, customer_phone, transfer_reference, status, notes, country, order_number, receipt_url } = req.body;
    
    if (!product_name || !amount || !bank_account) {
        return res.status(400).json({ error: 'حقول اسم المنتج، المبلغ، والحساب البنكي مطلوبة.' });
    }

    const utcDate = new Date();
    const saudiDate = new Date(utcDate.getTime() + (3 * 60 * 60 * 1000));
    
    const yyyy = saudiDate.getUTCFullYear();
    const mm = String(saudiDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(saudiDate.getUTCDate()).padStart(2, '0');
    
    let hours = saudiDate.getUTCHours();
    const minutes = String(saudiDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(saudiDate.getUTCSeconds()).padStart(2, '0');
    
    const ampm = hours >= 12 ? 'م' : 'ص';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const hh = String(hours).padStart(2, '0');
    
    const saudiTimeStr = `${yyyy}-${mm}-${dd} ${hh}:${minutes}:${seconds} ${ampm}`;

    db.run(
        `INSERT INTO external_sales (product_name, quantity, amount, bank_account, customer_name, customer_phone, transfer_reference, status, notes, country, order_number, receipt_url, created_by, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            product_name.trim(),
            parseInt(quantity) || 1,
            parseFloat(amount),
            bank_account.trim(),
            customer_name ? customer_name.trim() : null,
            customer_phone ? customer_phone.trim() : null,
            transfer_reference ? transfer_reference.trim() : null,
            status || 'delivered',
            notes ? notes.trim() : null,
            country ? country.trim() : null,
            order_number ? order_number.trim() : null,
            receipt_url || null,
            req.user.username,
            saudiTimeStr
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            ConfigRepository.logActivity(req.user.username, 'ADD', 'external_sales', `تم تسجيل مبيعة خارجية: ${product_name} بمبلغ ${amount} ر.س محولة إلى ${bank_account} - الدولة: ${country || 'غير محددة'} - رقم الطلب: ${order_number || '-'}`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Delete an external sale
router.delete('/external-sales/:id', authenticateUser, requireRole(['admin']), (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM external_sales WHERE id = ?", [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        ConfigRepository.logActivity(req.user.username, 'DELETE', 'external_sales', `تم حذف مبيعة خارجية معرف: ${id}`).catch(console.error);
        res.json({ success: true });
    });
});

// Update an external sale (Admin or Sales Employee if permitted)
router.put('/external-sales/:id', authenticateUser, (req, res) => {
    const { id } = req.params;
    const isSalesEmployee = req.user.role === 'sales_employee';
    const isAdmin = req.user.role === 'admin';
    const canEdit = req.user.can_edit === 1 || req.user.can_edit === true || isAdmin;

    if (!isAdmin && !isSalesEmployee && !req.user.can_view_external_sales) {
        return res.status(403).json({ error: 'غير مصرح لك بتعديل المبيعات الخارجية.' });
    }
    
    if (!canEdit) {
        return res.status(403).json({ error: 'عذراً، لا تملك الصلاحية لتعديل البيانات.' });
    }

    const { product_name, quantity, amount, bank_account, customer_name, customer_phone, transfer_reference, notes, country, order_number, receipt_url } = req.body;

    if (!product_name || !amount || !bank_account) {
        return res.status(400).json({ error: 'حقول اسم المنتج، المبلغ، والحساب البنكي مطلوبة.' });
    }

    db.run(
        `UPDATE external_sales SET 
            product_name = ?, 
            quantity = ?, 
            amount = ?, 
            bank_account = ?, 
            customer_name = ?, 
            customer_phone = ?, 
            transfer_reference = ?, 
            notes = ?, 
            country = ?, 
            order_number = ?, 
            receipt_url = ?
         WHERE id = ?`,
        [
            product_name.trim(),
            parseInt(quantity) || 1,
            parseFloat(amount),
            bank_account.trim(),
            customer_name ? customer_name.trim() : null,
            customer_phone ? customer_phone.trim() : null,
            transfer_reference ? transfer_reference.trim() : null,
            notes ? notes.trim() : null,
            country ? country.trim() : null,
            order_number ? order_number.trim() : null,
            receipt_url || null,
            id
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            ConfigRepository.logActivity(req.user.username, 'UPDATE', 'external_sales', `تم تعديل مبيعة خارجية معرف: ${id} - اسم المنتج: ${product_name}`).catch(console.error);
            res.json({ success: true });
        }
    );
});

// --- SYSTEM RESET ENDPOINT ---

router.post('/system/clear-all', authenticateUser, requireRole(['admin']), (req, res) => {
    const tables = ['expenses', 'archives', 'salla_imported_orders', 'salla_imported_wallet', 'product_adjustments', 'ads_campaign_metrics', 'ads_connections'];
    let errorOccurred = false;
    let completed = 0;
    
    tables.forEach(table => {
        db.run(`DELETE FROM ${table}`, [], (err) => {
            if (err && !errorOccurred) {
                errorOccurred = true;
                return res.status(500).json({ error: err.message });
            }
            completed++;
            if (completed === tables.length && !errorOccurred) {
                db.run("VACUUM", [], () => {
                    res.json({ success: true });
                });
            }
        });
    });
});

module.exports = router;
