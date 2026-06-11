const db = require('../config/db');

const UserRepository = {
    findByLogin: (login) => {
        return new Promise((resolve, reject) => {
            db.get(
                "SELECT * FROM users WHERE username = ? OR email = ?",
                [login.trim(), login.trim().toLowerCase()],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    },

    createSession: (token, userId, expiresAt) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                [token, userId, expiresAt],
                (err) => {
                    if (err) reject(err);
                    else resolve(true);
                }
            );
        });
    },

    deleteSession: (token) => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM sessions WHERE token = ?", [token], (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    },

    getAll: () => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, username, email, role, can_add, can_edit, can_delete, can_deliver, 
                        can_view_ps_details, can_view_games_details, can_view_external_sales,
                        can_view_expenses, can_add_expenses, can_edit_expenses, can_delete_expenses,
                        can_add_external_sales, can_edit_external_sales, can_delete_external_sales,
                        can_view_campaigns, can_add_campaigns, can_edit_campaigns, can_delete_campaigns,
                        can_view_certificates, can_add_certificates, can_edit_certificates, can_delete_certificates,
                        can_view_ps, can_add_ps, can_edit_ps, can_delete_ps,
                        can_view_games, can_add_games, can_edit_games, can_delete_games,
                        can_view_salla_orders, can_view_salla_carts, can_view_salla_wallet, can_view_salla_products, can_edit_salla_products, can_view_salla_compare, can_view_salla_webhooks, can_edit_salla_webhooks,
                        can_view_import, can_add_import, can_view_archive_tool, can_add_archive_tool, can_view_export, can_view_db_management, can_edit_db_management, can_view_activity_logs,
                        created_at 
                 FROM users ORDER BY id ASC`,
                [],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    },

    getById: (id) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    create: (user) => {
        return new Promise((resolve, reject) => {
            const { 
                username, email, password, role, can_add, can_edit, can_delete, can_deliver, 
                can_view_ps_details, can_view_games_details, can_view_external_sales,
                can_view_expenses, can_add_expenses, can_edit_expenses, can_delete_expenses,
                can_add_external_sales, can_edit_external_sales, can_delete_external_sales,
                can_view_campaigns, can_add_campaigns, can_edit_campaigns, can_delete_campaigns,
                can_view_certificates, can_add_certificates, can_edit_certificates, can_delete_certificates,
                can_view_ps, can_add_ps, can_edit_ps, can_delete_ps,
                can_view_games, can_add_games, can_edit_games, can_delete_games,
                can_view_salla_orders, can_view_salla_carts, can_view_salla_wallet, can_view_salla_products, can_edit_salla_products, can_view_salla_compare, can_view_salla_webhooks, can_edit_salla_webhooks,
                can_view_import, can_add_import, can_view_archive_tool, can_add_archive_tool, can_view_export, can_view_db_management, can_edit_db_management, can_view_activity_logs,
                created_at 
            } = user;
            db.run(
                `INSERT INTO users 
                 (username, email, password, role, can_add, can_edit, can_delete, can_deliver, 
                  can_view_ps_details, can_view_games_details, can_view_external_sales,
                  can_view_expenses, can_add_expenses, can_edit_expenses, can_delete_expenses,
                  can_add_external_sales, can_edit_external_sales, can_delete_external_sales,
                  can_view_campaigns, can_add_campaigns, can_edit_campaigns, can_delete_campaigns,
                  can_view_certificates, can_add_certificates, can_edit_certificates, can_delete_certificates,
                  can_view_ps, can_add_ps, can_edit_ps, can_delete_ps,
                  can_view_games, can_add_games, can_edit_games, can_delete_games,
                  can_view_salla_orders, can_view_salla_carts, can_view_salla_wallet, can_view_salla_products, can_edit_salla_products, can_view_salla_compare, can_view_salla_webhooks, can_edit_salla_webhooks,
                  can_view_import, can_add_import, can_view_archive_tool, can_add_archive_tool, can_view_export, can_view_db_management, can_edit_db_management, can_view_activity_logs,
                  created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    username.trim(),
                    email.trim().toLowerCase(),
                    password,
                    role || 'employee',
                    can_add !== undefined ? can_add : 1,
                    can_edit !== undefined ? can_edit : 1,
                    can_delete !== undefined ? can_delete : 1,
                    can_deliver !== undefined ? can_deliver : 1,
                    can_view_ps_details !== undefined ? can_view_ps_details : 1,
                    can_view_games_details !== undefined ? can_view_games_details : 1,
                    can_view_external_sales !== undefined ? can_view_external_sales : 1,
                    
                    can_view_expenses !== undefined ? can_view_expenses : 1,
                    can_add_expenses !== undefined ? can_add_expenses : 1,
                    can_edit_expenses !== undefined ? can_edit_expenses : 1,
                    can_delete_expenses !== undefined ? can_delete_expenses : 1,
                    
                    can_add_external_sales !== undefined ? can_add_external_sales : 1,
                    can_edit_external_sales !== undefined ? can_edit_external_sales : 1,
                    can_delete_external_sales !== undefined ? can_delete_external_sales : 1,
                    
                    can_view_campaigns !== undefined ? can_view_campaigns : 1,
                    can_add_campaigns !== undefined ? can_add_campaigns : 1,
                    can_edit_campaigns !== undefined ? can_edit_campaigns : 1,
                    can_delete_campaigns !== undefined ? can_delete_campaigns : 1,
                    
                    can_view_certificates !== undefined ? can_view_certificates : 1,
                    can_add_certificates !== undefined ? can_add_certificates : 1,
                    can_edit_certificates !== undefined ? can_edit_certificates : 1,
                    can_delete_certificates !== undefined ? can_delete_certificates : 1,
                    
                    can_view_ps !== undefined ? can_view_ps : 1,
                    can_add_ps !== undefined ? can_add_ps : 1,
                    can_edit_ps !== undefined ? can_edit_ps : 1,
                    can_delete_ps !== undefined ? can_delete_ps : 1,
                    
                    can_view_games !== undefined ? can_view_games : 1,
                    can_add_games !== undefined ? can_add_games : 1,
                    can_edit_games !== undefined ? can_edit_games : 1,
                    can_delete_games !== undefined ? can_delete_games : 1,
                    
                    can_view_salla_orders !== undefined ? can_view_salla_orders : 1,
                    can_view_salla_carts !== undefined ? can_view_salla_carts : 1,
                    can_view_salla_wallet !== undefined ? can_view_salla_wallet : 1,
                    can_view_salla_products !== undefined ? can_view_salla_products : 1,
                    can_edit_salla_products !== undefined ? can_edit_salla_products : 1,
                    can_view_salla_compare !== undefined ? can_view_salla_compare : 1,
                    can_view_salla_webhooks !== undefined ? can_view_salla_webhooks : 1,
                    can_edit_salla_webhooks !== undefined ? can_edit_salla_webhooks : 1,
                    
                    can_view_import !== undefined ? can_view_import : 1,
                    can_add_import !== undefined ? can_add_import : 1,
                    can_view_archive_tool !== undefined ? can_view_archive_tool : 1,
                    can_add_archive_tool !== undefined ? can_add_archive_tool : 1,
                    can_view_export !== undefined ? can_view_export : 1,
                    can_view_db_management !== undefined ? can_view_db_management : 1,
                    can_edit_db_management !== undefined ? can_edit_db_management : 1,
                    can_view_activity_logs !== undefined ? can_view_activity_logs : 1,
                    
                    created_at
                ],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },

    update: (id, user) => {
        return new Promise((resolve, reject) => {
            const { 
                email, role, can_add, can_edit, can_delete, can_deliver, can_view_ps_details, can_view_games_details, can_view_external_sales,
                can_view_expenses, can_add_expenses, can_edit_expenses, can_delete_expenses,
                can_add_external_sales, can_edit_external_sales, can_delete_external_sales,
                can_view_campaigns, can_add_campaigns, can_edit_campaigns, can_delete_campaigns,
                can_view_certificates, can_add_certificates, can_edit_certificates, can_delete_certificates,
                can_view_ps, can_add_ps, can_edit_ps, can_delete_ps,
                can_view_games, can_add_games, can_edit_games, can_delete_games,
                can_view_salla_orders, can_view_salla_carts, can_view_salla_wallet, can_view_salla_products, can_edit_salla_products, can_view_salla_compare, can_view_salla_webhooks, can_edit_salla_webhooks,
                can_view_import, can_add_import, can_view_archive_tool, can_add_archive_tool, can_view_export, can_view_db_management, can_edit_db_management, can_view_activity_logs
            } = user;
            db.run(
                `UPDATE users SET 
                    email = ?, role = ?, can_add = ?, can_edit = ?, can_delete = ?, can_deliver = ?, 
                    can_view_ps_details = ?, can_view_games_details = ?, can_view_external_sales = ?,
                    can_view_expenses = ?, can_add_expenses = ?, can_edit_expenses = ?, can_delete_expenses = ?,
                    can_add_external_sales = ?, can_edit_external_sales = ?, can_delete_external_sales = ?,
                    can_view_campaigns = ?, can_add_campaigns = ?, can_edit_campaigns = ?, can_delete_campaigns = ?,
                    can_view_certificates = ?, can_add_certificates = ?, can_edit_certificates = ?, can_delete_certificates = ?,
                    can_view_ps = ?, can_add_ps = ?, can_edit_ps = ?, can_delete_ps = ?,
                    can_view_games = ?, can_add_games = ?, can_edit_games = ?, can_delete_games = ?,
                    can_view_salla_orders = ?, can_view_salla_carts = ?, can_view_salla_wallet = ?, can_view_salla_products = ?, can_edit_salla_products = ?, can_view_salla_compare = ?, can_view_salla_webhooks = ?, can_edit_salla_webhooks = ?,
                    can_view_import = ?, can_add_import = ?, can_view_archive_tool = ?, can_add_archive_tool = ?, can_view_export = ?, can_view_db_management = ?, can_edit_db_management = ?, can_view_activity_logs = ?
                 WHERE id = ?`,
                [
                    email.trim().toLowerCase(),
                    role,
                    can_add,
                    can_edit,
                    can_delete,
                    can_deliver,
                    can_view_ps_details,
                    can_view_games_details,
                    can_view_external_sales,
                    
                    can_view_expenses,
                    can_add_expenses,
                    can_edit_expenses,
                    can_delete_expenses,
                    
                    can_add_external_sales,
                    can_edit_external_sales,
                    can_delete_external_sales,
                    
                    can_view_campaigns,
                    can_add_campaigns,
                    can_edit_campaigns,
                    can_delete_campaigns,
                    
                    can_view_certificates,
                    can_add_certificates,
                    can_edit_certificates,
                    can_delete_certificates,
                    
                    can_view_ps,
                    can_add_ps,
                    can_edit_ps,
                    can_delete_ps,
                    
                    can_view_games,
                    can_add_games,
                    can_edit_games,
                    can_delete_games,
                    
                    can_view_salla_orders,
                    can_view_salla_carts,
                    can_view_salla_wallet,
                    can_view_salla_products,
                    can_edit_salla_products,
                    can_view_salla_compare,
                    can_view_salla_webhooks,
                    can_edit_salla_webhooks,
                    
                    can_view_import,
                    can_add_import,
                    can_view_archive_tool,
                    can_add_archive_tool,
                    can_view_export,
                    can_view_db_management,
                    can_edit_db_management,
                    can_view_activity_logs,
                    
                    id
                ],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    },

    updatePassword: (id, hashedPassword) => {
        return new Promise((resolve, reject) => {
            db.run("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, id], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    },

    delete: (id) => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM users WHERE id = ?", [id], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }
};

module.exports = UserRepository;
