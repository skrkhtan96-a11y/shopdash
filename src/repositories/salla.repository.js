const db = require('../config/db');

const SallaRepository = {
    // Orders
    getOrders: (from, to, status, products, q, sort) => {
        return new Promise((resolve, reject) => {
            let query = "SELECT * FROM salla_imported_orders WHERE 1=1";
            const params = [];

            if (status) {
                query += " AND status = ?";
                params.push(status);
            }
            if (from) {
                query += " AND date >= ?";
                params.push(from);
            }
            if (to) {
                query += " AND date <= ?";
                params.push(to);
            }
            if (products) {
                const plist = products.split(',');
                query += ` AND product_name IN (${plist.map(() => '?').join(',')})`;
                plist.forEach(p => params.push(p));
            }
            if (q) {
                query += " AND (product_name LIKE ? OR id LIKE ? OR customer_name LIKE ?)";
                params.push(`%${q}%`, `%${q}%`, `%${q}%`);
            }

            if (sort === 'asc') {
                query += " ORDER BY date ASC, id ASC";
            } else if (sort === 'amt-desc') {
                query += " ORDER BY amount DESC";
            } else if (sort === 'amt-asc') {
                query += " ORDER BY amount ASC";
            } else {
                query += " ORDER BY date DESC, id DESC";
            }

            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    saveOrdersBulk: (orders) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO salla_imported_orders 
                    (id, order_number, date, customer_name, customer_phone, payment_method, amount, status, product_name, quantity, total_payout, salla_commission, gateway_commission, salla_tax, gateway_tax, net_payout, delivery_status) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                orders.forEach(o => {
                    stmt.run([
                        o.id,
                        o.order_number,
                        o.date,
                        o.customer_name || '',
                        o.customer_phone || '',
                        o.payment_method || '',
                        parseFloat(o.amount) || 0,
                        o.status || '',
                        o.product_name || '',
                        parseInt(o.quantity) || 1,
                        parseFloat(o.total_payout) || 0,
                        parseFloat(o.salla_commission) || 0,
                        parseFloat(o.gateway_commission) || 0,
                        parseFloat(o.salla_tax) || 0,
                        parseFloat(o.gateway_tax) || 0,
                        parseFloat(o.net_payout) || 0,
                        o.delivery_status || 'not_delivered'
                    ]);
                });

                stmt.finalize((err) => {
                    if (err) {
                        db.run("ROLLBACK");
                        reject(err);
                    } else {
                        db.run("COMMIT", (commitErr) => {
                            if (commitErr) reject(commitErr);
                            else resolve(orders.length);
                        });
                    }
                });
            });
        });
    },

    clearOrders: () => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM salla_imported_orders", [], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    },

    // Wallet
    getWallet: (from, to, status) => {
        return new Promise((resolve, reject) => {
            let query = "SELECT * FROM salla_imported_wallet WHERE 1=1";
            const params = [];

            if (status) {
                query += " AND status = ?";
                params.push(status);
            }
            if (from) {
                query += " AND date >= ?";
                params.push(from);
            }
            if (to) {
                query += " AND date <= ?";
                params.push(to);
            }

            query += " ORDER BY date DESC, id DESC";

            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    saveWalletBulk: (transactions) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO salla_imported_wallet 
                    (id, reference_id, date, type, amount, commission, net, status) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);

                transactions.forEach(t => {
                    stmt.run([
                        t.id,
                        t.reference_id,
                        t.date,
                        t.type || '',
                        parseFloat(t.amount) || 0,
                        parseFloat(t.commission) || 0,
                        parseFloat(t.net) || 0,
                        t.status || ''
                    ]);
                });

                stmt.finalize((err) => {
                    if (err) {
                        db.run("ROLLBACK");
                        reject(err);
                    } else {
                        db.run("COMMIT", (commitErr) => {
                            if (commitErr) reject(commitErr);
                            else resolve(transactions.length);
                        });
                    }
                });
            });
        });
    },

    clearWallet: () => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM salla_imported_wallet", [], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }
};

module.exports = SallaRepository;
