const express = require('express');
const router = express.Router();
const db = require('../config/db');
const ConfigRepository = require('../repositories/config.repository');
const { authenticateUser, requireRole } = require('../middlewares/auth');

// --- PLAYSTATION PLUS ACCOUNTS ---

// Get all PlayStation Plus accounts
router.get('/ps-plus/accounts', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_ps) {
        return res.status(403).json({ error: 'ليس لديك صلاحية استعراض مخزون بلس.' });
    }
    db.all("SELECT * FROM ps_plus_accounts ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a new PlayStation Plus account
router.post('/ps-plus/accounts', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_add_ps) {
        return res.status(403).json({ error: 'ليس لديك صلاحية إضافة حسابات بلس.' });
    }
    const { email, password, plus_type, plus_duration, ps5_1_code, ps5_2_code, ps4_code, ps5_1_status, ps5_2_status, ps4_status } = req.body;
    if (!email || !password || !plus_type || !plus_duration) {
        return res.status(400).json({ error: 'جميع الحقول (الإيميل، الباسورد، نوع البلس، مدة الاشتراك) مطلوبة.' });
    }

    const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.run(
        "INSERT INTO ps_plus_accounts (email, password, plus_type, plus_duration, ps5_1_code, ps5_2_code, ps4_code, ps5_1_status, ps5_2_status, ps4_status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            email.trim(), 
            password.trim(), 
            plus_type.trim(), 
            plus_duration.trim(), 
            ps5_1_code ? ps5_1_code.trim() : '', 
            ps5_2_code ? ps5_2_code.trim() : '', 
            ps4_code ? ps4_code.trim() : '', 
            ps5_1_status || 'available',
            ps5_2_status || 'available',
            ps4_status || 'available',
            req.user.username, 
            createdAt
        ],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'هذا الإيميل مسجل بالفعل في حسابات بلس.' });
                }
                return res.status(500).json({ error: err.message });
            }
            ConfigRepository.logActivity(req.user.username, 'ADD', 'ps_plus', `تم إضافة حساب بلس جديد: ${email} (بلس ${plus_type} ${plus_duration})`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Update a PlayStation Plus account
router.put('/ps-plus/accounts/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_ps) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل حسابات بلس.' });
    }
    const { id } = req.params;
    const { email, password, plus_type, plus_duration, ps5_1_order, ps5_2_order, ps4_order, ps5_1_code, ps5_2_code, ps4_code, ps5_1_status, ps5_2_status, ps4_status } = req.body;
    if (!email || !password || !plus_type || !plus_duration) {
        return res.status(400).json({ error: 'جميع الحقول مطلوبة لتحديث البيانات.' });
    }

    const o51 = ps5_1_order ? ps5_1_order.trim() : '';
    const o52 = ps5_2_order ? ps5_2_order.trim() : '';
    const o4 = ps4_order ? ps4_order.trim() : '';

    const s51 = o51 ? 'delivered' : (ps5_1_status || 'available');
    const s52 = o52 ? 'delivered' : (ps5_2_status || 'available');
    const s4 = o4 ? 'delivered' : (ps4_status || 'available');

    db.get("SELECT ps5_1_status, ps5_2_status, ps4_status, ps5_1_delivered_at, ps5_2_delivered_at, ps4_delivered_at FROM ps_plus_accounts WHERE id = ?", [id], (errGet, oldRow) => {
        if (errGet || !oldRow) return res.status(500).json({ error: errGet ? errGet.message : 'الحساب غير موجود' });

        const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

        let d51_at = oldRow.ps5_1_delivered_at;
        if (s51 === 'delivered' && oldRow.ps5_1_status !== 'delivered') {
            d51_at = nowStr;
        } else if (s51 !== 'delivered') {
            d51_at = null;
        }

        let d52_at = oldRow.ps5_2_delivered_at;
        if (s52 === 'delivered' && oldRow.ps5_2_status !== 'delivered') {
            d52_at = nowStr;
        } else if (s52 !== 'delivered') {
            d52_at = null;
        }

        let d4_at = oldRow.ps4_delivered_at;
        if (s4 === 'delivered' && oldRow.ps4_status !== 'delivered') {
            d4_at = nowStr;
        } else if (s4 !== 'delivered') {
            d4_at = null;
        }

        db.run(
            `UPDATE ps_plus_accounts SET 
                email = ?, 
                password = ?, 
                plus_type = ?, 
                plus_duration = ?, 
                ps5_1_order = ?, 
                ps5_1_status = ?, 
                ps5_2_order = ?, 
                ps5_2_status = ?, 
                ps4_order = ?, 
                ps4_status = ?,
                ps5_1_code = ?,
                ps5_2_code = ?,
                ps4_code = ?,
                ps5_1_delivered_at = ?,
                ps5_2_delivered_at = ?,
                ps4_delivered_at = ?
             WHERE id = ?`,
            [
                email.trim(), 
                password.trim(), 
                plus_type.trim(), 
                plus_duration.trim(), 
                o51, 
                s51, 
                o52, 
                s52, 
                o4, 
                s4, 
                ps5_1_code ? ps5_1_code.trim() : '',
                ps5_2_code ? ps5_2_code.trim() : '',
                ps4_code ? ps4_code.trim() : '',
                d51_at,
                d52_at,
                d4_at,
                id
            ],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                ConfigRepository.logActivity(req.user.username, 'UPDATE', 'ps_plus', `تم تحديث بيانات حساب بلس: ${email} (بلس ${plus_type} ${plus_duration})`).catch(console.error);
                res.json({ success: true });
            }
        );
    });
});

