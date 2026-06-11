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
            const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period } = expense;
            db.run(
                "INSERT INTO expenses (desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                    period || null
                ],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },

    update: (id, expense) => {
        return new Promise((resolve, reject) => {
            const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period } = expense;
            db.run(
                "UPDATE expenses SET desc = ?, cat = ?, amt = ?, date = ?, note = ?, product_name = ?, quantity = ?, purchase_price = ?, selling_price = ?, platform_name = ?, period = ? WHERE id = ?",
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
            db.run("DELETE FROM expenses WHERE id = ?", [id], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
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
