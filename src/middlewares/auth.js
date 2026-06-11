const db = require('../config/db');
const rateLimit = require('express-rate-limit');

// Rate limiting setup
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'تم تجاوز الحد المسموح به من الطلبات. يرجى المحاولة لاحقاً.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'تم تجاوز الحد المسموح لمحاولات تسجيل الدخول. يرجى المحاولة بعد 15 دقيقة.' }
});

// Middleware to protect API endpoints
const authenticateUser = (req, res, next) => {
    const token = req.cookies.session_token;
    if (!token) {
        return res.status(401).json({ error: 'غير مصرح بالدخول. يرجى تسجيل الدخول.' });
    }
    db.get(
        `SELECT u.id, u.username, u.email, u.role, u.can_add, u.can_edit, u.can_delete, u.can_deliver, u.can_view_ps_details, u.can_view_games_details, u.can_view_external_sales FROM sessions s 
         JOIN users u ON s.user_id = u.id 
         WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')`,
        [token],
        (err, row) => {
            if (err || !row) {
                res.clearCookie('session_token');
                return res.status(401).json({ error: 'انتهت الجلسة. يرجى تسجيل الدخول مجدداً.' });
            }
            req.user = row;
            next();
        }
    );
};

// Middleware to restrict API by role
const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'غير مصرح لك بالوصول لهذه الصلاحية.' });
        }
        next();
    };
};

// Middleware to authenticate Model Context Protocol (MCP) clients
const authenticateMcp = (req, res, next) => {
    const expectedToken = process.env.MCP_TOKEN;
    if (!expectedToken) {
        return next();
    }
    const token = req.query.token || req.headers['x-api-key'] || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);
    if (token !== expectedToken) {
        return res.status(401).json({ error: 'Unauthorized. Invalid MCP token.' });
    }
    next();
};

const sessionStaticCheckMiddleware = (req, res, next) => {
    const publicPages = ['/login.html'];
    const isHtmlOrRoot = req.path === '/' || req.path.endsWith('.html');
    
    if (isHtmlOrRoot && !publicPages.includes(req.path)) {
        const token = req.cookies.session_token;
        if (!token) {
            return res.redirect('/login.html');
        }
        db.get(
            `SELECT u.id, u.username, u.email, u.role, u.can_add, u.can_edit, u.can_delete, u.can_deliver, u.can_view_ps_details, u.can_view_games_details, u.can_view_external_sales FROM sessions s 
             JOIN users u ON s.user_id = u.id 
             WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')`,
            [token],
            (err, row) => {
                if (err || !row) {
                    res.clearCookie('session_token');
                    return res.redirect('/login.html');
                }
                req.user = row;
                next();
            }
        );
    } else {
        next();
    }
};

const apiProtectionMiddleware = (req, res, next) => {
    const url = req.originalUrl || req.path;
    if (
        req.path.startsWith('/auth/') || 
        url.startsWith('/api/auth/') ||
        req.path.startsWith('/ai/') ||
        url.startsWith('/api/ai/') ||
        req.path.startsWith('/mcp') ||
        url.startsWith('/api/mcp') ||
        url.includes('/salla/callback-handler') ||
        url.includes('/salla/auth-redirect') ||
        url.includes('/salla/webhook')
    ) {
        return next();
    }
    authenticateUser(req, res, next);
};

module.exports = {
    generalLimiter,
    loginLimiter,
    authenticateUser,
    requireRole,
    authenticateMcp,
    sessionStaticCheckMiddleware,
    apiProtectionMiddleware
};
