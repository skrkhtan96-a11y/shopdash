const db = require('../config/db');

const ConfigRepository = {
    getConfig: (key) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT value FROM salla_config WHERE key = ?", [key], (err, row) => {
                if (err) reject(err);
                else resolve(row ? JSON.parse(row.value) : null);
            });
        });
    },

    setConfig: (key, val) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO salla_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
                [key, JSON.stringify(val), JSON.stringify(val)],
                (err) => {
                    if (err) reject(err);
                    else resolve(true);
                }
            );
        });
    },

    deleteConfig: (key) => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM salla_config WHERE key = ?", [key], (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    },

    logActivity: (username, action_type, section, details) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO activity_logs (username, action_type, section, details) VALUES (?, ?, ?, ?)",
                [username || 'System', action_type, section, details],
                (err) => {
                    if (err) reject(err);
                    else resolve(true);
                }
            );
        });
    }
};

module.exports = ConfigRepository;