// Delete a PlayStation Plus account
router.delete('/ps-plus/accounts/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_delete_ps) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف حسابات بلس.' });
    }
    const { id } = req.params;
    db.get("SELECT email, plus_type, plus_duration FROM ps_plus_accounts WHERE id = ?", [id], (errFetch, row) => {
        const email = row ? row.email : 'غير معروف';
        const type = row ? row.plus_type : '';
        const duration = row ? row.plus_duration : '';
        db.run("DELETE FROM ps_plus_accounts WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            ConfigRepository.logActivity(req.user.username, 'DELETE', 'ps_plus', `تم حذف حساب بلس: ${email} (بلس ${type} ${duration})`).catch(console.error);
            res.json({ success: true });
        });
    });
});

// Toggle archive status of a PlayStation Plus account
router.put('/ps-plus/accounts/:id/archive', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_ps) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل حسابات بلس.' });
    }
    const { id } = req.params;
    const { is_archived } = req.body;
    
    db.run(
        "UPDATE ps_plus_accounts SET is_archived = ? WHERE id = ?",
        [is_archived ? 1 : 0, id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            db.get("SELECT email FROM ps_plus_accounts WHERE id = ?", [id], (errGet, row) => {
                const email = row ? row.email : 'غير معروف';
                const actionText = is_archived ? 'أرشفة' : 'إلغاء أرشفة';
                ConfigRepository.logActivity(req.user.username, 'UPDATE', 'ps_plus', `تم ${actionText} حساب بلس: ${email}`).catch(console.error);
            });
            res.json({ success: true, is_archived: is_archived ? 1 : 0 });
        }
    );
});

