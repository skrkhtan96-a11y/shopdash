require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { db, getConfig, setConfig, deleteConfig, hashPassword, verifyPassword, logActivity } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// --- AUTHENTICATION & USER MANAGEMENT MIDDLEWARES ---
const crypto = require('crypto');

// Middleware to protect API endpoints
const authenticateUser = (req, res, next) => {
    const token = req.cookies.session_token;
    if (!token) {
        return res.status(401).json({ error: 'غير مصرح بالدخول. يرجى تسجيل الدخول.' });
    }
    db.get(
        `SELECT u.id, u.username, u.email, u.role FROM sessions s 
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

// Middleware to check authentication for static pages
app.use((req, res, next) => {
    const publicPages = ['/login.html', '/register.html'];
    const isHtmlOrRoot = req.path === '/' || req.path.endsWith('.html');
    
    if (isHtmlOrRoot && !publicPages.includes(req.path)) {
        const token = req.cookies.session_token;
        if (!token) {
            return res.redirect('/login.html');
        }
        db.get(
            `SELECT u.id, u.username, u.email, u.role FROM sessions s 
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
});

// Protect all API routes starting with /api (excluding /api/auth/, /api/ai/, and /api/mcp)
app.use('/api', (req, res, next) => {
    if (
        req.path.startsWith('/auth/') || 
        req.originalUrl.startsWith('/api/auth/') ||
        req.path.startsWith('/ai/') ||
        req.originalUrl.startsWith('/api/ai/') ||
        req.path.startsWith('/mcp') ||
        req.originalUrl.startsWith('/api/mcp')
    ) {
        return next();
    }
    authenticateUser(req, res, next);
});

// --- AUTH & USER API ENDPOINTS ---

// 1. Check if system is initialized (has at least one user)
app.get('/api/auth/check-init', (req, res) => {
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ initialized: (row ? row.count > 0 : false) });
    });
});

// 2. User registration (Sign-up)
app.post('/api/auth/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'يرجى ملء جميع الحقول المطلوبة.' });
    }
    
    // Check if it's the first user
    db.get("SELECT COUNT(*) as count FROM users", [], (errCount, rowCount) => {
        if (errCount) return res.status(500).json({ error: errCount.message });
        
        const isFirstUser = !rowCount || rowCount.count === 0;
        const role = isFirstUser ? 'admin' : 'employee'; // First user is Admin, others are Employee
        const hashedPassword = hashPassword(password);
        const createdAt = new Date().toISOString().split('T')[0];
        
        db.run(
            "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
            [username.trim(), email.trim().toLowerCase(), hashedPassword, role, createdAt],
            function(errInsert) {
                if (errInsert) {
                    if (errInsert.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'اسم المستخدم أو البريد الإلكتروني مسجل مسبقاً.' });
                    }
                    return res.status(500).json({ error: errInsert.message });
                }
                
                const userId = this.lastID;
                const sessionToken = crypto.randomBytes(32).toString('hex');
                const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days expiration
                
                db.run(
                    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                    [sessionToken, userId, expiresAt],
                    (errSession) => {
                        if (errSession) return res.status(500).json({ error: errSession.message });
                        
                        res.cookie('session_token', sessionToken, {
                            httpOnly: true,
                            expires: new Date(expiresAt),
                            secure: process.env.NODE_ENV === 'production'
                        });
                        
                        res.json({
                            success: true,
                            user: { id: userId, username, email, role }
                        });
                    }
                );
            }
        );
    });
});

// 3. User login
app.post('/api/auth/login', (req, res) => {
    const { login, password } = req.body; // login can be username or email
    if (!login || !password) {
        return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم/البريد وكلمة المرور.' });
    }
    
    db.get(
        "SELECT * FROM users WHERE username = ? OR email = ?",
        [login.trim(), login.trim().toLowerCase()],
        (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(400).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
            
            const isMatch = verifyPassword(password, user.password);
            if (!isMatch) return res.status(400).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
            
            const sessionToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            
            db.run(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                [sessionToken, user.id, expiresAt],
                (errSession) => {
                    if (errSession) return res.status(500).json({ error: errSession.message });
                    
                    res.cookie('session_token', sessionToken, {
                        httpOnly: true,
                        expires: new Date(expiresAt),
                        secure: process.env.NODE_ENV === 'production'
                    });
                    
                    res.json({
                        success: true,
                        user: { id: user.id, username: user.username, email: user.email, role: user.role }
                    });
                }
            );
        }
    );
});

// 4. User logout
app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies.session_token;
    if (token) {
        db.run("DELETE FROM sessions WHERE token = ?", [token], () => {
            res.clearCookie('session_token');
            res.json({ success: true });
        });
    } else {
        res.json({ success: true });
    }
});

// 5. Get current user profile
app.get('/api/auth/me', authenticateUser, (req, res) => {
    res.json(req.user);
});

// Get activity logs (accessible to authenticated users)
app.get('/api/activity-logs', authenticateUser, (req, res) => {
    db.all("SELECT * FROM activity_logs ORDER BY id DESC LIMIT 500", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 6. Manage users: Get all users (Admin only)
app.get('/api/users', authenticateUser, requireRole(['admin']), (req, res) => {
    db.all("SELECT id, username, email, role, created_at FROM users ORDER BY id ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 7. Manage users: Add user manually (Admin only)
app.post('/api/users', authenticateUser, requireRole(['admin']), (req, res) => {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password || !role) {
        return res.status(400).json({ error: 'يرجى تقديم كافة حقول البيانات للمستخدم الجديد.' });
    }
    
    const hashedPassword = hashPassword(password);
    const createdAt = new Date().toISOString().split('T')[0];
    
    db.run(
        "INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
        [username.trim(), email.trim().toLowerCase(), hashedPassword, role, createdAt],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'اسم المستخدم أو البريد الإلكتروني مسجل مسبقاً.' });
                }
                return res.status(500).json({ error: err.message });
            }
            logActivity(req.user.username, 'ADD', 'users', `تم إضافة مستخدم جديد: ${username} برتبة ${role}`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// 8. Manage users: Edit user role (Admin only)
app.put('/api/users/:id', authenticateUser, requireRole(['admin']), (req, res) => {
    const { id } = req.params;
    const { role, username, email, password } = req.body;
    
    if (!role) {
        return res.status(400).json({ error: 'يرجى تحديد دور المستخدم.' });
    }
    
    if (password) {
        const hashedPassword = hashPassword(password);
        db.run(
            "UPDATE users SET role = ?, username = ?, email = ?, password = ? WHERE id = ?",
            [role, username.trim(), email.trim().toLowerCase(), hashedPassword, id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                logActivity(req.user.username, 'UPDATE', 'users', `تم تحديث بيانات المستخدم: ${username} برتبة ${role}`).catch(console.error);
                res.json({ success: true });
            }
        );
    } else {
        db.run(
            "UPDATE users SET role = ?, username = ?, email = ? WHERE id = ?",
            [role, username.trim(), email.trim().toLowerCase(), id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                logActivity(req.user.username, 'UPDATE', 'users', `تم تحديث بيانات المستخدم: ${username} برتبة ${role}`).catch(console.error);
                res.json({ success: true });
            }
        );
    }
});

// 9. Manage users: Delete user (Admin only, cannot delete self!)
app.delete('/api/users/:id', authenticateUser, requireRole(['admin']), (req, res) => {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
        return res.status(400).json({ error: 'لا يمكنك حذف حسابك الشخصي النشط حالياً.' });
    }
    
    db.get("SELECT username FROM users WHERE id = ?", [id], (errGet, userRow) => {
        const targetUsername = userRow ? userRow.username : 'غير معروف';
        db.run("DELETE FROM users WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logActivity(req.user.username, 'DELETE', 'users', `تم حذف المستخدم: ${targetUsername} (معرف: ${id})`).catch(console.error);
            res.json({ success: true });
        });
    });
});

// تقديم الملفات العامة للواجهة الأمامية
app.use(express.static(path.join(__dirname, 'public')));

// خادم سلة للتصريح والمطابقة (URLs)
const SALLA_AUTH_URL = 'https://accounts.salla.sa/oauth2/auth';
const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

// دالة مساعدة للتحقق من تهيئة بيانات سلة الفعالة
function hasRealSallaCredentials() {
    return process.env.SALLA_CLIENT_ID && 
           process.env.SALLA_CLIENT_ID !== 'PLACEHOLDER_CLIENT_ID' &&
           process.env.SALLA_CLIENT_SECRET && 
           process.env.SALLA_CLIENT_SECRET !== 'PLACEHOLDER_CLIENT_SECRET';
}

// دالة تحديث توكين سلة تلقائياً عند الحاجة
async function getOrRefreshToken() {
    const sallaAuth = await getConfig('salla_auth');
    if (!sallaAuth) return null;

    const now = Math.floor(Date.now() / 1000);
    // إذا كان التوكين ينتهي بعد أقل من 5 دقائق، نقوم بتحديثه
    if (sallaAuth.expires_at - now < 300) {
        console.log('توكين سلة على وشك الانتهاء، جاري التحديث...');
        try {
            const response = await axios.post(SALLA_TOKEN_URL, {
                client_id: process.env.SALLA_CLIENT_ID,
                client_secret: process.env.SALLA_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: sallaAuth.refresh_token,
                redirect_uri: process.env.SALLA_REDIRECT_URI
            });

            const { access_token, refresh_token, expires_in } = response.data;
            const updatedAuth = {
                access_token,
                refresh_token,
                expires_at: Math.floor(Date.now() / 1000) + expires_in
            };
            
            await setConfig('salla_auth', updatedAuth);
            console.log('تم تحديث التوكين بنجاح!');
            return access_token;
        } catch (error) {
            console.error('فشل تحديث التوكين:', error.response ? error.response.data : error.message);
            return null; // فشل التحديث
        }
    }
    return sallaAuth.access_token;
}

// ── 1. تدفق تسجيل الدخول والـ OAuth لـ سلة ──

// مسار توجيه التاجر إلى سلة للتصريح
app.get('/auth', (req, res) => {
    if (!hasRealSallaCredentials()) {
        // إذا كانت الإعدادات وهمية، نوجه التاجر لنمط المحاكاة التلقائي
        return res.redirect('/?simulated_login=true');
    }
    const scopes = 'offline_access';
    // توليد معامل state عشوائي لتفادي خطأ invalid_state من سلة
    const stateParam = Math.random().toString(36).substring(2, 15);
    const authUrl = `${SALLA_AUTH_URL}?response_type=code&client_id=${process.env.SALLA_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.SALLA_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${stateParam}`;
    res.redirect(authUrl);
});

// مسار استقبال الـ Callback بعد موافقة التاجر في سلة
app.get('/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        console.error('خطأ من سلة أثناء التصريح:', error);
        return res.redirect('/?error=auth_denied');
    }

    try {
        // تبديل كود التصريح بـ access_token
        const response = await axios.post(SALLA_TOKEN_URL, {
            client_id: process.env.SALLA_CLIENT_ID,
            client_secret: process.env.SALLA_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.SALLA_REDIRECT_URI
        });

        const { access_token, refresh_token, expires_in } = response.data;
        const authData = {
            access_token,
            refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + expires_in
        };

        // جلب معلومات المتجر الحقيقية لتسجيلها
        const profileRes = await axios.get('https://api.salla.dev/admin/v2/store/profile', {
            headers: { 
                'Authorization': `Bearer ${access_token}`,
                'Accept-Language': 'ar'
            }
        });

        const storeInfo = {
            name: profileRes.data.data.name,
            domain: profileRes.data.data.domain,
            avatar: profileRes.data.data.avatar || 'https://cdn.salla.sa/assets/images/logo.png',
            connected_at: new Date().toISOString()
        };

        // حفظ البيانات في قاعدة البيانات SQLite
        await setConfig('salla_auth', authData);
        await setConfig('salla_store', storeInfo);

        console.log(`تم ربط متجر "${storeInfo.name}" بنجاح!`);
        res.redirect('/?success=connected');
    } catch (e) {
        console.error('خطأ أثناء تبديل توكين سلة:', e.response ? e.response.data : e.message);
        res.redirect('/?error=token_exchange_failed');
    }
});

// مسار فحص حالة الربط
app.get('/api/salla/auth-status', async (req, res) => {
    try {
        const storeInfo = await getConfig('salla_store');
        const sallaAuth = await getConfig('salla_auth');
        const hasCredentials = hasRealSallaCredentials();

        db.get("SELECT COUNT(*) as count FROM salla_imported_orders", [], (err, row) => {
            const importedCount = (!err && row) ? row.count : 0;
            
            db.get("SELECT COUNT(*) as count FROM salla_imported_wallet", [], (errW, rowW) => {
                const importedWalletCount = (!errW && rowW) ? rowW.count : 0;

                if (storeInfo && sallaAuth) {
                    res.json({
                        connected: true,
                        simulated: false,
                        has_credentials: hasCredentials,
                        store: storeInfo,
                        imported_count: importedCount,
                        imported_wallet_count: importedWalletCount
                    });
                } else {
                    res.json({
                        connected: false,
                        simulated: true, // نمط محاكاة افتراضي
                        has_credentials: hasCredentials,
                        store: {
                            name: (importedCount > 0 || importedWalletCount > 0) ? "لوحة الأوفلاين (مستوردة)" : "متجر تجريبي (محاكاة)",
                            domain: (importedCount > 0 || importedWalletCount > 0) ? `مستورد ${importedCount} طلب و ${importedWalletCount} تسوية` : "demo-store.salla.sa",
                            avatar: (importedCount > 0 || importedWalletCount > 0) ? "I" : "S"
                        },
                        imported_count: importedCount,
                        imported_wallet_count: importedWalletCount
                    });
                }
            });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// مسار جلب كشف المحفظة المستوردة
app.get('/api/salla/wallet', (req, res) => {
    const from = req.query.from || '';
    const to = req.query.to || '';
    const status = req.query.status || '';

    let query = "SELECT * FROM salla_imported_wallet WHERE 1=1";
    const params = [];

    if (status) {
        query += " AND status = ?";
        params.push(status);
    }
    if (from) {
        query += " AND date >= ?";
        params.push(from);
    }
    if (to) {
        query += " AND date <= ?";
        params.push(to);
    }

    query += " ORDER BY date DESC, id DESC";

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ data: rows });
    });
});

// مسار استيراد وحفظ تسويات المحفظة من إكسل إلى قاعدة البيانات
app.post('/api/salla/imported-wallet', (req, res) => {
    const { transactions } = req.body;
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
        return res.status(400).json({ error: 'يرجى تقديم مصفوفة عمليات صالحة.' });
    }

    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO salla_imported_wallet 
            (reference_id, amount, commission, net, tax, date, status, note) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        transactions.forEach(t => {
            stmt.run([
                String(t.reference_id),
                parseFloat(t.amount) || 0,
                parseFloat(t.commission) || 0,
                parseFloat(t.net) || 0,
                parseFloat(t.tax) || 0,
                t.date,
                t.status || 'مدفوعة',
                t.note || ''
            ]);
        });

        stmt.finalize((err) => {
            if (err) {
                console.error('خطأ أثناء حفظ عمليات المحفظة:', err.message);
                return res.status(500).json({ error: 'فشل حفظ العمليات في قاعدة البيانات.' });
            }
            res.json({ success: true, count: transactions.length });
        });
    });
});

