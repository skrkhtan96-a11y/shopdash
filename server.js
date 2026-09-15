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

// Serve Y-Go landing page publicly
app.use('/ygo', express.static(path.join(__dirname, 'ygo')));

// ══════════════════════════════════════════════════════════
// SYSTEM MAINTENANCE GATE — Blocks ALL access when stopped
// Only /system-control panel & its APIs are exempt
// ══════════════════════════════════════════════════════════
let _sysStatusCache = { status: 'online', message: 'عفواً، النظام متوقف حالياً - يجب تجديد الاستضافة', ts: 0 };

function _refreshSysStatus(cb) {
    db.get("SELECT system_status, stopped_message FROM system_control_config WHERE key = 'main'", (err, row) => {
        if (!err && row) {
            _sysStatusCache = { status: row.system_status, message: row.stopped_message || 'عفواً، النظام متوقف حالياً - يجب تجديد الاستضافة', ts: Date.now() };
        }
        if (cb) cb(_sysStatusCache);
    });
}

// Refresh on startup
_refreshSysStatus();

// Expose a method so toggle endpoints can invalidate cache immediately
global.invalidateSysStatusCache = () => { _sysStatusCache.ts = 0; };

app.use((req, res, next) => {
    const url = req.originalUrl || req.path;

    // Always allow system-control panel & its external API endpoints
    const isExempt =
        url === '/system-control' ||
        url.startsWith('/system-control') ||
        url.startsWith('/api/system/control-pin-auth') ||
        url.startsWith('/api/system/control-status-ext') ||
        url.startsWith('/api/system/control-toggle-master-ext') ||
        url.startsWith('/api/system/control-toggle-service-ext') ||
        url.startsWith('/api/system/control-restart-ext') ||
        url.startsWith('/api/system/control-vacuum-ext') ||
        url.startsWith('/ygo');

    if (isExempt) return next();

    // Use cache (refresh every 10 seconds)
    const now = Date.now();
    if (now - _sysStatusCache.ts > 10000) {
        _refreshSysStatus((cache) => {
            if (cache.status === 'stopped') return sendMaintenancePage(req, res, cache.message);
            next();
        });
    } else {
        if (_sysStatusCache.status === 'stopped') return sendMaintenancePage(req, res, _sysStatusCache.message);
        next();
    }
});

function sendMaintenancePage(req, res, message) {
    const accept = req.headers['accept'] || '';
    const isApi = req.originalUrl.startsWith('/api/') || accept.includes('application/json');

    if (isApi) {
        return res.status(503).json({ error: message, system_status: 'stopped' });
    }

    // Full-page maintenance HTML
    res.status(503).send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>النظام متوقف — يجب تجديد الاستضافة</title>
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;900&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:'Tajawal',sans-serif;
      background:#0b0e1a;
      color:#e8eaf6;
      min-height:100vh;
      display:flex;align-items:center;justify-content:center;
      text-align:center;padding:24px;
      background-image:radial-gradient(ellipse at 50% 30%,rgba(224,85,85,0.08) 0%,transparent 70%);
    }
    .wrap{max-width:480px;width:100%}
    .icon{
      width:90px;height:90px;border-radius:50%;
      background:rgba(224,85,85,0.12);
      border:2px solid rgba(224,85,85,0.4);
      display:inline-flex;align-items:center;justify-content:center;
      font-size:40px;margin-bottom:28px;
      box-shadow:0 0 40px rgba(224,85,85,0.2);
      animation:pulse 2.5s ease-in-out infinite;
    }
    @keyframes pulse{0%,100%{box-shadow:0 0 20px rgba(224,85,85,0.15)}50%{box-shadow:0 0 50px rgba(224,85,85,0.35)}}
    h1{font-size:26px;font-weight:900;color:#e05555;margin-bottom:12px}
    .msg{
      background:rgba(224,85,85,0.08);border:1px solid rgba(224,85,85,0.25);
      border-radius:12px;padding:18px 22px;
      font-size:15px;color:#e8eaf6;line-height:1.7;
      margin-bottom:28px;
    }
    .sub{font-size:12px;color:#5a6480;margin-top:8px}
    .badge{
      display:inline-flex;align-items:center;gap:8px;
      background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
      border-radius:8px;padding:10px 18px;font-size:12px;color:#9ea8c8;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="icon">🔴</div>
    <h1>النظام متوقف حالياً</h1>
    <div class="msg">
      ${message || 'عفواً، النظام متوقف حالياً - يجب تجديد الاستضافة'}
      <div class="sub">يرجى التواصل مع المسؤول لإعادة تشغيل النظام</div>
    </div>
    <div class="badge">🔒 لا يمكن الوصول إلى النظام حالياً</div>
  </div>
</body>
</html>`);
}

// Protect static HTML pages (excluding login.html)
app.use(sessionStaticCheckMiddleware);

// --- IMPORT ROUTERS ---
const attributionRouter = require('./src/routes/attribution.routes');

// Protect all API routes starting with /api (excluding /api/auth/, /api/ai/, /api/mcp and /api/attribution)
app.use('/api/attribution', attributionRouter);
app.use('/api', apiProtectionMiddleware);

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
const campaignsRouter = require('./src/routes/campaigns.routes');
const productControlRouter = require('./src/routes/product_control.routes');
const integrationCenterRouter = require('./src/routes/integration_center.routes');

// --- MOUNT APIS & PAGES ---

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Core routers
app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/expenses', expenseRouter);
app.use('/api/salla', sallaRouter.router);
app.use('/api/ads', adsRouter.router);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/product-control', productControlRouter);
app.use('/api/integration', integrationCenterRouter);
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

// External System Control Panel — standalone page with its own PIN auth
app.get('/system-control', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'system-control.html'));
});

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
    
    let status = err.status || 500;
    if (err.message && (err.message.includes('FOREIGN KEY') || err.message.includes('UNIQUE constraint'))) {
        status = 400;
    }
    const isProd = process.env.NODE_ENV === 'production';
    
    const response = {
        error: (isProd && status === 500) ? 'حدث خطأ داخلي في الخادم.' : (err.message || 'Unknown error'),
        code: err.code || (status === 400 ? 'BAD_REQUEST' : (status === 401 ? 'UNAUTHORIZED' : (status === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR'))),
        ...(!isProd && err.stack ? { stack: err.stack } : {}),
        ...(err.details ? { details: err.details } : {})
    };

    res.status(status).json(response);
});

// Auto-Sync Salla Orders Background Jobs
const { syncSallaOrdersToLocal } = sallaRouter;
// Run auto-sync every 1 hour (Reconciliation Cron)
setInterval(syncSallaOrdersToLocal, 1 * 60 * 60 * 1000);
// Run initial sync after 10 seconds of server startup
setTimeout(syncSallaOrdersToLocal, 10000);

// Auto-Sync Ad Campaigns & Drift Alerts Schedulers
const SyncService = require('./src/services/sync.service');
// Run campaign sync every 1 hour
setInterval(() => SyncService.syncAllCampaigns(7), 1 * 60 * 60 * 1000);
// Run initial campaign sync after 15 seconds of startup
setTimeout(() => SyncService.syncAllCampaigns(7), 15000);
// Run drift alert check every 24 hours
setInterval(() => SyncService.checkDriftAlert(), 24 * 60 * 60 * 1000);
// Run initial drift check after 30 seconds of startup
setTimeout(() => SyncService.checkDriftAlert(), 30000);

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