// Deliver a PlayStation Plus account slot
router.post('/ps-plus/accounts/deliver', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_deliver) {
        return res.status(403).json({ error: 'غير مصرح لك بتسليم الحسابات.' });
    }
    const { id, slot, order_id, phone } = req.body;
    if (!id || !slot || !order_id) {
        return res.status(400).json({ error: 'معرف الحساب، النسخة المراد تسليمها، ورقم الطلب مطلوبة.' });
    }

    if (!['ps5_1', 'ps5_2', 'ps4'].includes(slot)) {
        return res.status(400).json({ error: 'النسخة المحددة غير صالحة.' });
    }

    const orderClean = order_id.trim();

    db.get(
        "SELECT id, email FROM ps_plus_accounts WHERE ps5_1_order = ? OR ps5_2_order = ? OR ps4_order = ?",
        [orderClean],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row) {
                return res.status(400).json({ error: `رقم الطلب هذا تم استخدامه مسبقاً لتسليم الحساب (${row.email}). لا يمكن تكراره.` });
            }

            const deliveredAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
            let query = '';
            if (slot === 'ps5_1') {
                query = "UPDATE ps_plus_accounts SET ps5_1_order = ?, ps5_1_phone = ?, ps5_1_status = 'delivered', ps5_1_delivered_by = ?, ps5_1_delivered_at = ? WHERE id = ?";
            } else if (slot === 'ps5_2') {
                query = "UPDATE ps_plus_accounts SET ps5_2_order = ?, ps5_2_phone = ?, ps5_2_status = 'delivered', ps5_2_delivered_by = ?, ps5_2_delivered_at = ? WHERE id = ?";
            } else if (slot === 'ps4') {
                query = "UPDATE ps_plus_accounts SET ps4_order = ?, ps4_phone = ?, ps4_status = 'delivered', ps4_delivered_by = ?, ps4_delivered_at = ? WHERE id = ?";
            }
            db.run(query, [orderClean, phone ? phone.trim() : '', req.user.username, deliveredAt, id], function(errUpdate) {
                if (errUpdate) return res.status(500).json({ error: errUpdate.message });
                db.get("SELECT email, plus_type, plus_duration FROM ps_plus_accounts WHERE id = ?", [id], (errGet, accountRow) => {
                    const email = accountRow ? accountRow.email : 'غير معروف';
                    const type = accountRow ? accountRow.plus_type : '';
                    const duration = accountRow ? accountRow.plus_duration : '';
                    const slotName = slot === 'ps4' ? 'PS4' : 'PS5';
                    ConfigRepository.logActivity(req.user.username, 'DELIVER', 'ps_plus', `تم تسليم نسخة ${slotName} من حساب بلس ${type} (${duration}) ${email} للطلب رقم: ${orderClean}`).catch(console.error);
                });
                res.json({ success: true });
            });
        }
    );
});

// Bulk Import PlayStation Plus accounts
router.post('/ps-plus/accounts/bulk', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_add_ps) {
        return res.status(403).json({ error: 'ليس لديك صلاحية استيراد حسابات بلس.' });
    }
    const accounts = req.body;
    if (!Array.isArray(accounts) || accounts.length === 0) {
        return res.status(400).json({ error: 'الرجاء إرسال مصفوفة صالحة تحتوي على الحسابات.' });
    }

    const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        let errorOccurred = false;
        let count = 0;
        
        const stmt = db.prepare(
            `INSERT INTO ps_plus_accounts (email, password, plus_type, plus_duration, created_by, created_at) 
             VALUES (?, ?, ?, ?, ?, ?) 
             ON CONFLICT(email) DO UPDATE SET 
                password = excluded.password, 
                plus_type = excluded.plus_type, 
                plus_duration = excluded.plus_duration`
        );
        
        for (const account of accounts) {
            const { email, password, plus_type, plus_duration } = account;
            if (!email || !password || !plus_type || !plus_duration) continue;
            
            stmt.run([email.trim(), password.trim(), plus_type.trim(), plus_duration.trim(), req.user.username, createdAt], function(err) {
                if (err) {
                    errorOccurred = err.message;
                } else {
                    count++;
                }
            });
        }
        
        stmt.finalize(() => {
            if (errorOccurred) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: errorOccurred });
            }
            db.run("COMMIT");
            ConfigRepository.logActivity(req.user.username, 'IMPORT', 'ps_plus', `تم استيراد/تحديث ${count} حساب بلس من ملف Excel`).catch(console.error);
            res.json({ success: true, count });
        });
    });
});

// --- GAMES ACCOUNTS & SLOTS ---