// مسار حذف وتصفير تسويات المحفظة المستوردة
app.post('/api/salla/clear-wallet-imports', (req, res) => {
    db.run("DELETE FROM salla_imported_wallet", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// مسار إلغاء الربط (تسجيل الخروج من سلة)
app.get('/api/salla/disconnect', async (req, res) => {
    try {
        await deleteConfig('salla_auth');
        await deleteConfig('salla_store');
        res.json({ success: true, message: 'تم قطع الربط بالمتجر بنجاح' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── 2. بروكسي جلب البيانات المباشرة من سلة APIs ──

// مسار جلب الطلبات
// مسار جلب الطلبات
app.get('/api/salla/orders', async (req, res) => {
    const page = req.query.page || 1;
    const perPage = req.query.per_page || 15;
    const status = req.query.status || '';
    const products = req.query.products || '';
    const q = req.query.q || '';
    const from = req.query.from || '';
    const to = req.query.to || '';
    const sort = req.query.sort || 'desc';
    const minAmt = req.query.min_amt || '';
    const maxAmt = req.query.max_amt || '';

    const token = await getOrRefreshToken();

    // إذا لم يكن هناك اتصال حقيقي، نتحقق أولاً من المبيعات المستوردة في قاعدة البيانات
    if (!token) {
        db.get("SELECT COUNT(*) as count FROM salla_imported_orders", [], (err, countRow) => {
            if (!err && countRow && countRow.count > 0) {
                // لدينا بيانات مستوردة حقيقية! نقوم بجلبها وتصفيتها
                let query = "SELECT * FROM salla_imported_orders WHERE 1=1";
                const params = [];

                if (status) {
                    const statusList = status.split(',').map(s => s.trim()).filter(s => s);
                    if (statusList.length > 0) {
                        const placeholders = statusList.map(() => '?').join(',');
                        query += ` AND status_slug IN (${placeholders})`;
                        params.push(...statusList);
                    }
                }
                if (products) {
                    const prodList = products.split(',').map(p => p.trim()).filter(p => p);
                    if (prodList.length > 0) {
                        const placeholders = prodList.map(() => '?').join(',');
                        query += ` AND product_name IN (${placeholders})`;
                        params.push(...prodList);
                    }
                }
                if (q) {
                    query += " AND (customer_name LIKE ? OR product_name LIKE ? OR reference_id LIKE ?)";
                    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
                }
                if (from) {
                    query += " AND date(date) >= date(?)";
                    params.push(from);
                }
                if (to) {
                    query += " AND date(date) <= date(?)";
                    params.push(to);
                }
                if (minAmt) {
                    query += " AND amount >= ?";
                    params.push(parseFloat(minAmt));
                }
                if (maxAmt) {
                    query += " AND amount <= ?";
                    params.push(parseFloat(maxAmt));
                }

                // الترتيب
                if (sort === 'asc') {
                    query += " ORDER BY date ASC, id ASC";
                } else if (sort === 'amt-desc') {
                    query += " ORDER BY amount DESC";
                } else if (sort === 'amt-asc') {
                    query += " ORDER BY amount ASC";
                } else {
                    query += " ORDER BY date DESC, id DESC";
                }

                db.all(query, params, (err, rows) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }

                    const total = rows.length;
                    const startIndex = (page - 1) * perPage;
                    const paginatedRows = rows.slice(startIndex, startIndex + parseInt(perPage));

                    // تحويل الصفوف إلى الهيكل الذي تتوقعه الواجهة الأمامية تماماً
                    const formattedData = paginatedRows.map(r => ({
                        id: r.id,
                        reference_id: r.reference_id,
                        date: { date: r.date },
                        created_at: r.date,
                        status: {
                            slug: r.status_slug || 'completed',
                            name: r.status_name || 'تم التنفيذ',
                            customized: { name: r.status_name || 'تم التنفيذ' }
                        },
                        payment_method: r.payment_method || 'mada',
                        items: [
                            {
                                name: r.product_name || '-',
                                thumbnail: r.product_thumbnail || '',
                                quantity: r.quantity || 1
                            }
                        ],
                        customer: { full_name: r.customer_name || '-' },
                        payment_actions: {
                            refund_action: {
                                paid_amount: { amount: r.amount, currency: 'SAR' }
                            }
                        },
                        total: { amount: r.amount }
                    }));

                    res.json({
                        data: formattedData,
                        pagination: {
                            total,
                            count: formattedData.length,
                            per_page: perPage,
                            current_page: parseInt(page),
                            total_pages: Math.ceil(total / perPage) || 1
                        }
                    });
                });
            } else {
                // لا توجد بيانات مستوردة، نرجع المحاكاة الافتراضية
                return res.json(getSimulatedOrders(page, perPage, status, products, sort, minAmt, maxAmt, q, from, to));
            }
        });
        return;
    }

    try {
        let url = `https://api.salla.dev/admin/v2/orders?page=${page}&per_page=${perPage}`;
        if (status) url += `&status=${status}`;
        if (products) {
            // Note: Salla API doesn't have a direct multiselect products query parameter usually in standard queries, but if they are using it or we are offline/imported, we do it. We can pass it or handle.
        }
        if (q) url += `&keyword=${encodeURIComponent(q)}`;
        if (from) url += `&created_at_from=${from}`;
        if (to) url += `&created_at_to=${to}`;

        const response = await axios.get(url, {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Accept-Language': 'ar'
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error('خطأ أثناء جلب طلبات سلة:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'فشل جلب الطلبات من سلة API', details: error.message });
    }
});

// مسار استيراد وحفظ مبيعات سلة من إكسل إلى قاعدة البيانات
app.post('/api/salla/imported-orders', (req, res) => {
    const { orders } = req.body;
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
        return res.status(400).json({ error: 'يرجى تقديم مصفوفة طلبات صالحة.' });
    }

    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO salla_imported_orders 
            (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        orders.forEach(o => {
            stmt.run([
                String(o.reference_id),
                o.date,
                o.status_slug || 'completed',
                o.status_name || 'تم التنفيذ',
                o.payment_method || 'mada',
                parseFloat(o.amount) || 0,
                o.customer_name || 'عميل خارجي',
                o.product_name || 'منتج مستورد',
                o.product_thumbnail || '',
                parseInt(o.quantity) || 1
            ]);
        });

        stmt.finalize((err) => {
            if (err) {
                console.error('خطأ أثناء حفظ الطلبات المستوردة:', err.message);
                return res.status(500).json({ error: 'فشل حفظ الطلبات في قاعدة البيانات.' });
            }
            res.json({ success: true, count: orders.length });
        });
    });
});

// ══════════════════════════════════════════════
//  آلية المزامنة التلقائية واليدوية لسلة ومسارات الذكاء الاصطناعي
// ══════════════════════════════════════════════

// دالة المزامنة التلقائية للطلبات من سلة إلى قاعدة البيانات المحلية
async function syncSallaOrdersToLocal(throwOnError = false) {
    try {
        const token = await getOrRefreshToken();
        if (!token) {
            if (throwOnError) {
                throw new Error('SALLA_NOT_CONNECTED');
            }
            console.log('[Auto-Sync] سلة غير متصلة (OAuth). تخطي المزامنة.');
            return 0;
        }
        
        console.log('[Auto-Sync] جاري سحب أحدث الطلبات من منصة سلة...');
        const response = await axios.get('https://api.salla.dev/admin/v2/orders?per_page=30', {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Accept-Language': 'ar'
            }
        });
        
        const orders = response.data?.data || [];
        if (orders.length === 0) return 0;
        
        let newCount = 0;
        
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO salla_imported_orders 
            (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        orders.forEach(o => {
            const refId = String(o.reference_id);
            const dateStr = o.created_at ? o.created_at.split(' ')[0] : new Date().toISOString().split('T')[0];
            const statusSlug = o.status?.slug || 'completed';
            const statusName = o.status?.name || 'تم التنفيذ';
            const paymentMethod = o.payment_method || 'mada';
            const amount = parseFloat(o.total?.amount || o.payment_actions?.refund_action?.paid_amount?.amount || 0);
            const customerName = o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : 'عميل خارجي';
            
            const items = o.items || [];
            if (items.length > 0) {
                items.forEach(item => {
                    const prodName = item.name || 'منتج مستورد';
                    const thumbnail = item.thumbnail || '';
                    const qty = parseInt(item.quantity) || 1;
                    
                    stmt.run([
                        refId + '_' + item.id, // لمنع تصادم السجلات عند تكرار الأصناف بنفس الطلب
                        dateStr,
                        statusSlug,
                        statusName,
                        paymentMethod,
                        amount / items.length,
                        customerName,
                        prodName,
                        thumbnail,
                        qty
                    ]);
                    newCount++;
                });
            } else {
                stmt.run([
                    refId,
                    dateStr,
                    statusSlug,
                    statusName,
                    paymentMethod,
                    amount,
                    customerName,
                    'طلب بدون عناصر',
                    '',
                    1
                ]);
                newCount++;
            }
        });
        
        await new Promise((resolve, reject) => {
            stmt.finalize((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        console.log(`[Auto-Sync] تم الانتهاء بنجاح! جلب ومزامنة ${newCount} بند مبيعات من سلة.`);
        return newCount;
    } catch (error) {
        console.error('[Auto-Sync] خطأ أثناء مزامنة سلة تلقائياً:', error.message);
        if (throwOnError) {
            throw error;
        }
        return 0;
    }
}

// 1. تشغيل المزامنة التلقائية كل 5 ساعات
setInterval(syncSallaOrdersToLocal, 5 * 60 * 60 * 1000);
// 2. تشغيل المزامنة لمرة واحدة أولية بعد 10 ثوانٍ من تشغيل الخادم
setTimeout(syncSallaOrdersToLocal, 10000);

// مسار المزامنة الفورية عند طلب التحديث من الواجهة
app.post('/api/salla/sync-now', async (req, res) => {
    try {
        const count = await syncSallaOrdersToLocal(true);
        res.json({ success: true, count });
    } catch (e) {
        if (e.message === 'SALLA_NOT_CONNECTED') {
            return res.status(400).json({
                success: false,
                error: 'SALLA_NOT_CONNECTED',
                message: 'متجر سلة غير متصل باللوحة حالياً عبر الـ OAuth.'
            });
        }
        res.status(500).json({ error: 'فشلت المزامنة المباشرة من سلة حالياً', details: e.message });
    }
});

// مسار جلب البيانات الحية المخصصة لقراءة ذكاء Claude AI
app.get('/api/ai/live-data', async (req, res) => {
    const token = req.query.token;
    const expectedToken = 'claude_ai_secret_123'; // رمز الأمان المخصص
    if (token !== expectedToken) {
        return res.status(401).json({ error: 'غير مصرح بالدخول. رمز الأمان خاطئ.' });
    }
    
    try {
        db.all("SELECT * FROM expenses", [], (errExp, expenses) => {
            if (errExp) return res.status(500).json({ error: errExp.message });
            
            db.all("SELECT * FROM salla_imported_orders", [], (errSales, sales) => {
                if (errSales) return res.status(500).json({ error: errSales.message });
                
                db.all("SELECT * FROM product_adjustments", [], (errAdj, adjustments) => {
                    if (errAdj) return res.status(500).json({ error: errAdj.message });
                    
                    db.all("SELECT * FROM salla_imported_wallet", [], (errWallet, wallet) => {
                        if (errWallet) return res.status(500).json({ error: errWallet.message });
                        
                        db.all("SELECT * FROM ads_campaign_metrics", [], (errAds, ads) => {
                            if (errAds) return res.status(500).json({ error: errAds.message });
                            
                            const totalExpenses = expenses.reduce((s, e) => s + (e.amt || 0), 0);
                            const totalRevenue = sales.reduce((s, o) => s + (o.amount || 0), 0);
                            const netProfit = totalRevenue - totalExpenses;
                            
                            const map = {};
                            sales.forEach(o => {
                                const name = (o.product_name || 'غير معروف').trim();
                                if (!map[name]) {
                                    map[name] = { name, sold: 0, revenue: 0, purchased: 0, cost: 0, stock: 0 };
                                }
                                map[name].sold += o.quantity || 1;
                                map[name].revenue += o.amount || 0;
                            });
                            
                            expenses.forEach(e => {
                                if (e.cat === 'شراء منتجات' && e.product_name) {
                                    const name = e.product_name.trim();
                                    if (!map[name]) {
                                        map[name] = { name, sold: 0, revenue: 0, purchased: 0, cost: 0, stock: 0 };
                                    }
                                    map[name].purchased += e.quantity || 0;
                                    if (e.purchase_price) map[name].cost = e.purchase_price;
                                }
                            });
                            
                            adjustments.forEach(a => {
                                const name = (a.product_name || '').trim();
                                if (!map[name]) {
                                    map[name] = { name, sold: 0, revenue: 0, purchased: 0, cost: 0, stock: 0 };
                                }
                                if (a.cost > 0) map[name].cost = a.cost;
                            });
                            
                            const inventory = Object.values(map).map(p => {
                                const adj = adjustments.find(a => a.product_name === p.name) || { stock_offset: 0 };
                                const stock = p.purchased - p.sold + adj.stock_offset;
                                return {
                                    product_name: p.name,
                                    quantity_purchased: p.purchased,
                                    quantity_sold: p.sold,
                                    remaining_stock: stock,
                                    unit_cost_sar: p.cost,
                                    total_revenue_sar: p.revenue
                                };
                            });

                            const totalAdSpend = ads.reduce((s, a) => s + (a.spend || 0), 0);
                            const totalAdConversions = ads.reduce((s, a) => s + (a.conversions || 0), 0);
                            
                            res.json({
                                store_name: "شوب ستور - لوحة تحكم المحاسبة الذكية",
                                financial_summary: {
                                    total_revenue_sar: totalRevenue,
                                    total_expenses_sar: totalExpenses,
                                    total_ad_spend_sar: totalAdSpend,
                                    net_profit_sar: netProfit,
                                    wallet_total_operations: wallet.length
                                },
                                recent_orders_count: sales.length,
                                inventory_status: inventory,
                                ads_summary: {
                                    total_ad_spend_sar: totalAdSpend,
                                    total_conversions: totalAdConversions,
                                    campaigns_count: ads.length,
                                    campaigns_list: ads.map(a => ({
                                        campaign_id: a.campaign_id,
                                        campaign_name: a.campaign_name,
                                        platform: a.platform,
                                        status: a.status,
                                        spend_sar: a.spend,
                                        clicks: a.clicks,
                                        impressions: a.impressions,
                                        conversions: a.conversions,
                                        date: a.date
                                    }))
                                },
                                expenses_breakdown: expenses.map(e => ({
                                    description: e.desc,
                                    category: e.cat,
                                    amount_sar: e.amt,
                                    date: e.date,
                                    notes: e.note
                                  }))
                            });
                        });
                    });
                });
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'فشل تجميع البيانات للذكاء الاصطناعي', details: err.message });
    }
});

// ══════════════════════════════════════════════
//  مسارات مقارنة المبيعات المستوردة (إكسل المخصص)
// ══════════════════════════════════════════════

// 1. مسار استيراد ملف إكسل مبيعات مخصص وحفظه
app.post('/api/sales/import-excel', (req, res) => {
    const { title, date, rows } = req.body;
    if (!title || !rows || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'يرجى تقديم عنوان التقرير والصفوف الصالحة.' });
    }
    const importId = 'imp_' + Date.now();
    const importDate = date || new Date().toISOString().split('T')[0];
    
    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT INTO product_sales_imports 
            (import_id, import_title, import_date, product_type, brand_name, qty_sold, sales_before_discount, discount, cost_of_sales, net_sales, taxes, total_sales) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        rows.forEach(r => {
            stmt.run([
                importId,
                title,
                importDate,
                r.product_type || '',
                r.brand_name || '',
                parseInt(r.qty_sold) || 0,
                parseFloat(r.sales_before_discount) || 0,
                parseFloat(r.discount) || 0,
                parseFloat(r.cost_of_sales) || 0,
                parseFloat(r.net_sales) || 0,
                parseFloat(r.taxes) || 0,
                parseFloat(r.total_sales) || 0
            ]);
        });
        
        stmt.finalize((err) => {
            if (err) {
                console.error('خطأ أثناء استيراد مبيعات إكسل:', err.message);
                return res.status(500).json({ error: 'فشل حفظ التقرير في قاعدة البيانات.' });
            }
            res.json({ success: true, import_id: importId, import_title: title, count: rows.length });
        });
    });
});

// 2. مسار جلب قائمة ملفات الاستيراد
app.get('/api/sales/imports', (req, res) => {
    db.all(`
        SELECT import_id, import_title, import_date, COUNT(*) as rows_count,
               SUM(qty_sold) as total_qty, SUM(total_sales) as total_revenue
        FROM product_sales_imports 
        GROUP BY import_id 
        ORDER BY import_date DESC, id DESC
    `, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 3. مسار حذف استيراد معين وبياناته
app.delete('/api/sales/imports/:import_id', (req, res) => {
    const { import_id } = req.params;
    db.run("DELETE FROM product_sales_imports WHERE import_id = ?", [import_id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// 4. مسار جلب تفاصيل الاستيرادات للمقارنة
app.get('/api/sales/compare-reports', (req, res) => {
    const { import1, import2 } = req.query;
    if (!import1 || !import2) {
        return res.status(400).json({ error: 'يرجى تقديم معرفي الاستيراد للمقارنة.' });
    }
    
    db.all("SELECT * FROM product_sales_imports WHERE import_id IN (?, ?)", [import1, import2], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const import1Rows = rows.filter(r => r.import_id === import1);
        const import2Rows = rows.filter(r => r.import_id === import2);
        
        res.json({
            import1: import1Rows,
            import2: import2Rows
        });
    });
});

// 5. مسار حفظ مقارنة جديدة
app.post('/api/sales/saved-comparisons', (req, res) => {
    const { title, compare_type, param1, param2, summary_json } = req.body;
    if (!title || !compare_type) {
        return res.status(400).json({ error: 'يرجى تقديم عنوان ونوع المقارنة.' });
    }
    const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    db.run(`
        INSERT INTO saved_comparisons (title, compare_type, param1, param2, summary_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [title, compare_type, param1 || '', param2 || '', JSON.stringify(summary_json || {}), createdAt], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

// 6. مسار جلب المقارنات المحفوظة
app.get('/api/sales/saved-comparisons', (req, res) => {
    db.all("SELECT * FROM saved_comparisons ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows.map(r => ({
            ...r,
            summary_json: JSON.parse(r.summary_json || '{}')
        })));
    });
});

// 7. مسار حذف مقارنة محفوظة
app.delete('/api/sales/saved-comparisons/:id', (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM saved_comparisons WHERE id = ?", [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// مسار حذف وتصفير المبيعات المستوردة من قاعدة البيانات
app.post('/api/salla/clear-imports', (req, res) => {
    db.run("DELETE FROM salla_imported_orders", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// مسار حذف وتصفير بيانات اللوحة بالكامل للمدير
app.post('/api/system/clear-all', requireRole(['admin']), (req, res) => {
    const tables = ['expenses', 'archives', 'salla_imported_orders', 'salla_imported_wallet', 'product_adjustments', 'ads_campaign_metrics', 'ads_connections'];
    let errorOccurred = false;
    let completed = 0;
    
    tables.forEach(table => {
        db.run(`DELETE FROM ${table}`, [], (err) => {
            if (err && !errorOccurred) {
                errorOccurred = true;
                return res.status(500).json({ error: err.message });
            }
            completed++;
            if (completed === tables.length && !errorOccurred) {
                db.run("VACUUM", [], () => {
                    res.json({ success: true });
                });
            }
        });
    });
});


// ── 4. مسارات وإدارة الحملات الإعلانية الموحدة (Facebook, Snapchat, TikTok) ──

// جلب حالات الاتصال بالمنصات الإعلانية
app.get('/api/ads/connections', (req, res) => {
    db.all("SELECT * FROM ads_connections", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const connMap = {
            facebook: { status: 'disconnected', account_id: '' },
            snapchat: { status: 'disconnected', account_id: '' },
            tiktok: { status: 'disconnected', account_id: '' }
        };
        rows.forEach(r => {
            connMap[r.platform] = { status: r.status, account_id: r.account_id || '' };
        });
        res.json(connMap);
    });
});

// ربط منصة إعلانية (محاكاة أو حقيقي)
app.post('/api/ads/connections/connect', (req, res) => {
    const { platform, account_id } = req.body;
    if (!['facebook', 'snapchat', 'tiktok'].includes(platform)) {
        return res.status(400).json({ error: 'منصة غير صالحة' });
    }
    const accId = account_id || `acc_${Math.floor(100000 + Math.random() * 900000)}`;
    db.run(
        `INSERT INTO ads_connections (platform, account_id, status) VALUES (?, ?, 'connected') 
         ON CONFLICT(platform) DO UPDATE SET account_id = ?, status = 'connected'`,
        [platform, accId, accId],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, platform, account_id: accId });
        }
    );
});

// قطع ربط منصة إعلانية
app.post('/api/ads/connections/disconnect', (req, res) => {
    const { platform } = req.body;
    db.run("DELETE FROM ads_connections WHERE platform = ?", [platform], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// مسار استقبال الـ callback من تيك توك وتوليد توكين الوصول الفعلي
const handleTikTokCallback = async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('كود التفويض غير موجود');
    }

    try {
        const appId = "7646601182546231297";
        const secret = "abc042e1d2f83d6ac0898bb4990cd903dd1c4460";
        
        const response = await axios.post("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
            app_id: appId,
            secret: secret,
            auth_code: code
        });

        if (response.data && response.data.code === 0) {
            const accessToken = response.data.data.access_token;
            // حفظ التوكين في قاعدة البيانات مع معرف الحساب الافتراضي
            db.run(
                `INSERT OR REPLACE INTO ads_connections (platform, account_id, access_token, status) VALUES (?, ?, ?, ?)`,
                ['tiktok', '7492167669576351745', accessToken, 'connected'],
                (err) => {
                    if (err) {
                        return res.status(500).send('خطأ أثناء حفظ التوكين في قاعدة البيانات: ' + err.message);
                    }
                    res.send(`
                        <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0d1117;color:#c9d1d9;height:100vh;box-sizing:border-box;">
                            <h2 style="color:#10B981;margin-top:100px;">تم ربط حساب تيك توك إعلانات بنجاح!</h2>
                            <p>تم استلام التوكين وتحديث الحساب الإعلاني لمتجر نُظم (هويتك0411) بنجاح.</p>
                            <p style="color:#8b949e;font-size:12px;">تلقائياً، ستبدأ اللوحة بعرض إحصاءات الإعلانات الحقيقية.</p>
                            <button onclick="window.close()" style="margin-top:20px;padding:10px 20px;background:#10B981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">إغلاق النافذة</button>
                        </div>
                    `);
                }
            );
        } else {
            res.status(400).send('فشل توليد التوكين من تيك توك: ' + (response.data ? response.data.message : 'خطأ غير معروف'));
        }
    } catch (error) {
        res.status(500).send('خطأ أثناء استبدال توكين تيك توك: ' + (error.response ? JSON.stringify(error.response.data) : error.message));
    }
};

app.get('/api/auth/tiktok/callback', handleTikTokCallback);
app.get('/nuzum', handleTikTokCallback);

// دالة لجلب إحصاءات تيك توك الحية من خوادمهم (البيانات الإحصائية والبيانات الفوقية)
async function fetchLiveTikTokCampaigns(token, advertiserId, fromDate, toDate) {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const start = fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const end = toDate || todayStr;

        console.log(`[TikTok API] Fetching campaigns metadata for advertiser: ${advertiserId}...`);
        
        // 1. جلب معلومات الحملات الإعلانية الأساسية (الاسم، الحالة الفنية)
        const campaignsRes = await axios.get("https://business-api.tiktok.com/open_api/v1.3/campaign/get/", {
            headers: { 
                'Access-Token': token,
                'Content-Type': 'application/json'
            },
            params: {
                advertiser_id: advertiserId,
                page_size: 100
            }
        });

        const campaignMeta = {};
        if (campaignsRes.data && campaignsRes.data.code === 0) {
            const list = campaignsRes.data.data.list || [];
            list.forEach(c => {
                campaignMeta[c.campaign_id] = {
                    name: c.campaign_name,
                    status: c.operation_status === 'ENABLE' ? 'active' : 'paused',
                    budget: parseFloat(c.budget || 0),
                    budget_mode: c.budget_mode || 'BUDGET_MODE_INFINITE'
                };
            });
        } else {
            console.error("TikTok Campaign Get API error:", campaignsRes.data ? campaignsRes.data.message : 'Unknown');
            return null;
        }

        // 2. تقسيم النطاق الزمني لطلب التقارير إلى دفعات لا تزيد كل منها عن 30 يوماً لتجنب خطأ تيك توك (max time span is 30 days)
        const chunks = [];
        let curr = new Date(start);
        const endLimit = new Date(end);
        while (curr <= endLimit) {
            const chunkEnd = new Date(curr);
            chunkEnd.setDate(chunkEnd.getDate() + 29); // 30 يوماً كحد أقصى للدفعة الواحدة
            const actualEnd = chunkEnd > endLimit ? endLimit : chunkEnd;
            chunks.push({
                start: curr.toISOString().split('T')[0],
                end: actualEnd.toISOString().split('T')[0]
            });
            curr = new Date(actualEnd);
            curr.setDate(curr.getDate() + 1);
        }

        const results = [];
        const campaignsInReport = new Set();

        // 3. استدعاء واجهة التقارير الموحدة لجلب الإحصاءات اليومية الفعلية
        for (const chunk of chunks) {
            console.log(`[TikTok API] Fetching report metrics from ${chunk.start} to ${chunk.end}...`);
            const reportRes = await axios.get("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
                headers: { 
                    'Access-Token': token,
                    'Content-Type': 'application/json'
                },
                params: {
                    advertiser_id: advertiserId,
                    report_type: 'BASIC',
                    data_level: 'AUCTION_CAMPAIGN',
                    dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
                    metrics: JSON.stringify(["spend", "clicks", "impressions", "conversion"]),
                    start_date: chunk.start,
                    end_date: chunk.end,
                    page_size: 100
                }
            });

            if (reportRes.data && reportRes.data.code === 0) {
                const list = reportRes.data.data.list || [];
                list.forEach(r => {
                    const campaignId = r.dimensions.campaign_id;
                    const dateRaw = r.dimensions.stat_time_day;
                    const date = dateRaw.split(' ')[0]; // استخلاص التاريخ بصيغة yyyy-MM-dd
                    const meta = campaignMeta[campaignId] || { name: 'حملة غير معروفة - TikTok', status: 'paused' };
                    
                    campaignsInReport.add(campaignId);

                    results.push({
                        campaign_id: campaignId + '_' + date,
                        campaign_name: meta.name,
                        platform: 'tiktok',
                        status: meta.status,
                        spend: parseFloat(r.metrics.spend || 0),
                        clicks: parseInt(r.metrics.clicks || 0),
                        impressions: parseInt(r.metrics.impressions || 0),
                        conversions: parseInt(r.metrics.conversion || 0),
                        date: date,
                        budget: meta.budget || 0,
                        budget_mode: meta.budget_mode || 'BUDGET_MODE_INFINITE'
                    });
                });
            } else {
                console.error("TikTok Reporting API error for chunk:", chunk, reportRes.data ? reportRes.data.message : 'Unknown');
            }
        }

        // 4. الحفاظ على الحملات التي لم تنفق أي ميزانية خلال الفترة، وإضافتها بقيم صفرية لضمان ظهورها بالجدول
        Object.keys(campaignMeta).forEach(cid => {
            if (!campaignsInReport.has(cid)) {
                results.push({
                    campaign_id: cid + '_' + end,
                    campaign_name: campaignMeta[cid].name,
                    platform: 'tiktok',
                    status: campaignMeta[cid].status,
                    spend: 0.00,
                    clicks: 0,
                    impressions: 0,
                    conversions: 0,
                    date: end,
                    budget: campaignMeta[cid].budget || 0,
                    budget_mode: campaignMeta[cid].budget_mode || 'BUDGET_MODE_INFINITE'
                });
            }
        });

        return results;
    } catch (e) {
        console.error("Failed to fetch live TikTok campaigns and reports:", e.message);
        return null;
    }
}

// جلب معلومات رصيد الحساب الإعلاني من تيك توك حياً
app.get('/api/ads/account-info', (req, res) => {
    db.all("SELECT * FROM ads_connections WHERE platform = 'tiktok' AND status = 'connected'", [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length === 0 || !rows[0].access_token) {
            return res.json({ platform: 'tiktok', balance: 0, name: 'غير متصل', currency: 'SAR' });
        }
        
        try {
            const token = rows[0].access_token;
            const advertiserId = rows[0].account_id || '7492167669576351745';
            
            const response = await axios.get("https://business-api.tiktok.com/open_api/v1.3/advertiser/info/", {
                headers: { 'Access-Token': token },
                params: { advertiser_ids: JSON.stringify([advertiserId]) }
            });
            
            if (response.data && response.data.code === 0 && response.data.data.list && response.data.data.list.length > 0) {
                const info = response.data.data.list[0];
                return res.json({
                    platform: 'tiktok',
                    balance: info.balance !== undefined ? info.balance : 141.70,
                    name: info.name || 'هويتك0411',
                    currency: info.currency || 'SAR',
                    advertiser_id: advertiserId
                });
            } else {
                return res.json({ platform: 'tiktok', balance: 141.7, name: 'هويتك0411', currency: 'SAR', advertiser_id: advertiserId });
            }
        } catch (e) {
            console.error("Failed to fetch TikTok account info:", e.message);
            return res.json({ platform: 'tiktok', balance: 141.7, name: 'هويتك0411', currency: 'SAR', advertiser_id: '7492167669576351745' });
        }
    });
});

// جلب إحصائيات الحملات الإعلانية مع الفلترة التاريخية ومحاكاة البيانات الذكية
app.get('/api/ads/campaigns', (req, res) => {
    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];
    const platform = req.query.platform || ''; // facebook, snapchat, tiktok or empty for all

    // جلب المنصات المتصلة فعلياً
    db.all("SELECT * FROM ads_connections WHERE status = 'connected'", [], async (err, connRows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const activePlatforms = connRows.map(r => r.platform);
        const tiktokConn = connRows.find(r => r.platform === 'tiktok');

        // إذا كان تيك توك متصلاً، نحاول تحديث البيانات حياً من السيرفر
        if (tiktokConn && tiktokConn.access_token && tiktokConn.account_id) {
            const liveData = await fetchLiveTikTokCampaigns(tiktokConn.access_token, tiktokConn.account_id, from, to);
            if (liveData && liveData.length > 0) {
                // نجح الجلب! نقوم بتحديث قاعدة البيانات
                db.serialize(() => {
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO ads_campaign_metrics 
                        (campaign_id, campaign_name, platform, status, spend, clicks, impressions, conversions, date, budget, budget_mode) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    liveData.forEach(c => {
                        stmt.run([c.campaign_id, c.campaign_name, c.platform, c.status, c.spend, c.clicks, c.impressions, c.conversions, c.date, c.budget || 0, c.budget_mode || 'BUDGET_MODE_INFINITE']);
                    });
                    stmt.finalize();
                });
            }
        }

        // إذا لم يكن هناك منصات متصلة، يمكننا افتراض تفعيل وضع المحاكاة لجميع المنصات تسهيلاً للاستعراض الأولي
        const platformsToQuery = activePlatforms.length > 0 ? activePlatforms : ['facebook', 'snapchat', 'tiktok'];

        // فلترة المنصة المحددة بالطلب إن وجدت
        const targetPlatforms = platform ? platformsToQuery.filter(p => p === platform) : platformsToQuery;

        if (targetPlatforms.length === 0) {
            return res.json([]);
        }

        // بناء استعلام لجلب البيانات من جدول ads_campaign_metrics
        let query = "SELECT * FROM ads_campaign_metrics WHERE 1=1";
        const params = [];

        if (platform) {
            query += " AND platform = ?";
            params.push(platform);
        } else {
            query += ` AND platform IN (${targetPlatforms.map(() => '?').join(',')})`;
            targetPlatforms.forEach(p => params.push(p));
        }

        if (from) {
            query += " AND date >= ?";
            params.push(from);
        }
        if (to) {
            query += " AND date <= ?";
            params.push(to);
        }

        db.all(query, params, async (err, campaignRows) => {
            if (err) return res.status(500).json({ error: err.message });

            // إذا كانت قاعدة البيانات فارغة أو نطاق التواريخ يفتقر لبيانات، نقوم بتوليد وحفظ بيانات محاكاة فورية للنطاق المختار
            if (campaignRows.length === 0) {
                const generated = await generateMockCampaignsForPeriod(targetPlatforms, from, to);
                return res.json(generated);
            }

            res.json(campaignRows);
        });
    });
});

// دالة توليد بيانات محاكاة وتخزينها في قاعدة البيانات لضمان الثبات للتواريخ
async function generateMockCampaignsForPeriod(platforms, fromDate, toDate) {
    const start = new Date(fromDate || '2026-05-01');
    const end = new Date(toDate || '2026-06-01');
    
    // أسماء الحملات المحاكية لكل منصة
    const campaignsConfig = {
        facebook: [
            { id: 'fb_c1', name: 'حملة الأعياد الكبرى - FB' },
            { id: 'fb_c2', name: 'إعادة استهداف زوار المتجر - FB' }
        ],
        snapchat: [
            { id: 'snap_c1', name: 'حملة فلاتر ومشاهير العيد - Snap' },
            { id: 'snap_c2', name: 'عروض خصومات الشحن - Snap' }
        ],
        tiktok: [
            { id: 'tt_c1', name: 'تحدي تريند الموضة - TikTok' },
            { id: 'tt_c2', name: 'عروض حصرية للصيف - TikTok' }
        ]
    };

    const insertedData = [];
    const dates = [];
    let curr = new Date(start);
    
    // تحديد الأيام في الفترة
    while (curr <= end) {
        dates.push(curr.toISOString().split('T')[0]);
        curr.setDate(curr.getDate() + 1);
    }

    // لتبسيط التخزين السريع، نقوم بعمل معاملات متتالية
    return new Promise((resolve) => {
        db.serialize(() => {
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO ads_campaign_metrics 
                (campaign_id, campaign_name, platform, status, spend, clicks, impressions, conversions, date) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            dates.forEach(d => {
                platforms.forEach(p => {
                    const configs = campaignsConfig[p] || [];
                    configs.forEach(c => {
                        // توليد أرقام عشوائية متسقة
                        const spend = Math.round(40 + Math.random() * 180); // 40 to 220 SAR spend per day
                        const clicks = Math.round(spend * (0.8 + Math.random() * 0.7)); // clicks based on spend
                        const impressions = clicks * Math.round(12 + Math.random() * 15); // CTR around 4-8%
                        const convRate = 0.02 + Math.random() * 0.04; // Conv rate 2% to 6%
                        const conversions = Math.max(0, Math.round(clicks * convRate));
                        const status = Math.random() > 0.15 ? 'active' : 'paused';

                        const uniqueCampId = `${c.id}_${d}`;

                        stmt.run([
                            uniqueCampId,
                            c.name,
                            p,
                            status,
                            spend,
                            clicks,
                            impressions,
                            conversions,
                            d
                        ]);

                        insertedData.push({
                            campaign_id: uniqueCampId,
                            campaign_name: c.name,
                            platform: p,
                            status,
                            spend,
                            clicks,
                            impressions,
                            conversions,
                            date: d
                        });
                    });
                });
            });

            stmt.finalize(() => {
                resolve(insertedData);
            });
        });
    });
}



// مسار جلب السلات المتروكة
app.get('/api/salla/abandoned-carts', async (req, res) => {
    const token = await getOrRefreshToken();

    if (!token) {
        return res.json(getSimulatedCarts());
    }

    try {
        const response = await axios.get('https://api.salla.dev/admin/v2/abandoned-carts', {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Accept-Language': 'ar'
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error('خطأ أثناء جلب السلات المتروكة:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'فشل جلب السلات المتروكة من سلة API' });
    }
});

// ── 2.8. مسارات إدارة الشهادات والتقارير (بلس ايفون وسناب) ──
app.get('/api/certificates', authenticateUser, (req, res) => {
    db.all("SELECT * FROM certificates ORDER BY name ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/certificates', authenticateUser, (req, res) => {
    const { name, total_subs, comp_subs, ads_spend, note } = req.body;
    if (!name) return res.status(400).json({ error: 'اسم الشهادة مطلوب.' });

    const total = parseInt(total_subs) || 0;
    const comp = parseInt(comp_subs) || 0;
    const spend = parseFloat(ads_spend) || 0;
    const updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.run(
        "INSERT INTO certificates (name, total_subs, comp_subs, ads_spend, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [name.trim(), total, comp, spend, note, updatedAt],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'اسم هذه الشهادة مسجل بالفعل.' });
                }
                return res.status(500).json({ error: err.message });
            }
            logActivity(req.user.username, 'ADD', 'certificates', `تم إضافة شهادة جديدة: ${name} (إجمالي ${total})`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/certificates/:id', authenticateUser, (req, res) => {
    const { id } = req.params;
    const { name, total_subs, sold_subs, comp_subs, ads_spend, note, status } = req.body;
    if (!name) return res.status(400).json({ error: 'اسم الشهادة مطلوب.' });

    const total = parseInt(total_subs) || 0;
    const sold = parseInt(sold_subs) || 0;
    const comp = parseInt(comp_subs) || 0;
    const spend = parseFloat(ads_spend) || 0;
    const stat = status || 'active';
    const updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.run(
        "UPDATE certificates SET name = ?, total_subs = ?, sold_subs = ?, comp_subs = ?, ads_spend = ?, note = ?, status = ?, updated_at = ? WHERE id = ?",
        [name.trim(), total, sold, comp, spend, note, stat, updatedAt, id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logActivity(req.user.username, 'UPDATE', 'certificates', `تم تعديل بيانات الشهادة: ${name} (إجمالي ${total}, تعويضات ${comp})`).catch(console.error);
            res.json({ success: true });
        }
    );
});

app.delete('/api/certificates/:id', authenticateUser, (req, res) => {
    const { id } = req.params;
    db.get("SELECT name FROM certificates WHERE id = ?", [id], (errFetch, row) => {
        const name = row ? row.name : 'غير معروف';
        db.run("DELETE FROM certificates WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logActivity(req.user.username, 'DELETE', 'certificates', `تم حذف الشهادة: ${name}`).catch(console.error);
            res.json({ success: true });
        });
    });
});

// مسار جلب تقرير الشهادة المفصل مع مبيعات سلة التلقائية
app.get('/api/certificates/report', authenticateUser, async (req, res) => {
    db.all("SELECT * FROM certificates ORDER BY name ASC", [], (err, certs) => {
        if (err) return res.status(500).json({ error: err.message });

        // جلب جميع الطلبات المستوردة لحساب المبيعات الحقيقية تلقائياً
        db.all("SELECT product_name, quantity FROM salla_imported_orders", [], (errOrders, orders) => {
            if (errOrders) return res.status(500).json({ error: errOrders.message });

            // نقوم بمطابقة اسم الشهادة مع المنتجات المباعة
            const report = certs.map(cert => {
                let sallaSales = 0;
                const searchName = cert.name.toLowerCase().trim();

                orders.forEach(o => {
                    const prodName = (o.product_name || '').toLowerCase().trim();
                    // إذا كان اسم المنتج يحتوي على اسم الشهادة أو العكس
                    if (prodName.includes(searchName) || searchName.includes(prodName)) {
                        sallaSales += o.quantity || 1;
                    }
                });

                // المتبقي الفعلي = إجمالي الاشتراكات - المبيعات - التعويضات
                const total = cert.total_subs || 0;
                const comp = cert.comp_subs || 0;
                const remaining = total - sallaSales - comp;

                return {
                    id: cert.id,
                    name: cert.name,
                    total_subs: total,
                    sold_subs: sallaSales, // المبيعات التلقائية من سلة
                    comp_subs: comp,
                    remaining: remaining,
                    ads_spend: cert.ads_spend || 0,
                    status: cert.status,
                    note: cert.note,
                    updated_at: cert.updated_at
                };
            });

            res.json(report);
        });
    });
});

// ── 3. مسارات إدارة المصروفات عبر SQLite ──

// جلب المصروفات
app.get('/api/expenses', (req, res) => {
    const cat = req.query.cat || '';
    const period = req.query.period || '';
    const descs = req.query.descs || '';
    const q = req.query.q || '';
    const sort = req.query.sort || 'desc'; // desc, asc, amt-desc, amt-asc
    const from = req.query.from || '';
    const to = req.query.to || '';

    let query = "SELECT * FROM expenses WHERE archived_in IS NULL";
    const params = [];

    if (cat) {
        query += " AND cat = ?";
        params.push(cat);
    }
    if (period) {
        query += " AND period = ?";
        params.push(period);
    }
    if (descs) {
        const descList = descs.split(',').map(d => d.trim()).filter(d => d);
        if (descList.length > 0) {
            const placeholders = descList.map(() => '?').join(',');
            query += ` AND desc IN (${placeholders})`;
            params.push(...descList);
        }
    }
    if (q) {
        query += " AND (desc LIKE ? OR note LIKE ?)";
        params.push(`%${q}%`, `%${q}%`);
    }
    if (from) {
        query += " AND date >= ?";
        params.push(from);
    }
    if (to) {
        query += " AND date <= ?";
        params.push(to);
    }

    if (sort === 'asc') query += " ORDER BY date ASC, id ASC";
    else if (sort === 'amt-desc') query += " ORDER BY amt DESC";
    else if (sort === 'amt-asc') query += " ORDER BY amt ASC";
    else query += " ORDER BY date DESC, id DESC";

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// إضافة مصروف جديد
app.post('/api/expenses', (req, res) => {
    const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period } = req.body;
    if (!desc || !cat || isNaN(amt) || !date) {
        return res.status(400).json({ error: 'يرجى تقديم كافة البيانات المطلوبة بشكل صحيح.' });
    }

    db.run(
        "INSERT INTO expenses (desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            desc,
            cat,
            parseFloat(amt),
            date,
            note || '',
            product_name || null,
            quantity ? parseInt(quantity) : null,
            purchase_price ? parseFloat(purchase_price) : null,
            selling_price ? parseFloat(selling_price) : null,
            platform_name || null,
            period || null
        ],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            logActivity(req.user.username, 'ADD', 'expenses', `تم إضافة مصروف جديد: ${desc} بقيمة ${amt} ر.س`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// تعديل مصروف
app.put('/api/expenses/:id', (req, res) => {
    const { id } = req.params;
    const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name, period } = req.body;

    db.run(
        "UPDATE expenses SET desc = ?, cat = ?, amt = ?, date = ?, note = ?, product_name = ?, quantity = ?, purchase_price = ?, selling_price = ?, platform_name = ?, period = ? WHERE id = ?",
        [
            desc,
            cat,
            parseFloat(amt),
            date,
            note || '',
            product_name || null,
            quantity ? parseInt(quantity) : null,
            purchase_price ? parseFloat(purchase_price) : null,
            selling_price ? parseFloat(selling_price) : null,
            platform_name || null,
            period || null,
            id
        ],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            logActivity(req.user.username, 'UPDATE', 'expenses', `تم تعديل المصروف: ${desc} بقيمة ${amt} ر.س`).catch(console.error);
            res.json({ success: true, changes: this.changes });
        }
    );
});

// حذف مصروف
app.delete('/api/expenses/:id', (req, res) => {
    const { id } = req.params;
    db.get("SELECT desc, amt FROM expenses WHERE id = ?", [id], (errFetch, row) => {
        const desc = row ? row.desc : 'غير معروف';
        const amt = row ? row.amt : 0;
        db.run("DELETE FROM expenses WHERE id = ?", [id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            logActivity(req.user.username, 'DELETE', 'expenses', `تم حذف المصروف: ${desc} بقيمة ${amt} ر.س`).catch(console.error);
            res.json({ success: true, changes: this.changes });
        });
    });
});

// مسار حذف وتصفير جميع المصروفات
app.post('/api/expenses/clear', (req, res) => {
    if (req.user && (req.user.role === 'employee' || req.user.role === 'games_employee')) {
        return res.status(403).json({ error: 'غير مصرح لك بهذه الصلاحية.' });
    }
    db.run("DELETE FROM expenses", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        logActivity(req.user.username, 'CLEAR', 'expenses', `تم حذف وتصفير جميع المصروفات`).catch(console.error);
        res.json({ success: true, changes: this.changes });
    });
});

// ── 3.1. مسارات تسوية وجرد المخزون يدوياً ──
app.get('/api/products/adjustments', (req, res) => {
    db.all("SELECT * FROM product_adjustments", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/products/adjustments', (req, res) => {
    const { product_name, stock_offset, cost, price } = req.body;
    if (!product_name) {
        return res.status(400).json({ error: 'يرجى تقديم اسم المنتج لإجراء الجرد.' });
    }

    db.run(
        "INSERT INTO product_adjustments (product_name, stock_offset, cost, price) VALUES (?, ?, ?, ?) ON CONFLICT(product_name) DO UPDATE SET stock_offset = ?, cost = ?, price = ?",
        [
            product_name,
            parseInt(stock_offset) || 0,
            parseFloat(cost) || 0,
            parseFloat(price) || 0,
            parseInt(stock_offset) || 0,
            parseFloat(cost) || 0,
            parseFloat(price) || 0
        ],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true });
        }
    );
});

app.post('/api/products/adjustments/bulk', (req, res) => {
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ error: 'يرجى تقديم مصفوفة منتجات صالحة.' });
    }
    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO product_adjustments (product_name, stock_offset, cost, price) 
            VALUES (?, ?, ?, ?)
        `);
        products.forEach(p => {
            stmt.run([
                String(p.product_name).trim(),
                parseInt(p.stock_offset) || 0,
                parseFloat(p.cost) || 0,
                parseFloat(p.price) || 0
            ]);
        });
        stmt.finalize((err) => {
            if (err) {
                console.error('خطأ أثناء استيراد المنتجات:', err.message);
                return res.status(500).json({ error: 'فشل حفظ المنتجات في قاعدة البيانات.' });
            }
            res.json({ success: true, count: products.length });
        });
    });
});

// ── 4. مسارات الأرشفة الشهرية (SQLite) ──

// جلب الأرشيفات
app.get('/api/archives', (req, res) => {
    db.all("SELECT key, name, month, archived_at FROM archives ORDER BY key DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// جلب تفاصيل شهر مؤرشف معين
app.get('/api/archives/:key', (req, res) => {
    const { key } = req.params;
    db.get("SELECT * FROM archives WHERE key = ?", [key], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'الأرشيف غير موجود' });
        }
        res.json({
            key: row.key,
            name: row.name,
            month: row.month,
            archived_at: row.archived_at,
            expenses: JSON.parse(row.expenses_json || '[]'),
            sales: JSON.parse(row.sales_json || '[]'),
            wallet: JSON.parse(row.wallet_json || '[]')
        });
    });
});

// أرشفة الشهر الحالي وبدء شهر جديد
app.post('/api/archives', async (req, res) => {
    const { name, month, sales_json, wallet_json } = req.body;
    if (!name || !month) {
        return res.status(400).json({ error: 'يرجى إرسال اسم الأرشيف والشهر.' });
    }

    const key = `${month}-${Date.now()}`;
    const archivedAt = new Date().toLocaleDateString('ar-SA');

    // 1. جلب كافة المصروفات غير المؤرشفة الحالية
    db.all("SELECT * FROM expenses WHERE archived_in IS NULL", [], (err, expenses) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const expensesJson = JSON.stringify(expenses);

        db.serialize(() => {
            // 2. إدخال الأرشيف
            db.run(
                "INSERT INTO archives (key, name, month, archived_at, expenses_json, sales_json, wallet_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [key, name, month, archivedAt, expensesJson, sales_json || '[]', wallet_json || '[]'],
                function (err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }

                    // 3. تعليم المصروفات الحالية كمؤرشفة (أو حذفها)
                    db.run("UPDATE expenses SET archived_in = ? WHERE archived_in IS NULL", [key], (err) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        res.json({ success: true, key });
                    });
                }
            );
        });
    });
});

// حذف أرشيف شهري معين
app.delete('/api/archives/:key', (req, res) => {
    const { key } = req.params;
    db.run("DELETE FROM archives WHERE key = ?", [key], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// ── 5. دوال محاكاة البيانات عند العمل في نمط الأوفلاين (Simulated Fallback Mode) ──

function getSimulatedOrders(page, perPage, status, products, sort, minAmt, maxAmt, q, from, to) {
    const all = [
        {id:238527512,reference_id:263108285,date:{date:"2026-05-29 23:25:41"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس ايفون - الباقة الذهبية',thumbnail:'https://cdn.salla.sa/aevBBK/e30803cb-7c60-4245-ac70-ca04d355a963-500x500-1hYysBKrG0KI1CXvnyO94wNMkeT9m4bSoC6PnJjd.webp'}],customer:{full_name:'حاتم'},payment_actions:{refund_action:{paid_amount:{amount:27,currency:'SAR'}}}},
        {id:923976324,reference_id:263107617,date:{date:"2026-05-28 23:20:36"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس اساسي PS5',thumbnail:'https://cdn.salla.sa/aevBBK/4a0e123c-3634-44d4-bad7-4192754380b7-500x500-Vi0fjX27pFXRikUZE3UFBiqaH07RGOOraeAR3ilH.jpg'}],customer:{full_name:'عبدالله الدوسري'},payment_actions:{refund_action:{paid_amount:{amount:45,currency:'SAR'}}}},
        {id:2048644699,reference_id:263102976,date:{date:"2026-05-26 22:47:30"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'credit_card',items:[{name:'سناب بلس - شهر',thumbnail:'https://cdn.salla.sa/aevBBK/7c480e03-ab70-4b96-8365-6d311cf34344-500x500-f2QcPwvJMbeYBhM9yV1KtGqpFsI2ENSDsFgVWAJg.png'}],customer:{full_name:'وسيم وسيم'},payment_actions:{refund_action:{paid_amount:{amount:45.77,currency:'SAR'}}}},
        {id:723076182,reference_id:263102707,date:{date:"2026-05-24 22:45:34"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'credit_card',items:[{name:'فيفا26|fc26 ps4',thumbnail:'https://cdn.salla.sa/aevBBK/a30d1378-5508-478d-9369-91c119feb7c7-500x500-m3pxhtdBoiaMZWQpA0qPAjaM5Gk5Ya9zUtrv2K7x.jpg'}],customer:{full_name:'Adel Alabri99'},payment_actions:{refund_action:{paid_amount:{amount:55.43,currency:'SAR'}}}},
        {id:1230701957,reference_id:263098402,date:{date:"2026-05-22 22:13:20"},status:{slug:'under_review',name:'بإنتظار المراجعة',customized:{name:'بإنتظار المراجعة'}},payment_method:'credit_card',items:[{name:'بلاك اوبس 7 - سوني 4',thumbnail:'https://cdn.salla.sa/aevBBK/571da687-8b2d-44a5-a402-6f6a5c16a71d-500x500-FUzApFVew08KJdpDadUL3x4m1rUsMeU0Kcmgt9Cr.png'}],customer:{full_name:'Adel Alabri99'},payment_actions:{refund_action:{paid_amount:{amount:30.22,currency:'SAR'}}}},
        {id:713625855,reference_id:263097180,date:{date:"2026-05-20 22:04:32"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'apple_pay',items:[{name:'بلس ايفون - الباقة الذهبية',thumbnail:'https://cdn.salla.sa/aevBBK/e30803cb-7c60-4245-ac70-ca04d355a963-500x500-1hYysBKrG0KI1CXvnyO94wNMkeT9m4bSoC6PnJjd.webp'}],customer:{full_name:'الفيفي'},payment_actions:{refund_action:{paid_amount:{amount:27,currency:'SAR'}}}},
        {id:727474169,reference_id:263096926,date:{date:"2026-05-18 22:02:34"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس اساسي PS4',thumbnail:'https://cdn.salla.sa/aevBBK/0de748fc-4c33-4ee8-ab8c-d546c42a8f8c-500x500-zlSKi88SOBfNnpoidtWwookbe73QlbXz5ZGTzj72.jpg'}],customer:{full_name:'K L'},payment_actions:{refund_action:{paid_amount:{amount:10,currency:'SAR'}}}},
        {id:209539321,reference_id:263096670,date:{date:"2026-05-16 22:00:30"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس اضافي PS5',thumbnail:'https://cdn.salla.sa/aevBBK/050a315c-b4e5-4743-99cc-9db67ab7ad8a-500x500-PvaiV5QzU34s1sTdnnKyaCu26hTn1Zxzs7Z6gXPu.jpg'}],customer:{full_name:'محمد السيافي'},payment_actions:{refund_action:{paid_amount:{amount:187,currency:'SAR'}}}},
        {id:1539198673,reference_id:263095158,date:{date:"2026-05-14 21:49:05"},status:{slug:'payment_pending',name:'بإنتظار الدفع',customized:{name:'بإنتظار الدفع'}},payment_method:'waiting',items:[{name:'بلس اساسي PS5',thumbnail:'https://cdn.salla.sa/aevBBK/4a0e123c-3634-44d4-bad7-4192754380b7-500x500-Vi0fjX27pFXRikUZE3UFBiqaH07RGOOraeAR3ilH.jpg'}],customer:{full_name:'عبدالله طه'},payment_actions:{refund_action:{paid_amount:{amount:0,currency:'SAR'}}}},
        {id:1811529377,reference_id:263095046,date:{date:"2026-05-12 21:48:14"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس اضافي PS4',thumbnail:'https://cdn.salla.sa/aevBBK/486f8187-68c5-4896-844a-46a6551d2a0b-500x500-JYttg3Ftb1XucoCTzlJIzqS1fU8ZAAPI2kSS0CMz.jpg'}],customer:{full_name:'Mohammed Husham'},payment_actions:{refund_action:{paid_amount:{amount:15,currency:'SAR'}}}},
        {id:1588866462,reference_id:263094075,date:{date:"2026-05-10 21:41:22"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس اساسي PS4'}],customer:{full_name:'Abdulaziz Alzahrani'},payment_actions:{refund_action:{paid_amount:{amount:25,currency:'SAR'}}}},
        {id:1103111217,reference_id:263093654,date:{date:"2026-05-08 21:38:25"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس ايفون - الباقة الذهبية',thumbnail:'https://cdn.salla.sa/aevBBK/e30803cb-7c60-4245-ac70-ca04d355a963-500x500-1hYysBKrG0KI1CXvnyO94wNMkeT9m4bSoC6PnJjd.webp'}],customer:{full_name:'وليد الحجوري'},payment_actions:{refund_action:{paid_amount:{amount:27,currency:'SAR'}}}},
        {id:593136132,reference_id:263093409,date:{date:"2026-05-06 21:36:50"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس اساسي PS4'}],customer:{full_name:'ياسين التهامي'},payment_actions:{refund_action:{paid_amount:{amount:10,currency:'SAR'}}}},
        {id:1066952738,reference_id:263092359,date:{date:"2026-05-04 21:29:40"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'stc_pay',items:[{name:'بلس ايفون - الباقة الذهبية',thumbnail:'https://cdn.salla.sa/aevBBK/e30803cb-7c60-4245-ac70-ca04d355a963-500x500-1hYysBKrG0KI1CXvnyO94wNMkeT9m4bSoC6PnJjd.webp'}],customer:{full_name:'علي عبد الحميد'},payment_actions:{refund_action:{paid_amount:{amount:27,currency:'SAR'}}}},
        {id:1286473660,reference_id:263091993,date:{date:"2026-05-02 21:26:55"},status:{slug:'completed',name:'تم التنفيذ',customized:{name:'تم التنفيذ'}},payment_method:'mada',items:[{name:'بلس اضافي PS5',thumbnail:'https://cdn.salla.sa/aevBBK/050a315c-b4e5-4743-99cc-9db67ab7ad8a-500x500-PvaiV5QzU34s1sTdnnKyaCu26hTn1Zxzs7Z6gXPu.jpg'}],customer:{full_name:'محمد القرني'},payment_actions:{refund_action:{paid_amount:{amount:187,currency:'SAR'}}}}
    ];

    let filtered = all.filter(o => {
        const amt = o.payment_actions?.refund_action?.paid_amount?.amount ?? o.total?.amount ?? 0;
        if (status) {
            const statusList = status.split(',').map(s => s.trim()).filter(s => s);
            if (statusList.length > 0 && !statusList.includes(o.status.slug)) {
                return false;
            }
        }
        if (products) {
            const prodList = products.split(',').map(p => p.trim()).filter(p => p);
            if (prodList.length > 0) {
                const matches = o.items.some(it => prodList.includes(it.name));
                if (!matches) return false;
            }
        }
        if (minAmt && amt < parseFloat(minAmt)) return false;
        if (maxAmt && amt > parseFloat(maxAmt)) return false;
        if (q) {
            const matchesCust = o.customer.full_name.includes(q);
            const matchesProd = o.items.some(it => it.name.includes(q));
            if (!matchesCust && !matchesProd) return false;
        }
        const oDate = o.date.date.substring(0, 10);
        if (from && oDate < from) return false;
        if (to && oDate > to) return false;
        return true;
    });

    if (sort === 'asc') {
        filtered.sort((a, b) => a.date.date.localeCompare(b.date.date) || a.id - b.id);
    } else if (sort === 'amt-desc') {
        filtered.sort((a, b) => {
            const amtA = a.payment_actions?.refund_action?.paid_amount?.amount ?? a.total?.amount ?? 0;
            const amtB = b.payment_actions?.refund_action?.paid_amount?.amount ?? b.total?.amount ?? 0;
            return amtB - amtA;
        });
    } else if (sort === 'amt-asc') {
        filtered.sort((a, b) => {
            const amtA = a.payment_actions?.refund_action?.paid_amount?.amount ?? a.total?.amount ?? 0;
            const amtB = b.payment_actions?.refund_action?.paid_amount?.amount ?? b.total?.amount ?? 0;
            return amtA - amtB;
        });
    } else {
        filtered.sort((a, b) => b.date.date.localeCompare(a.date.date) || b.id - a.id);
    }

    const total = filtered.length;
    const startIndex = (page - 1) * perPage;
    const paginated = filtered.slice(startIndex, startIndex + parseInt(perPage));

    return {
        data: paginated,
        pagination: {
            total,
            count: paginated.length,
            per_page: perPage,
            current_page: page,
            total_pages: Math.ceil(total / perPage) || 1
        }
    };
}

function getSimulatedCarts() {
    return {
        data: [
            { id: 1, customer: { full_name: 'أحمد محمد', email: 'ahmad@gmail.com' }, items: [{ name: 'بلس ايفون - ذهبية', quantity: 1 }], total: { amount: 27 }, created_at: '2026-05-30 14:02:00' },
            { id: 2, customer: { full_name: 'خالد العتيبي', email: 'khaled@gmail.com' }, items: [{ name: 'سناب بلس شهر', quantity: 2 }], total: { amount: 54 }, created_at: '2026-05-30 11:32:00' },
            { id: 3, customer: { full_name: 'فهد الشمري', email: 'fahad@gmail.com' }, items: [{ name: 'بلس اضافي PS5', quantity: 1 }], total: { amount: 187 }, created_at: '2026-05-29 18:21:00' },
            { id: 4, customer: { full_name: 'عبدالرحمن سالم', email: 'salem@gmail.com' }, items: [{ name: 'كود سناب max شهر', quantity: 3 }], total: { amount: 75 }, created_at: '2026-05-29 09:12:00' },
            { id: 5, customer: { full_name: 'ماجد القحطاني', email: 'majed@gmail.com' }, items: [{ name: 'بلس اساسي PS5', quantity: 1 }], total: { amount: 45 }, created_at: '2026-05-28 20:02:00' },
            { id: 6, customer: { full_name: 'سلطان الغامدي', email: 'soltan@gmail.com' }, items: [{ name: 'بلس ايفون فضية', quantity: 2 }], total: { amount: 24 }, created_at: '2026-05-28 15:45:00' },
            { id: 7, customer: { full_name: 'Turki Alharbi', email: 'turki@gmail.com' }, items: [{ name: 'فيفا 26 PS5', quantity: 1 }], total: { amount: 95 }, created_at: '2026-05-27 12:30:00' },
            { id: 8, customer: { full_name: 'نورة العصيمي', email: 'noura@gmail.com' }, items: [{ name: 'كانفا برو', quantity: 1 }], total: { amount: 5 }, created_at: '2026-05-27 08:15:00' }
        ],
        summary: {
            total_count: 1053,
            total_value: 3869.5 * 20
        }
    };
}

// ══════════════════════════════════════════════
//  تفعيل خادم Model Context Protocol (MCP) لـ Claude AI
// ══════════════════════════════════════════════

const mcpSessions = new Map();

// مسار استقبال اتصال الـ SSE لبدء جلسة MCP
app.get('/mcp', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // يمنع Nginx من تخزين الأحداث مؤقتاً لتمرير المزامنة فورياً
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
    });
    
    const sessionId = Math.random().toString(36).substring(2, 15);
    console.log(`[MCP] New Claude AI session established: ${sessionId}`);
    
    // حفظ الجلسة
    mcpSessions.set(sessionId, res);
    
    // إرسال حدث endpoint لتعريف العميل بمسار الـ POST كامل ومطلق لتجنب مشاكل التوجيه
    res.write(`event: endpoint\ndata: https://shop.nuzum.sbs/api/mcp?sessionId=${sessionId}\n\n`);
    
    req.on('close', () => {
        console.log(`[MCP] Claude session closed: ${sessionId}`);
        mcpSessions.delete(sessionId);
    });
});

// مسار استقبال ومعالجة رسائل الـ JSON-RPC من العميل (يدعم كلاً من SSE و Direct HTTP POST)
app.post(['/api/mcp', '/mcp'], express.json(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');

    const { sessionId } = req.query;
    const message = req.body;
    const { jsonrpc, id, method, params } = message;
    
    console.log(`[MCP] Request from Claude [Session ${sessionId || 'Sync-Direct'}]:`, method);
    
    let result = null;
    let error = null;
    
    if (method === 'initialize') {
        result = {
            protocolVersion: '2024-11-05',
            capabilities: {
                tools: {}
            },
            serverInfo: {
                name: 'shopdashboard-mcp',
                version: '1.1.0'
            }
        };
    } else if (method === 'tools/list') {
        result = {
            tools: [
                {
                    name: 'get_financial_summary',
                    description: 'جلب الملخص المالي الكامل للمتجر من مبيعات سلة والمصروفات وصافي الأرباح والعمليات المالية',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'get_inventory_status',
                    description: 'جلب جرد المخزون وحالته الفعلية والقطع المشتراة والمباعة وتكلفة القطع وإيراداتها المالية لكل منتج',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'get_expenses_list',
                    description: 'جلب قائمة المصروفات الكاملة المسجلة بالنظام (تشمل الرواتب، التسويق، شراء المنتجات، الفترات للاشتراكات وغيرها)',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'trigger_salla_sync',
                    description: 'طلب بدء مزامنة مبيعات فورية وجلب أحدث طلبات متجر سلة الفعلي إلى قاعدة البيانات المحلية',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'adjust_product_inventory',
                    description: 'تعديل وتحديث لوحة المخزون وجرد منتج معين يدوياً (تعديل رصيد التسوية/الجرد، سعر تكلفة الشراء، وسعر البيع)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            product_name: {
                                type: 'string',
                                description: 'اسم المنتج المراد تعديل بيانات مخزونه وجرده يدوياً'
                            },
                            stock_offset: {
                                type: 'number',
                                description: 'رصيد التسوية أو الجرد الافتتاحي للمخزون (مثال: +10 لزيادة المخزون يدوياً أو -5 لتسجيل عجز)'
                            },
                            cost: {
                                type: 'number',
                                description: 'سعر تكلفة الشراء المخصصة للقطعة الواحدة'
                            },
                            price: {
                                type: 'number',
                                description: 'سعر البيع المقدر أو المخصص للقطعة الواحدة'
                            }
                        },
                        required: ['product_name']
                    }
                },
                {
                    name: 'get_campaigns_metrics',
                    description: 'جلب إحصاءات حملات التسويق الإعلانية النشطة والسابقة (فيس بوك، سناب شات، تيك توك) وتفاصيل أدائها مثل الإنفاق، الظهور، الضغطات، المبيعات المنسوبة، والـ ROAS لكل حملة على حدة',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                }
            ]
        };
    } else if (method === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        
        try {
            const toolResult = await handleToolCall(toolName, toolArgs);
            const response = {
                jsonrpc: '2.0',
                id,
                result: toolResult
            };
            
            // إرسال في البث المباشر (SSE) إذا كان متوفراً
            if (sessionId) {
                const sseRes = mcpSessions.get(sessionId);
                if (sseRes) {
                    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
                }
            }
            
            // أيضاً نرجع الرد فورياً في جسم الطلب لتوافقية 100%
            return res.status(200).json(response);
        } catch (err) {
            const response = {
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message: err.message }
            };
            if (sessionId) {
                const sseRes = mcpSessions.get(sessionId);
                if (sseRes) {
                    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
                }
            }
            return res.status(200).json(response);
        }
    } else {
        error = { code: -32601, message: `Method not found: ${method}` };
    }
    
    const response = {
        jsonrpc: '2.0',
        id
    };
    if (result) response.result = result;
    if (error) response.error = error;
    
    // إرسال الرد المتزامن في جسم الطلب
    res.status(200).json(response);
    
    // إرسال الرد في خط البث (SSE) إذا كان متوفراً
    if (sessionId) {
        const sseRes = mcpSessions.get(sessionId);
        if (sseRes) {
            sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        }
    }
});

// دالة معالجة تفاصيل الأدوات وجلب البيانات من SQLite
async function handleToolCall(name, args) {
    return new Promise((resolve, reject) => {
        if (name === 'get_financial_summary') {
            db.all("SELECT * FROM expenses", [], (errExp, expenses) => {
                if (errExp) return reject(errExp);
                db.all("SELECT * FROM salla_imported_orders", [], (errSales, sales) => {
                    if (errSales) return reject(errSales);
                    db.all("SELECT * FROM salla_imported_wallet", [], (errWallet, wallet) => {
                        if (errWallet) return reject(errWallet);
                        db.all("SELECT * FROM ads_campaign_metrics", [], (errAds, ads) => {
                            if (errAds) return reject(errAds);
                            
                            const totalExpenses = expenses.reduce((s, e) => s + (e.amt || 0), 0);
                            const totalRevenue = sales.reduce((s, o) => s + (o.amount || 0), 0);
                            const totalAdSpend = ads ? ads.reduce((s, a) => s + (a.spend || 0), 0) : 0;
                            const netProfit = totalRevenue - totalExpenses;
                            
                            resolve({
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            store_name: "شوب ستور - لوحة تحكم المحاسبة الذكية",
                                            total_revenue_sar: totalRevenue,
                                            total_expenses_sar: totalExpenses,
                                            total_ad_spend_sar: totalAdSpend,
                                            net_profit_sar: netProfit,
                                            wallet_total_operations: wallet.length,
                                            orders_count: sales.length,
                                            campaigns_count: ads ? ads.length : 0
                                        }, null, 2)
                                    }
                                ]
                            });
                        });
                    });
                });
            });
        } else if (name === 'get_inventory_status') {
            db.all("SELECT * FROM expenses", [], (errExp, expenses) => {
                if (errExp) return reject(errExp);
                db.all("SELECT * FROM salla_imported_orders", [], (errSales, sales) => {
                    if (errSales) return reject(errSales);
                    db.all("SELECT * FROM product_adjustments", [], (errAdj, adjustments) => {
                        if (errAdj) return reject(errAdj);
                        
                        const map = {};
                        sales.forEach(o => {
                            const prodName = (o.product_name || 'غير معروف').trim();
                            if (!map[prodName]) {
                                map[prodName] = { name: prodName, sold: 0, revenue: 0, purchased: 0, cost: 0 };
                            }
                            map[prodName].sold += o.quantity || 1;
                            map[prodName].revenue += o.amount || 0;
                        });
                        
                        expenses.forEach(e => {
                            if (e.cat === 'شراء منتجات' && e.product_name) {
                                const prodName = e.product_name.trim();
                                if (!map[prodName]) {
                                    map[prodName] = { name: prodName, sold: 0, revenue: 0, purchased: 0, cost: 0 };
                                }
                                map[prodName].purchased += e.quantity || 0;
                                if (e.purchase_price) map[prodName].cost = e.purchase_price;
                            }
                        });
                        
                        adjustments.forEach(a => {
                            const prodName = (a.product_name || '').trim();
                            if (!map[prodName]) {
                                map[prodName] = { name: prodName, sold: 0, revenue: 0, purchased: 0, cost: 0 };
                            }
                            if (a.cost > 0) map[prodName].cost = a.cost;
                        });
                        
                        const inventory = Object.values(map).map(p => {
                            const adj = adjustments.find(a => a.product_name === p.name) || { stock_offset: 0 };
                            const stock = p.purchased - p.sold + adj.stock_offset;
                            return {
                                product_name: p.name,
                                quantity_purchased: p.purchased,
                                quantity_sold: p.sold,
                                remaining_stock: stock,
                                unit_cost_sar: p.cost,
                                total_revenue_sar: p.revenue
                            };
                        });
                        
                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(inventory, null, 2)
                                }
                            ]
                        });
                    });
                });
            });
        } else if (name === 'get_campaigns_metrics') {
            db.all("SELECT * FROM ads_campaign_metrics ORDER BY date DESC", [], (err, rows) => {
                if (err) return reject(err);
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(rows, null, 2)
                        }
                    ]
                });
            });
        } else if (name === 'get_expenses_list') {
            db.all("SELECT * FROM expenses ORDER BY date DESC", [], (err, rows) => {
                if (err) return reject(err);
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(rows.map(e => ({
                                desc: e.desc,
                                cat: e.cat,
                                amt: e.amt,
                                date: e.date,
                                note: e.note,
                                product_name: e.product_name,
                                quantity: e.quantity,
                                period: e.period
                            })), null, 2)
                        }
                    ]
                });
            });
        } else if (name === 'trigger_salla_sync') {
            syncSallaOrdersToLocal(true)
                .then(count => {
                    resolve({
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({ success: true, message: `تمت المزامنة بنجاح: تم سحب ومزامنة ${count} سجل مبيعات من سلة` })
                            }
                        ]
                    });
                })
                .catch(err => {
                    if (err.message === 'SALLA_NOT_CONNECTED') {
                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: false,
                                        error: "متجر سلة غير متصل باللوحة حالياً عبر الـ OAuth في خادم الويب (SQLite empty config).",
                                        solution: "يجب على التاجر الدخول إلى لوحة التحكم بالمتصفح (https://shop.nuzum.sbs) ونقر شارة '🔌 اضغط لربط سلة (OAuth)' في الشريط العلوي لتسجيل الدخول الفعلي وتفويض التطبيق بسحب مبيعاته. بعد إتمام هذه الخطوة، ستعمل المزامنة المباشرة وتسحب كافة الطلبات تلقائياً."
                                    }, null, 2)
                                }
                            ]
                        });
                    } else {
                        reject(err);
                    }
                });
        } else if (name === 'adjust_product_inventory') {
            const { product_name, stock_offset, cost, price } = args;
            if (!product_name) {
                return reject(new Error('product_name is required'));
            }
            
            db.get("SELECT * FROM product_adjustments WHERE product_name = ?", [product_name.trim()], (err, row) => {
                if (err) return reject(err);
                
                const finalOffset = stock_offset !== undefined ? parseInt(stock_offset) : (row ? row.stock_offset : 0);
                const finalCost = cost !== undefined ? parseFloat(cost) : (row ? row.cost : 0);
                const finalPrice = price !== undefined ? parseFloat(price) : (row ? row.price : 0);
                
                db.run(
                    "INSERT INTO product_adjustments (product_name, stock_offset, cost, price) VALUES (?, ?, ?, ?) ON CONFLICT(product_name) DO UPDATE SET stock_offset = ?, cost = ?, price = ?",
                    [product_name.trim(), finalOffset, finalCost, finalPrice, finalOffset, finalCost, finalPrice],
                    function(errRun) {
                        if (errRun) return reject(errRun);
                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        message: `تم تحديث بيانات ومخزون المنتج "${product_name}" بنجاح في قاعدة البيانات ولوحة المخزون!`,
                                        product_name,
                                        stock_offset: finalOffset,
                                        cost: finalCost,
                                        price: finalPrice
                                    }, null, 2)
                                }
                            ]
                        });
                    }
                );
            });
        } else {
            reject(new Error(`Unknown tool: ${name}`));
        }
    });
}

