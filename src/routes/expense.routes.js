const express = require('express');
const router = express.Router();
const ExpenseRepository = require('../repositories/expense.repository');
const ConfigRepository = require('../repositories/config.repository');
const { authenticateUser, requireRole } = require('../middlewares/auth');

// Get all expenses
router.get('/', authenticateUser, async (req, res, next) => {
    const cat = req.query.cat || '';
    const period = req.query.period || '';
    const descs = req.query.descs || '';
    const q = req.query.q || '';
    const sort = req.query.sort || 'desc';
    const from = req.query.from || '';
    const to = req.query.to || '';

    try {
        const rows = await ExpenseRepository.getAll(cat, period, descs, q, sort, from, to);
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// Add a new expense
router.post('/', authenticateUser, async (req, res, next) => {
    const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period, receipt_url } = req.body;
    if (!desc || !cat || isNaN(amt) || !date) {
        return res.status(400).json({ error: 'يرجى تقديم كافة البيانات المطلوبة بشكل صحيح.' });
    }

    try {
        const insertId = await ExpenseRepository.add({
            desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period, receipt_url
        });

        await ConfigRepository.logActivity(
            req.user.username,
            'ADD',
            'expenses',
            `تم إضافة مصروف جديد: ${desc} بقيمة ${amt} ر.س`
        );

        res.json({ success: true, id: insertId });
    } catch (err) {
        next(err);
    }
});

// Update an expense
router.put('/:id', authenticateUser, async (req, res, next) => {
    const { id } = req.params;
    const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period, receipt_url } = req.body;

    try {
        await ExpenseRepository.update(id, {
            desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period, receipt_url
        });

        await ConfigRepository.logActivity(
            req.user.username,
            'UPDATE',
            'expenses',
            `تم تعديل المصروف: ${desc} بقيمة ${amt} ر.س`
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// Delete an expense
router.delete('/:id', authenticateUser, async (req, res, next) => {
    const { id } = req.params;

    try {
        const expense = await ExpenseRepository.getById(id);
        const desc = expense ? expense.desc : 'غير معروف';
        const amt = expense ? expense.amt : 0;

        await ExpenseRepository.delete(id);

        await ConfigRepository.logActivity(
            req.user.username,
            'DELETE',
            'expenses',
            `تم حذف المصروف: ${desc} بقيمة ${amt} ر.س`
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// Clear and zero out all expenses
router.post('/clear', authenticateUser, requireRole(['admin']), async (req, res, next) => {
    try {
        await ExpenseRepository.clearAll();

        await ConfigRepository.logActivity(
            req.user.username,
            'CLEAR',
            'expenses',
            `تم حذف وتصفير جميع المصروفات`
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
