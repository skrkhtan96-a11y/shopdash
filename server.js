require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { db, getConfig, setConfig, deleteConfig, hashPassword, verifyPassword } = require('./database');

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

// Protect all API routes starting with /api (excluding /api/auth/)
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.originalUrl.startsWith('/api/auth/')) {
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
                res.json({ success: true });
            }
        );
    } else {
        db.run(
            "UPDATE users SET role = ?, username = ?, email = ? WHERE id = ?",
            [role, username.trim(), email.trim().toLowerCase(), id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
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
    
    db.run("DELETE FROM users WHERE id = ?", [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
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
    const q = req.query.q || '';
    const from = req.query.from || '';
    const to = req.query.to || '';

    const token = await getOrRefreshToken();

    // إذا لم يكن هناك اتصال حقيقي، نتحقق أولاً من المبيعات المستوردة في قاعدة البيانات
    if (!token) {
        db.get("SELECT COUNT(*) as count FROM salla_imported_orders", [], (err, countRow) => {
            if (!err && countRow && countRow.count > 0) {
                // لدينا بيانات مستوردة حقيقية! نقوم بجلبها وتصفيتها
                let query = "SELECT * FROM salla_imported_orders WHERE 1=1";
                const params = [];

                if (status) {
                    query += " AND status_slug = ?";
                    params.push(status);
                }
                if (q) {
                    query += " AND (customer_name LIKE ? OR product_name LIKE ? OR reference_id LIKE ?)";
                    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
                }
                if (from) {
                    query += " AND date >= ?";
                    params.push(from);
                }
                if (to) {
                    query += " AND date <= ?";
                    params.push(to);
                }

                // ترتيب افتراضي بالتاريخ الأحدث أولاً
                query += " ORDER BY date DESC, id DESC";

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
                return res.json(getSimulatedOrders(page, perPage, status, q, from, to));
            }
        });
        return;
    }

    try {
        let url = `https://api.salla.dev/admin/v2/orders?page=${page}&per_page=${perPage}`;
        if (status) url += `&status=${status}`;
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
    const tables = ['expenses', 'archives', 'salla_imported_orders', 'salla_imported_wallet', 'product_adjustments'];
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

// ── 3. مسارات إدارة المصروفات عبر SQLite ──

// جلب المصروفات
app.get('/api/expenses', (req, res) => {
    const cat = req.query.cat || '';
    const q = req.query.q || '';
    const sort = req.query.sort || 'desc'; // desc, asc, amt-desc, amt-asc

    let query = "SELECT * FROM expenses WHERE archived_in IS NULL";
    const params = [];

    if (cat) {
        query += " AND cat = ?";
        params.push(cat);
    }
    if (q) {
        query += " AND desc LIKE ?";
        params.push(`%${q}%`);
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
    const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name } = req.body;
    if (!desc || !cat || isNaN(amt) || !date) {
        return res.status(400).json({ error: 'يرجى تقديم كافة البيانات المطلوبة بشكل صحيح.' });
    }

    db.run(
        "INSERT INTO expenses (desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            platform_name || null
        ],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

// تعديل مصروف
app.put('/api/expenses/:id', (req, res) => {
    const { id } = req.params;
    const { desc, cat, amt, date, note, product_name, quantity, purchase_price, selling_price, platform_name } = req.body;

    db.run(
        "UPDATE expenses SET desc = ?, cat = ?, amt = ?, date = ?, note = ?, product_name = ?, quantity = ?, purchase_price = ?, selling_price = ?, platform_name = ? WHERE id = ?",
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
            id
        ],
        function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, changes: this.changes });
        }
    );
});

// حذف مصروف
app.delete('/api/expenses/:id', (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM expenses WHERE id = ?", [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// مسار حذف وتصفير جميع المصروفات
app.post('/api/expenses/clear', (req, res) => {
    if (req.user && req.user.role === 'employee') {
        return res.status(403).json({ error: 'غير مصرح لك بهذه الصلاحية.' });
    }
    db.run("DELETE FROM expenses", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
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

function getSimulatedOrders(page, perPage, status, q, from, to) {
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
        if (status && o.status.slug !== status) return false;
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

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 خادم محاسبة سلة يعمل بنجاح!`);
    console.log(`🔗 الرابط المحلي: http://localhost:${PORT}`);
    console.log(`=================================================`);
});