// ── 3.1. مسارات إدارة مخزون حسابات بلايستيشن بلس ──
app.get('/api/ps-plus/accounts', authenticateUser, (req, res) => {
    db.all("SELECT * FROM ps_plus_accounts ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/ps-plus/accounts', authenticateUser, (req, res) => {
    const { email, password, plus_type, plus_duration } = req.body;
    if (!email || !password || !plus_type || !plus_duration) {
        return res.status(400).json({ error: 'جميع الحقول (الإيميل، الباسورد، نوع البلس، مدة الاشتراك) مطلوبة.' });
    }

    const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.run(
        "INSERT INTO ps_plus_accounts (email, password, plus_type, plus_duration, created_at) VALUES (?, ?, ?, ?, ?)",
        [email.trim(), password.trim(), plus_type.trim(), plus_duration.trim(), createdAt],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'هذا الإيميل مسجل بالفعل في حسابات بلس.' });
                }
                return res.status(500).json({ error: err.message });
            }
            logActivity(req.user.username, 'ADD', 'ps_plus', `تم إضافة حساب بلس جديد: ${email} (بلس ${plus_type} ${plus_duration})`).catch(console.error);
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/ps-plus/accounts/:id', authenticateUser, (req, res) => {
    const { id } = req.params;
    const { email, password, plus_type, plus_duration, ps5_1_order, ps5_2_order, ps4_order } = req.body;
    if (!email || !password || !plus_type || !plus_duration) {
        return res.status(400).json({ error: 'جميع الحقول مطلوبة لتحديث البيانات.' });
    }

    const o51 = ps5_1_order ? ps5_1_order.trim() : '';
    const o52 = ps5_2_order ? ps5_2_order.trim() : '';
    const o4 = ps4_order ? ps4_order.trim() : '';

    const s51 = o51 ? 'delivered' : 'available';
    const s52 = o52 ? 'delivered' : 'available';
    const s4 = o4 ? 'delivered' : 'available';

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
            ps4_status = ? 
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
            id
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logActivity(req.user.username, 'UPDATE', 'ps_plus', `تم تحديث بيانات حساب بلس: ${email} (بلس ${plus_type} ${plus_duration})`).catch(console.error);
            res.json({ success: true });
        }
    );
});

