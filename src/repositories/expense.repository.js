const db = require('../config/db');

const ExpenseRepository = {
    getAll: (cat, period, descs, q, sort, from, to) => {
        return new Promise((resolve, reject) => {
            let query = "SELECT * FROM expenses WHERE archived_in IS NULL";
            const params = [];

            if (cat) {
                query += " AND cat = ?";
                params.push(cat);
            }
            if (period) {
                query += " AND period = ?";
                params.push(period);
            }
            if (descs) {
                const descList = descs.split(',');
                query += ` AND desc IN (${descList.map(() => '?').join(',')})`;
                descList.forEach(d => params.push(d));
            }
            if (q) {
                query += " AND (desc LIKE ? OR note LIKE ?)";
                params.push(`%${q}%`, `%${q}%`);
            }
            if (from) {
                query += " AND date >= ?";
                params.push(from);
            }
            if (to) {
                query += " AND date <= ?";
                params.push(to);
            }

            if (sort === 'asc') query += " ORDER BY date ASC, id ASC";
            else if (sort === 'amt-desc') query += " ORDER BY amt DESC";
            else if (sort === 'amt-asc') query += " ORDER BY amt ASC";
            else query += " ORDER BY date DESC, id DESC";

            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    getById: (id) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM expenses WHERE id = ?", [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    add: (expense) => {
        return new Promise((resolve, reject) => {
            const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period, receipt_url } = expense;
            db.run(
                "INSERT INTO expenses (desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period, receipt_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    desc,
                    cat,
                    parseFloat(amt),
                    date,
                    note || '',
                    product_name || null,
                    quantity ? parseInt(quantity) : null,
                    purchase_price ? parseFloat(purchase_price) : null,
                    selling_price ? parseFloat(selling_price) : null,
                    platform_name || null,
                    period || null,
                    receipt_url || null
                ],
                function (err) {
                    if (err) {
                        reject(err);
                    } else {
                        const insertId = this.lastID;
                        // تحديث مخزون المشتريات تلقائياً عند إضافة بند مشتريات جديد
                        if (cat === 'مشتريات' && product_name && quantity) {
                            const qty = parseInt(quantity);
                            db.run(
                                `UPDATE inventory_products
                                 SET quantity = quantity + ?
                                 WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))`,
                                [qty, product_name],
                                function(errUpdate) {
                                    if (!errUpdate && this.changes === 0) {
                                        // المنتج غير موجود → أنشئه
                                        const todayDate = new Date().toISOString().split('T')[0];
                                        db.run(
                                            `INSERT INTO inventory_products (product_name, quantity, salla_quantity, created_at)
                                             VALUES (?, ?, 0, ?)`,
                                            [product_name, qty, todayDate]
                                        );
                                    }
                                }
                            );
                        }
                        resolve(insertId);
                    }
                }
            );
        });
    },

    update: (id, expense) => {
        return new Promise((resolve, reject) => {
            const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period, receipt_url } = expense;
            db.run(
                "UPDATE expenses SET desc = ?, cat = ?, amt = ?, date = ?, note = ?, product_name = ?, quantity = ?, purchase_price = ?, selling_price = ?, platform_name = ?, period = ?, receipt_url = ? WHERE id = ?",
                [
                    desc,
                    cat,
                    parseFloat(amt),
                    date,
                    note || '',
                    product_name || null,
                    quantity ? parseInt(quantity) : null,
                    purchase_price ? parseFloat(purchase_price) : null,
                    selling_price ? parseFloat(selling_price) : null,
                    platform_name || null,
                    period || null,
                    receipt_url || null,
                    id
                ],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    },

    delete: (id) => {
        return new Promise((resolve, reject) => {
            // جلب تفاصيل المصروف قبل حذفه لتعديل المخزون
            db.get("SELECT cat, product_name, quantity FROM expenses WHERE id = ?", [id], (errGet, row) => {
                if (!errGet && row && row.cat === 'مشتريات' && row.product_name && row.quantity) {
                    const qty = parseInt(row.quantity);
                    db.run(
                        `UPDATE inventory_products
                         SET quantity = MAX(0, quantity - ?)
                         WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))`,
                        [qty, row.product_name]
                    );
                }
                
                db.run("DELETE FROM expenses WHERE id = ?", [id], function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                });
            });
        });
    },

    clearAll: () => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM expenses", [], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }
};

module.exports = ExpenseRepository;