// Get all games accounts
router.get('/games/accounts', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_games) {
        return res.status(403).json({ error: 'ليس لديك صلاحية استعراض مخزون الألعاب.' });
    }
    const sql = `
        SELECT ga.*, gs.id as slot_id, gs.slot_type, gs.slot_index, gs.status, gs.code, gs.order_number, gs.phone, gs.delivered_by, gs.delivered_at
        FROM game_accounts ga
        LEFT JOIN game_slots gs ON ga.id = gs.account_id
        ORDER BY ga.created_at DESC, gs.slot_type DESC, gs.slot_index ASC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const accountsMap = {};
        rows.forEach(row => {
            if (!row.id) return;
            if (!accountsMap[row.id]) {
                accountsMap[row.id] = {
                    id: row.id,
                    email: row.email,
                    password: row.password,
                    game_name: row.game_name,
                    created_by: row.created_by,
                    created_at: row.created_at,
                    slots: []
                };
            }
            if (row.slot_id) {
                accountsMap[row.id].slots.push({
                    id: row.slot_id,
                    slot_type: row.slot_type,
                    slot_index: row.slot_index,
                    status: row.status,
                    code: row.code,
                    order_number: row.order_number,
                    phone: row.phone,
                    delivered_by: row.delivered_by,
                    delivered_at: row.delivered_at
                });
            }
        });
        res.json(Object.values(accountsMap));
    });
});

// Add a new game account
router.post('/games/accounts', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_add_games) {
        return res.status(403).json({ error: 'ليس لديك صلاحية إضافة حسابات ألعاب.' });
    }
    const { email, password, game_name, slots } = req.body;
    if (!email || !password || !game_name || !Array.isArray(slots)) {
        return res.status(400).json({ error: 'جميع الحقول مطلوبة.' });
    }
    const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(
            "INSERT INTO game_accounts (email, password, game_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
            [email.trim(), password.trim(), game_name.trim(), req.user.username, createdAt],
            function(err) {
                if (err) {
                    db.run("ROLLBACK");
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'هذا الإيميل مسجل بالفعل في حسابات الألعاب.' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                const accountId = this.lastID;
                let errorOccurred = false;

                const stmt = db.prepare("INSERT INTO game_slots (account_id, slot_type, slot_index, code, status) VALUES (?, ?, ?, ?, 'available')");
                slots.forEach(s => {
                    stmt.run([accountId, s.slot_type, s.slot_index, s.code ? s.code.trim() : ''], (errRun) => {
                        if (errRun) errorOccurred = errRun.message;
                    });
                });

                stmt.finalize((errFinal) => {
                    if (errorOccurred || errFinal) {
                        db.run("ROLLBACK");
                        return res.status(500).json({ error: errorOccurred || errFinal.message });
                    }
                    db.run("COMMIT");
                    ConfigRepository.logActivity(req.user.username, 'ADD', 'games', `تم إضافة لعبة جديدة: ${game_name} (${email})`).catch(console.error);
                    res.json({ success: true, id: accountId });
                });
            }
        );
    });
});

// Update a game account
router.put('/games/accounts/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_games) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل حسابات ألعاب.' });
    }
    const { id } = req.params;
    const { email, password, game_name, slots } = req.body;
    if (!email || !password || !game_name || !Array.isArray(slots)) {
        return res.status(400).json({ error: 'جميع الحقول مطلوبة لتحديث البيانات.' });
    }

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(
            "UPDATE game_accounts SET email = ?, password = ?, game_name = ? WHERE id = ?",
            [email.trim(), password.trim(), game_name.trim(), id],
            function(err) {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: err.message });
                }

                db.all("SELECT id FROM game_slots WHERE account_id = ?", [id], (errSlots, oldSlots) => {
                    if (errSlots) {
                        db.run("ROLLBACK");
                        return res.status(500).json({ error: errSlots.message });
                    }

                    const oldSlotIds = oldSlots.map(s => s.id);
                    const newSlotIds = slots.filter(s => s.id).map(s => parseInt(s.id));
                    const idsToDelete = oldSlotIds.filter(oid => !newSlotIds.includes(oid));

                    let errorOccurred = false;

                    if (idsToDelete.length > 0) {
                        const placeholders = idsToDelete.map(() => '?').join(',');
                        db.run(`DELETE FROM game_slots WHERE id IN (${placeholders})`, idsToDelete, (errDel) => {
                            if (errDel) errorOccurred = errDel.message;
                        });
                    }

                    slots.forEach(s => {
                        const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
                        const status = s.order_number ? 'delivered' : (s.status || 'available');
                        const deliveredAt = (status === 'delivered' && !s.delivered_at) ? nowStr : s.delivered_at;

                        if (s.id) {
                            db.run(
                                `UPDATE game_slots SET slot_type = ?, slot_index = ?, code = ?, status = ?, order_number = ?, phone = ?, delivered_by = ?, delivered_at = ? WHERE id = ? AND account_id = ?`,
                                [s.slot_type, s.slot_index, s.code ? s.code.trim() : '', status, s.order_number || null, s.phone || null, s.delivered_by || null, deliveredAt, s.id, id],
                                (errUpd) => {
                                    if (errUpd) errorOccurred = errUpd.message;
                                }
                            );
                        } else {
                            db.run(
                                `INSERT INTO game_slots (account_id, slot_type, slot_index, code, status, order_number, phone, delivered_by, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                [id, s.slot_type, s.slot_index, s.code ? s.code.trim() : '', status, s.order_number || null, s.phone || null, s.delivered_by || null, deliveredAt],
                                (errIns) => {
                                    if (errIns) errorOccurred = errIns.message;
                                }
                            );
                        }
                    });

                    setTimeout(() => {
                        if (errorOccurred) {
                            db.run("ROLLBACK");
                            return res.status(500).json({ error: errorOccurred });
                        }
                        db.run("COMMIT");
                        ConfigRepository.logActivity(req.user.username, 'UPDATE', 'games', `تم تحديث بيانات اللعبة: ${game_name} (${email})`).catch(console.error);
                        res.json({ success: true });
                    }, 200);
                });
            }
        );
    });
});

