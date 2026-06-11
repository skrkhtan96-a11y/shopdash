const express = require('express');
const router = express.Router();
const UserRepository = require('../repositories/user.repository');
const { hashPassword } = require('../utils/crypto');
const { authenticateUser, requireRole } = require('../middlewares/auth');
const ConfigRepository = require('../repositories/config.repository');
const db = require('../config/db');

// Get all users
router.get('/', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    try {
        const users = await UserRepository.getAll();
        res.json(users);
    } catch (err) {
        next(err);
    }
});

// Create a new user
router.post('/', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    const { username, email, password, role, can_add, can_edit, can_delete, can_deliver, can_view_ps_details, can_view_games_details, can_view_external_sales } = req.body;
    if (!username || !email || !password || !role) {
        return res.status(400).json({ error: 'يرجى تقديم كافة حقول البيانات للمستخدم الجديد.' });
    }

    try {
        const hashedPassword = hashPassword(password);
        const createdAt = new Date().toISOString().split('T')[0];

        const userId = await UserRepository.create({
            username,
            email,
            password: hashedPassword,
            role,
            can_add,
            can_edit,
            can_delete,
            can_deliver,
            can_view_ps_details,
            can_view_games_details,
            can_view_external_sales,
            created_at: createdAt
        });

        await ConfigRepository.logActivity(
            req.user.username,
            'ADD',
            'users',
            `تم إضافة مستخدم جديد: ${username} برتبة ${role}`
        );

        res.json({ success: true, id: userId });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'اسم المستخدم أو البريد الإلكتروني مسجل مسبقاً.' });
        }
        next(err);
    }
});

// Update a user (handles both password and profile updates)
router.put('/:id', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    const { id } = req.params;
    const { role, username, email, password, can_add, can_edit, can_delete, can_deliver, can_view_ps_details, can_view_games_details, can_view_external_sales } = req.body;
    
    if (!role) {
        return res.status(400).json({ error: 'يرجى تحديد دور المستخدم.' });
    }
    
    const cAdd = can_add !== undefined ? (can_add ? 1 : 0) : 1;
    const cEdit = can_edit !== undefined ? (can_edit ? 1 : 0) : 1;
    const cDelete = can_delete !== undefined ? (can_delete ? 1 : 0) : 1;
    const cDeliver = can_deliver !== undefined ? (can_deliver ? 1 : 0) : 1;
    const cViewPsDetails = can_view_ps_details !== undefined ? (can_view_ps_details ? 1 : 0) : 1;
    const cViewGamesDetails = can_view_games_details !== undefined ? (can_view_games_details ? 1 : 0) : 1;
    const cViewExternalSales = can_view_external_sales !== undefined ? (can_view_external_sales ? 1 : 0) : 1;

    try {
        if (password) {
            const hashedPassword = hashPassword(password);
            db.run(
                `UPDATE users SET role = ?, username = ?, email = ?, password = ?, can_add = ?, can_edit = ?, can_delete = ?, can_deliver = ?, can_view_ps_details = ?, can_view_games_details = ?, can_view_external_sales = ? WHERE id = ?`,
                [role, username.trim(), email.trim().toLowerCase(), hashedPassword, cAdd, cEdit, cDelete, cDeliver, cViewPsDetails, cViewGamesDetails, cViewExternalSales, id],
                async function(err) {
                    if (err) return next(err);
                    await ConfigRepository.logActivity(req.user.username, 'UPDATE', 'users', `تم تحديث بيانات المستخدم: ${username} برتبة ${role}`);
                    res.json({ success: true });
                }
            );
        } else {
            db.run(
                `UPDATE users SET role = ?, username = ?, email = ?, can_add = ?, can_edit = ?, can_delete = ?, can_deliver = ?, can_view_ps_details = ?, can_view_games_details = ?, can_view_external_sales = ? WHERE id = ?`,
                [role, username.trim(), email.trim().toLowerCase(), cAdd, cEdit, cDelete, cDeliver, cViewPsDetails, cViewGamesDetails, cViewExternalSales, id],
                async function(err) {
                    if (err) return next(err);
                    await ConfigRepository.logActivity(req.user.username, 'UPDATE', 'users', `تم تحديث بيانات المستخدم: ${username} برتبة ${role}`);
                    res.json({ success: true });
                }
            );
        }
    } catch (err) {
        next(err);
    }
});

// Delete a user
router.delete('/:id', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
        return res.status(400).json({ error: 'لا يمكنك حذف حسابك الشخصي النشط حالياً.' });
    }

    try {
        const targetUser = await UserRepository.getById(id);
        if (!targetUser) {
            return res.status(404).json({ error: 'المستخدم غير موجود.' });
        }

        await UserRepository.delete(id);

        await ConfigRepository.logActivity(
            req.user.username,
            'DELETE',
            'users',
            `تم حذف المستخدم: ${targetUser.username} (معرف: ${id})`
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
