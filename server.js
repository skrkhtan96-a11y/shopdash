require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./database').db; // Re-use the existing SQLite database instance singleton

// Middlewares
const { 
    authenticateUser, 
    authenticateMcp, 
    generalLimiter,
    sessionStaticCheckMiddleware,
    apiProtectionMiddleware
} = require('./src/middlewares/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable trust proxy for rate limiting behind reverse proxy (Nginx)
app.set('trust proxy', 1);

// Security Headers
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP to avoid blocking dashboard inline scripts/styles
    crossOriginEmbedderPolicy: false
}));

// Body Parsers & Cookie Parser
app.use(express.json({ 
    limit: '50mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// CORS Setup
const corsOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',') 
    : ['http://localhost:3000', 'https://shop.nuzum.sbs'];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (corsOrigins.includes(origin) || corsOrigins.includes('*')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

// Apply general rate limiter to all API endpoints
app.use('/api', generalLimiter);

// Protect static HTML pages (excluding login.html)
app.use(sessionStaticCheckMiddleware);

// Protect all API routes starting with /api (excluding /api/auth/, /api/ai/, and /api/mcp)
app.use('/api', apiProtectionMiddleware);

// --- IMPORT ROUTERS ---
const authRouter = require('./src/routes/auth.routes');
const userRouter = require('./src/routes/user.routes');
const expenseRouter = require('./src/routes/expense.routes');
const sallaRouter = require('./src/routes/salla.routes');
const adsRouter = require('./src/routes/ads.routes');
const deliveryRouter = require('./src/routes/delivery.routes');
const inventoryRouter = require('./src/routes/inventory.routes');
const systemRouter = require('./src/routes/system.routes');
const aiRouter = require('./src/routes/ai.routes');
const uploadRouter = require('./src/routes/upload.routes');

// --- MOUNT APIS & PAGES ---

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Core routers
app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/expenses', expenseRouter);
app.use('/api/salla', sallaRouter.router);
app.use('/api/ads', adsRouter.router);
app.use('/api', deliveryRouter);
app.use('/api', inventoryRouter);
app.use('/api', systemRouter);
app.use('/api/ai', aiRouter.router);
app.use('/api/upload', uploadRouter);

// Map Salla OAuth entry/callback endpoints (backward compatible with VPS config)
app.get('/auth', (req, res) => res.redirect('/api/salla/auth-redirect'));
app.get('/callback', (req, res) => {
    const query = new URLSearchParams(req.query).toString();
    res.redirect(`/api/salla/callback-handler?${query}`);
});

// Map TikTok OAuth Callback endpoint (backward compatible)
app.get('/api/auth/tiktok/callback', adsRouter.handleTikTokCallback);
app.get('/nuzum', adsRouter.handleTikTokCallback);

// Map MCP SSE & RPC endpoints directly (backward compatible)
app.get('/mcp', authenticateMcp, aiRouter.handleMcpStream);
app.post(['/api/mcp', '/mcp'], authenticateMcp, express.json(), aiRouter.handleMcpMessage);

// Test route for centralized error handling verification (only active during testing/development)
if (process.env.NODE_ENV !== 'production') {
    app.get('/api/auth/test-error', (req, res, next) => {
        const error = new Error('Test internal database connection error');
        error.status = 500;
        next(error);
    });
}

// Centralized Error Handling Middleware (L-3)
app.use((err, req, res, next) => {
    console.error('[Central Error Handler]', err.stack || err);
    
    const status = err.status || 500;
    const isProd = process.env.NODE_ENV === 'production';
    
    res.status(status).json({
        error: isProd ? 'حدث خطأ داخلي في الخادم.' : (err.message || 'Unknown error'),
        ...(isProd ? {} : { stack: err.stack })
    });
});

// Auto-Sync Salla Orders Background Jobs
const { syncSallaOrdersToLocal } = sallaRouter;
// Run auto-sync every 5 hours
setInterval(syncSallaOrdersToLocal, 5 * 60 * 60 * 1000);
// Run initial sync after 10 seconds of server startup
setTimeout(syncSallaOrdersToLocal, 10000);

// Periodically clean up expired sessions from the database
function cleanExpiredSessions() {
    db.run("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')", [], function(err) {
        if (err) {
            console.error('[Session Clean] خطأ أثناء حذف الجلسات المنتهية:', err.message);
        } else if (this.changes > 0) {
            console.log(`[Session Clean] تم حذف ${this.changes} جلسة منتهية الصلاحية بنجاح.`);
        }
    });
}

// Start Server
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`=================================================`);
        console.log(`🚀 خادم محاسبة سلة يعمل بنجاح (معمارية Clean Architecture)`);
        console.log(`🔗 الرابط المحلي: http://localhost:${PORT}`);
        console.log(`=================================================`);
        
        // Clean expired sessions on startup and every 6 hours
        cleanExpiredSessions();
        setInterval(cleanExpiredSessions, 6 * 60 * 60 * 1000);
    });
}

module.exports = app;