// Delete a game account
router.delete('/games/accounts/:id', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_delete_games) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف حسابات ألعاب.' });
    }
    const { id } = req.params;
    db.get("SELECT email, game_name FROM game_accounts WHERE id = ?", [id], (errFetch, row) => {
        if (errFetch || !row) return res.status(500).json({ error: errFetch ? errFetch.message : 'الحساب غير موجود' });
        const email = row.email;
        const game_name = row.game_name;
        db.run("DELETE FROM game_accounts WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            ConfigRepository.logActivity(req.user.username, 'DELETE', 'games', `تم حذف حساب لعبة: ${game_name} (${email})`).catch(console.error);
            res.json({ success: true });
        });
    });
});

// Deliver a game account slot
router.post('/games/slots/deliver', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_deliver) {
        return res.status(403).json({ error: 'غير مصرح لك بتسليم الحسابات.' });
    }
    const { slot_id, order_number, phone } = req.body;
    if (!slot_id || !order_number) {
        return res.status(400).json({ error: 'معرف النسخة ورقم الطلب مطلوبان.' });
    }

    const orderClean = order_number.trim();

    db.get(
        "SELECT id FROM game_slots WHERE order_number = ?",
        [orderClean],
        (errUnique, rowUnique) => {
            if (errUnique) return res.status(500).json({ error: errUnique.message });
            if (rowUnique) {
                return res.status(400).json({ error: `رقم الطلب هذا تم استخدامه مسبقاً لتسليم نسخة لعبة أخرى.` });
            }

            const deliveredAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
            db.run(
                `UPDATE game_slots SET order_number = ?, phone = ?, status = 'delivered', delivered_by = ?, delivered_at = ? WHERE id = ?`,
                [orderClean, phone ? phone.trim() : '', req.user.username, deliveredAt, slot_id],
                function(errUpdate) {
                    if (errUpdate) return res.status(500).json({ error: errUpdate.message });
                    
                    db.get(
                        `SELECT ga.email, ga.game_name, gs.slot_type, gs.slot_index 
                         FROM game_slots gs 
                         JOIN game_accounts ga ON gs.account_id = ga.id 
                         WHERE gs.id = ?`,
                        [slot_id],
                        (errGet, infoRow) => {
                            if (infoRow) {
                                ConfigRepository.logActivity(
                                    req.user.username, 
                                    'DELIVER', 
                                    'games', 
                                    `تم تسليم نسخة ${infoRow.slot_type} (${infoRow.slot_index}) للعبة ${infoRow.game_name} (${infoRow.email}) للطلب: ${orderClean}`
                                ).catch(console.error);
                            }
                        }
                    );
                    res.json({ success: true });
                }
            );
        }
    );
});

module.exports = router;