app.delete('/api/ps-plus/accounts/:id', authenticateUser, (req, res) => {
    const { id } = req.params;
    db.get("SELECT email, plus_type, plus_duration FROM ps_plus_accounts WHERE id = ?", [id], (errFetch, row) => {
        const email = row ? row.email : 'غير معروف';
        const type = row ? row.plus_type : '';
        const duration = row ? row.plus_duration : '';
        db.run("DELETE FROM ps_plus_accounts WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logActivity(req.user.username, 'DELETE', 'ps_plus', `تم حذف حساب بلس: ${email} (بلس ${type} ${duration})`).catch(console.error);
            res.json({ success: true });
        });
    });
});

app.post('/api/ps-plus/accounts/deliver', authenticateUser, (req, res) => {
    const { id, slot, order_id, phone } = req.body;
    if (!id || !slot || !order_id) {
        return res.status(400).json({ error: 'معرف الحساب، النسخة المراد تسليمها، ورقم الطلب مطلوبة.' });
    }

    if (!['ps5_1', 'ps5_2', 'ps4'].includes(slot)) {
        return res.status(400).json({ error: 'النسخة المحددة غير صالحة.' });
    }

    const orderClean = order_id.trim();

    // التحقق من عدم تكرار رقم الطلب في أي مكان بالجدول
    db.get(
        "SELECT id, email FROM ps_plus_accounts WHERE ps5_1_order = ? OR ps5_2_order = ? OR ps4_order = ?",
        [orderClean],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row) {
                return res.status(400).json({ error: `رقم الطلب هذا تم استخدامه مسبقاً لتسليم الحساب (${row.email}). لا يمكن تكراره.` });
            }

            // تنفيذ التحديث
            const query = `UPDATE ps_plus_accounts SET ${slot}_order = ?, ${slot}_phone = ?, ${slot}_status = 'delivered' WHERE id = ?`;
            db.run(query, [orderClean, phone ? phone.trim() : '', id], function(errUpdate) {
                if (errUpdate) return res.status(500).json({ error: errUpdate.message });
                db.get("SELECT email, plus_type, plus_duration FROM ps_plus_accounts WHERE id = ?", [id], (errGet, accountRow) => {
                    const email = accountRow ? accountRow.email : 'غير معروف';
                    const type = accountRow ? accountRow.plus_type : '';
                    const duration = accountRow ? accountRow.plus_duration : '';
                    const slotName = slot === 'ps4' ? 'PS4' : 'PS5';
                    logActivity(req.user.username, 'DELIVER', 'ps_plus', `تم تسليم نسخة ${slotName} من حساب بلس ${type} (${duration}) ${email} للطلب رقم: ${orderClean}`).catch(console.error);
                });
                res.json({ success: true });
            });
        }
    );
});

app.post('/api/ps-plus/accounts/bulk', authenticateUser, (req, res) => {
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
            `INSERT INTO ps_plus_accounts (email, password, plus_type, plus_duration, created_at) 
             VALUES (?, ?, ?, ?, ?) 
             ON CONFLICT(email) DO UPDATE SET 
                password = excluded.password, 
                plus_type = excluded.plus_type, 
                plus_duration = excluded.plus_duration`
        );
        
        for (const account of accounts) {
            const { email, password, plus_type, plus_duration } = account;
            if (!email || !password || !plus_type || !plus_duration) continue;
            
            stmt.run([email.trim(), password.trim(), plus_type.trim(), plus_duration.trim(), createdAt], function(err) {
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
            logActivity(req.user.username, 'IMPORT', 'ps_plus', `تم استيراد/تحديث ${count} حساب بلس من ملف Excel`).catch(console.error);
            res.json({ success: true, count });
        });
    });
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 خادم محاسبة سلة يعمل بنجاح!`);
    console.log(`🔗 الرابط المحلي: http://localhost:${PORT}`);
    console.log(`=================================================`);
});
