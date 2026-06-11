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
                        can_view_ps_details, can_view_games_details, can_view_external_sales, created_at 
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
            const { username, email, password, role, can_add, can_edit, can_delete, can_deliver, can_view_ps_details, can_view_games_details, can_view_external_sales, created_at } = user;
            db.run(
                `INSERT INTO users 
                 (username, email, password, role, can_add, can_edit, can_delete, can_deliver, can_view_ps_details, can_view_games_details, can_view_external_sales, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            const { email, role, can_add, can_edit, can_delete, can_deliver, can_view_ps_details, can_view_games_details, can_view_external_sales } = user;
            db.run(
                `UPDATE users SET 
                    email = ?, role = ?, can_add = ?, can_edit = ?, can_delete = ?, can_deliver = ?, 
                    can_view_ps_details = ?, can_view_games_details = ?, can_view_external_sales = ? 
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
