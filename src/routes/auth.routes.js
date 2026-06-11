const express = require('express');
const router = express.Router();
const UserRepository = require('../repositories/user.repository');
const { hashPassword, verifyPassword } = require('../utils/crypto');
const { authenticateUser, requireRole, loginLimiter } = require('../middlewares/auth');
const crypto = require('crypto');

// 1. User login
router.post('/login', loginLimiter, async (req, res, next) => {
    const { login, password } = req.body;
    if (!login || !password) {
        return res.status(400).json({ error: 'يرجى تقديم اسم المستخدم أو البريد الإلكتروني وكلمة المرور.' });
    }

    try {
        const user = await UserRepository.findByLogin(login);
        if (!user) {
            return res.status(400).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
        }

        const isMatch = verifyPassword(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        await UserRepository.createSession(sessionToken, user.id, expiresAt);

        res.cookie('session_token', sessionToken, {
            httpOnly: true,
            expires: new Date(expiresAt),
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax'
        });

        res.json({
            success: true,
            user: { id: user.id, username: user.username, email: user.email, role: user.role }
        });
    } catch (err) {
        next(err);
    }
});

// 2. User logout
router.post('/logout', async (req, res, next) => {
    const token = req.cookies.session_token;
    if (token) {
        try {
            await UserRepository.deleteSession(token);
            res.clearCookie('session_token');
            res.json({ success: true });
        } catch (err) {
            next(err);
        }
    } else {
        res.json({ success: true });
    }
});

// 3. Get current user profile
router.get('/me', authenticateUser, (req, res) => {
    res.json(req.user);
});

// 4. Test error route for verify test suites
router.get('/test-error', (req, res, next) => {
    next(new Error('Test internal database connection error'));
});

module.exports = router;
