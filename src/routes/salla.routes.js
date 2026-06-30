const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const db = require('../config/db');
const ConfigRepository = require('../repositories/config.repository');
const SallaService = require('../services/salla.service');
const { authenticateUser, requireRole } = require('../middlewares/auth');

const SALLA_AUTH_URL = 'https://accounts.salla.sa/oauth2/auth';
const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

// Helper for simulated login/credentials
function hasRealSallaCredentials() {
    return process.env.SALLA_CLIENT_ID && 
           process.env.SALLA_CLIENT_ID !== 'PLACEHOLDER_CLIENT_ID' &&
           process.env.SALLA_CLIENT_SECRET && 
           process.env.SALLA_CLIENT_SECRET !== 'PLACEHOLDER_CLIENT_SECRET';
}

// 1. Salla OAuth auth redirect (mounted at /auth in server.js but we will handle it)
router.get('/auth-redirect', (req, res) => {
    if (!hasRealSallaCredentials()) {
        return res.redirect('/?simulated_login=true');
    }
    const scopes = 'offline_access';
    const stateParam = crypto.randomBytes(16).toString('hex');
    
    // Save state in secure, HttpOnly cookie to verify it in the callback step
    res.cookie('salla_oauth_state', stateParam, {
        maxAge: 10 * 60 * 1000, // 10 minutes
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
    });

    const authUrl = `${SALLA_AUTH_URL}?response_type=code&client_id=${process.env.SALLA_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.SALLA_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${stateParam}`;
    res.redirect(authUrl);
});

// 2. Salla OAuth callback (mounted at /callback in server.js but we can handle it)
router.get('/callback-handler', async (req, res) => {
    const { code, state, error } = req.query;
    const cookieState = req.cookies.salla_oauth_state;

    // Clear state cookie immediately
    res.clearCookie('salla_oauth_state');

    if (error) {
        console.error('خطأ من سلة أثناء التصريح:', error);
        return res.redirect('/?error=auth_denied');
    }

    // CSRF Protection validation
    if (hasRealSallaCredentials()) {
        if (!state || !cookieState || state !== cookieState) {
            console.error('فشل التحقق من معامل الحالة OAuth State. هجوم CSRF محتمل.');
            return res.redirect('/?error=csrf_validation_failed');
        }
    }

    try {
        const params = new URLSearchParams();
        params.append('client_id', process.env.SALLA_CLIENT_ID);
        params.append('client_secret', process.env.SALLA_CLIENT_SECRET);
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', process.env.SALLA_REDIRECT_URI);

        const response = await axios.post(SALLA_TOKEN_URL, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const { access_token, refresh_token, expires_in } = response.data;
        const authData = {
            access_token,
            refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + expires_in
        };

        const profileRes = await axios.get('https://api.salla.dev/admin/v2/store/info', {
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

        await ConfigRepository.setConfig('salla_auth', authData);
        await ConfigRepository.setConfig('salla_store', storeInfo);

        console.log(`تم ربط متجر "${storeInfo.name}" بنجاح!`);
        res.redirect('/?success=connected');
    } catch (e) {
        console.error('خطأ أثناء تبديل توكين سلة:', e.response ? e.response.data : e.message);
        res.redirect('/?error=token_exchange_failed');
    }
});

// 3. Connection status Check
router.get('/auth-status', authenticateUser, async (req, res) => {
    try {
        const storeInfo = await ConfigRepository.getConfig('salla_store');
        const sallaAuth = await ConfigRepository.getConfig('salla_auth');
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
                        simulated: true,
                        has_credentials: hasCredentials,
                        store: {
                            name: "لوحة التحكم (أوفلاين)",
                            domain: `مستورد ${importedCount} طلب و ${importedWalletCount} تسوية`,
                            avatar: "I"
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

// 4. Get wallet report
router.get('/wallet', authenticateUser, (req, res) => {
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

// 5. Import and save wallet transactions from Excel
router.post('/imported-wallet', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_add) {
        return res.status(403).json({ error: 'ليس لديك صلاحية استيراد تسويات المحفظة.' });
    }
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

// 6. Clear wallet transactions imports
router.post('/clear-wallet-imports', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_delete) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف تسويات المحفظة.' });
    }
    db.run("DELETE FROM salla_imported_wallet", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// 7. Disconnect store (logout from Salla)
router.get('/disconnect', authenticateUser, async (req, res) => {
    try {
        await ConfigRepository.deleteConfig('salla_auth');
        await ConfigRepository.deleteConfig('salla_store');
        res.json({ success: true, message: 'تم قطع الربط بالمتجر بنجاح' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. Get orders (with simulated logic if not connected)
router.get('/orders', authenticateUser, async (req, res) => {
    const page = req.query.page || 1;
    const perPage = req.query.per_page || 20;
    const status = req.query.status || '';
    const products = req.query.products || '';
    const q = req.query.q || '';
    const from = req.query.from || '';
    const to = req.query.to || '';
    const sort = req.query.sort || 'desc';
    const minAmt = req.query.min_amt || '';
    const maxAmt = req.query.max_amt || '';

    const token = await SallaService.getOrRefreshToken();

    // We check the local SQLite database first. If it has orders, we use it to support
    // pagination, sorting, custom filtering, and high per_page values (like 3000) that Salla API doesn't support.
    db.get("SELECT COUNT(*) as count FROM salla_imported_orders", [], async (err, countRow) => {
        if (!err && countRow && countRow.count > 0) {
            let query = "SELECT o.*, oa.platform as attr_platform, oa.match_method as attr_method, oa.confidence as attr_confidence FROM salla_imported_orders o LEFT JOIN order_attribution oa ON o.reference_id = oa.order_id OR o.reference_id LIKE oa.order_id || '_%' WHERE 1=1";
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
                query += " AND (customer_name LIKE ? OR product_name LIKE ? OR reference_id LIKE ? OR customer_phone LIKE ?)";
                params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
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
                    attribution: {
                        platform: r.attr_platform || null,
                        method: r.attr_method || null,
                        confidence: r.attr_confidence || null
                    },
                    items: [
                        {
                            name: r.product_name || '-',
                            thumbnail: r.product_thumbnail || '',
                            quantity: r.quantity || 1
                        }
                    ],
                    customer: { 
                        full_name: r.customer_name || '-',
                        mobile: r.customer_phone || ''
                    },
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
            // Fallback if local database is empty
            if (!token) {
                return res.json(getSimulatedOrders(page, perPage, status, products, sort, minAmt, maxAmt, q, from, to));
            }

            try {
                // Salla API v2 maximum limit per page is 20. Cap it to avoid 422 errors.
                const sallaPerPage = Math.min(parseInt(perPage) || 20, 20);
                let url = `https://api.salla.dev/admin/v2/orders?page=${page}&per_page=${sallaPerPage}`;
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
                console.error('خطأ أثناء جلب طلبات سلة مباشرة:', error.response ? error.response.data : error.message);
                res.status(500).json({ error: 'فشل جلب الطلبات من سلة API', details: error.message });
            }
        }
    });
});

// 9. Import and save Salla orders from Excel
router.post('/imported-orders', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_add) {
        return res.status(403).json({ error: 'ليس لديك صلاحية استيراد الطلبات.' });
    }
    const { orders } = req.body;
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
        return res.status(400).json({ error: 'يرجى تقديم مصفوفة طلبات صالحة.' });
    }

    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO salla_imported_orders 
            (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity, customer_phone) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                parseInt(o.quantity) || 1,
                o.customer_phone || ''
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

// 10. Manual sync now
router.post('/sync-now', authenticateUser, async (req, res) => {
    try {
        // Manual sync clicks will default to a full sync to retrieve full history
        const forceFull = req.query.full !== 'false';
        const count = await SallaService.syncOrders(true, forceFull);
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

// 11. Abandoned Carts
router.get('/abandoned-carts', authenticateUser, async (req, res) => {
    const token = await SallaService.getOrRefreshToken();

    if (!token) {
        return res.json(getSimulatedCarts());
    }

    try {
        // السلات المتروكة - الباقة الاحترافية في سلة فقط تدعمها
        // نستخدم المحاكاة كحل بديل آمن
        return res.json(getSimulatedCarts());
    } catch (error) {
        console.error('خطأ أثناء جلب السلات المتروكة:', error.message);
        res.json(getSimulatedCarts());
    }
});

// 12. Clear all Salla imported orders
router.post('/clear-imports', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_delete) {
        return res.status(403).json({ error: 'ليس لديك صلاحية حذف المبيعات المستوردة.' });
    }
    db.run("DELETE FROM salla_imported_orders", [], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, changes: this.changes });
    });
});

// --- SALLA WEBHOOK ENDPOINTS ---

// 1. Webhook receiver
router.post('/webhook', async (req, res) => {
    const payload = req.body;
    const eventName = payload.event || 'unknown';
    const signature = req.headers['x-salla-signature'] || req.headers['X-Salla-Signature'] || '';
    const eventId = payload.id || ''; // معرّف الحدث لمنع التكرار (Idempotency)
    
    console.log(`[SallaWebhook] Received event: ${eventName}, eventId: ${eventId}`);

    // التحقق من تكرار الحدث (Idempotency)
    if (eventId) {
        const alreadyProcessed = await new Promise((resolve) => {
            db.get("SELECT 1 FROM salla_webhook_logs WHERE event_id = ? AND status = 'success' LIMIT 1", [eventId], (err, row) => {
                resolve(!err && row ? true : false);
            });
        });
        if (alreadyProcessed) {
            console.log(`[SallaWebhook] Event ${eventId} (${eventName}) already processed successfully. Skipping.`);
            return res.json({ success: true, message: 'Event already processed' });
        }
    }

    // Verify Salla Webhook Signature using HMAC-SHA256
    const secret = process.env.SALLA_WEBHOOK_SECRET;
    if (secret) {
        if (!signature) {
            console.error('[SallaWebhook] Signature header X-Salla-Signature is missing.');
            return res.status(401).json({ error: 'X-Salla-Signature header is missing.' });
        }
        try {
            const hmac = crypto.createHmac('sha256', secret);
            const rawBody = req.rawBody || Buffer.from(JSON.stringify(payload));
            const calculated = hmac.update(rawBody).digest('hex');
            
            if (!crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(signature, 'hex'))) {
                console.error('[SallaWebhook] Invalid webhook signature detected.');
                return res.status(401).json({ error: 'Invalid webhook signature.' });
            }
            console.log('[SallaWebhook] Webhook signature verified successfully.');
        } catch (err) {
            console.error('[SallaWebhook] Webhook signature verification error:', err.message);
            return res.status(401).json({ error: 'Webhook signature verification failed.' });
        }
    } else {
        console.warn('[SallaWebhook] SALLA_WEBHOOK_SECRET is not set in env. Skipping signature verification.');
    }
    
    try {
        // Forward webhook payload to the WhatsApp bot at port 5001
        axios.post('http://127.0.0.1:5001/webhook/salla', payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Salla-Signature': signature
            },
            timeout: 5000
        }).catch(err => {
            console.log('[SallaWebhook] Failed to forward webhook to WhatsApp bot (expected if bot is down/starting):', err.message);
        });

        db.run(
            "INSERT INTO salla_webhook_logs (event_id, event_name, payload, status) VALUES (?, ?, ?, ?)",
            [eventId || null, eventName, JSON.stringify(payload), 'success'],
            (err) => {
                if (err) console.error('[SallaWebhook] Error saving log to DB:', err.message);
            }
        );

        // Handle app.uninstalled event — حذف جميع بيانات المتجر فوراً
        if (eventName === 'app.uninstalled') {
            await ConfigRepository.deleteConfig('salla_auth');
            await ConfigRepository.deleteConfig('salla_store');
            // حذف البيانات المستوردة بالكامل لاستكمال التزام سياسة الخصوصية
            await new Promise((resolve) => db.run("DELETE FROM salla_imported_orders", resolve));
            await new Promise((resolve) => db.run("DELETE FROM salla_imported_wallet", resolve));
            await new Promise((resolve) => db.run("DELETE FROM salla_webhook_logs", resolve));
            console.log('[SallaWebhook] Store uninstalled: All store data deleted successfully.');
            return res.json({ success: true, message: 'App uninstall processed. All data deleted.' });
        }

        // Handle app.store.authorize event (Salla Easy Mode authorization webhook)
        if (eventName === 'app.store.authorize' && payload.data) {
            const { access_token, refresh_token, expires_in } = payload.data;
            const authData = {
                access_token,
                refresh_token,
                expires_at: Math.floor(Date.now() / 1000) + (expires_in || 2592000)
            };
            
            try {
                const profileRes = await axios.get('https://api.salla.dev/admin/v2/store/info', {
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

                await ConfigRepository.setConfig('salla_auth', authData);
                await ConfigRepository.setConfig('salla_store', storeInfo);
                console.log(`[SallaWebhook] [Easy Mode] تم ربط متجر "${storeInfo.name}" بنجاح عبر النمط السهل!`);
            } catch (errProfile) {
                console.error('[SallaWebhook] Failed to fetch store info during easy mode authorize:', errProfile.message);
            }
        }

        if (['order.created', 'order.updated', 'order.status.updated'].includes(eventName) && payload.data) {
            const o = payload.data;
            const refId = String(o.reference_id);
            let dateStr = new Date().toISOString().substring(0, 10);
            const rawDate = o.date || o.created_at;
            if (rawDate) {
                if (typeof rawDate === 'number') {
                    dateStr = new Date(rawDate * 1000).toISOString().substring(0, 10);
                } else if (typeof rawDate === 'string') {
                    dateStr = rawDate.substring(0, 10);
                } else if (typeof rawDate === 'object' && rawDate.date) {
                    dateStr = rawDate.date.substring(0, 10);
                }
            }
            const statusSlug = o.status?.slug || 'completed';
            const statusName = o.status?.name || 'تم التنفيذ';
            const paymentMethod = o.payment_method || 'mada';
            const amount = parseFloat(o.total?.amount || 0);
            const customerName = o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : 'عميل خارجي';
            const customerPhone = o.customer ? (o.customer.mobile || o.customer.phone || '') : '';
            
            const items = o.items || [];
            
            db.serialize(() => {
                db.run("DELETE FROM salla_imported_orders WHERE reference_id = ? OR reference_id LIKE ?", [refId, refId + '_%']);
                
                if (items.length > 0) {
                    const stmt = db.prepare(`
                        INSERT INTO salla_imported_orders 
                        (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity, customer_phone) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    items.forEach(item => {
                        let prodName = item.name || 'منتج مستورد';
                        if (item.options && Array.isArray(item.options) && item.options.length > 0) {
                            const opts = item.options.map(opt => opt.value || opt.name).filter(v => v).join(' - ');
                            if (opts) {
                                prodName += ' - ' + opts;
                            }
                        }
                        const thumbnail = item.thumbnail || '';
                        const qty = parseInt(item.quantity) || 1;
                        
                        stmt.run([
                            refId + '_' + (item.id || item.product_id || Math.floor(Math.random() * 100000)),
                            dateStr,
                            statusSlug,
                            statusName,
                            paymentMethod,
                            amount / items.length,
                            customerName,
                            prodName,
                            thumbnail,
                            qty,
                            customerPhone
                        ]);
                    });
                    stmt.finalize();
                } else {
                    db.run(`
                        INSERT INTO salla_imported_orders 
                        (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity, customer_phone) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        refId,
                        dateStr,
                        statusSlug,
                        statusName,
                        paymentMethod,
                        amount,
                        customerName,
                        'طلب بدون عناصر',
                        '',
                        1,
                        customerPhone
                    ]);
                }
            });
            console.log(`[SallaWebhook] Processed order ${refId} successfully.`);
            
            // تشغيل الإسناد الاحتياطي لربط الطلب بالحملة والزيارة المناسبة
            performFallbackAttribution(refId, o, (errMatch, result) => {
                if (errMatch) {
                    console.error(`[SallaWebhook] Error during fallback attribution for order ${refId}:`, errMatch.message);
                } else {
                    console.log(`[SallaWebhook] Fallback attribution computed for order ${refId}: platform=${result.platform}`);
                }
            });
        }

        // حدث إضافة منتج للسلة (cart.product.added)
        if (['cart.product.added', 'cart.abandoned', 'cart.recovered'].includes(eventName) && payload.data) {
            const c = payload.data;
            const cartId = String(c.id || c.cart_id || 'cart_' + Date.now());
            const customerName = c.customer ? `${c.customer.first_name || ''} ${c.customer.last_name || ''}`.trim() : 'عميل مجهول';
            const items = c.products || c.items || [];
            const totalAmount = parseFloat(c.total?.amount || c.subtotal?.amount || 0);
            const dateStr = new Date().toISOString().split('T')[0];
            console.log(`[SallaWebhook] Cart event received: ${eventName}, cartId: ${cartId}, customer: ${customerName}, items: ${items.length}`);
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[SallaWebhook] Error processing webhook:', e.message);
        db.run(
            "INSERT INTO salla_webhook_logs (event_id, event_name, payload, status, error_message) VALUES (?, ?, ?, ?, ?)",
            [eventId || null, eventName, JSON.stringify(payload), 'failed', e.message]
        );
        res.status(500).json({ error: 'Internal server error processing webhook' });
    }
});

// 2. GET Webhook status
router.get('/webhook-status', authenticateUser, (req, res) => {
    const query = `
        SELECT received_at, event_name, status 
        FROM salla_webhook_logs 
        ORDER BY id DESC LIMIT 1
    `;
    db.get(query, [], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!row) {
            return res.json({ connected: false, last_event: null });
        }
        
        const lastReceived = new Date(row.received_at + ' UTC');
        const diffMs = Date.now() - lastReceived.getTime();
        const connected = diffMs < 24 * 60 * 60 * 1000;
        
        res.json({
            connected: true,
            last_event: {
                name: row.event_name,
                status: row.status,
                received_at: row.received_at
            }
        });
    });
});

// 3. GET Webhook logs
router.get('/webhook-logs', authenticateUser, (req, res) => {
    db.all("SELECT id, event_name, status, error_message, received_at FROM salla_webhook_logs ORDER BY id DESC LIMIT 20", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ data: rows });
    });
});

// --- HELPER MOCK FUNCTIONS ---

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

// دالة الإسناد التسويقي الاحتياطي للويب هوك
function performFallbackAttribution(orderId, o, callback) {
    const customerPhone = o.customer ? (o.customer.mobile || o.customer.phone || '') : '';
    const customerEmail = o.customer ? (o.customer.email || '') : '';
    const orderDate = new Date().toISOString();
    
    // 1. استخراج معطيات سلة الذاتية لـ UTMs
    const sallaUtm = o.utm || {};
    const utmSource = sallaUtm.source || '';
    const utmMedium = sallaUtm.medium || '';
    const utmCampaign = sallaUtm.campaign || '';
    const utmContent = sallaUtm.content || '';
    const utmTerm = sallaUtm.term || '';
    
    // 2. التحقق مما إذا كان الطلب مسنداً مسبقاً من صفحة الشكر لمنع الاستبدال
    db.get("SELECT 1 FROM order_attribution WHERE order_id = ? LIMIT 1", [String(orderId)], (errCheck, rowCheck) => {
        if (!errCheck && rowCheck) {
            return callback(null, { platform: 'already_attributed', campaign_id: '' });
        }
        
        // 3. البحث في الجلسات النشطة خلال الساعة الماضية فقط لتجنب التداخل
        let matchQuery = `
            SELECT * FROM attribution_sessions 
            WHERE datetime(created_at) >= datetime(?, '-1 hours')
        `;
        const matchParams = [orderDate];
        
        if (utmCampaign) {
            matchQuery += ` AND (last_touch LIKE ? OR first_touch LIKE ?)`;
            matchParams.push(`%${utmCampaign}%`, `%${utmCampaign}%`);
        }
        
        matchQuery += ` ORDER BY created_at DESC LIMIT 1`;
        
        db.get(matchQuery, matchParams, (err, session) => {
            let platform = 'direct';
            let utmId = '';
            let adsetId = '';
            let adId = '';
            let sdVid = null;
            let matchMethod = 'salla_native';
            let confidence = 0.5;
            let touchData = null;
            
            if (!err && session) {
                sdVid = session.sd_vid;
                matchMethod = 'fallback_time_utm';
                confidence = 0.4; // ثقة منخفضة للإسناد الزمني التقديري
                
                try {
                    touchData = JSON.parse(session.last_touch || session.first_touch);
                } catch(e) {}
                
                const src = (touchData?.utm_source || utmSource || '').toLowerCase();
                const med = (touchData?.utm_medium || utmMedium || '').toLowerCase();
                
                if (session.fbclid || src.includes('facebook') || src.includes('instagram') || src === 'fb' || src === 'ig') {
                    platform = 'facebook';
                } else if (session.ttclid || src.includes('tiktok') || src === 'tt') {
                    platform = 'tiktok';
                } else if (session.sclid || src.includes('snap') || src.includes('snapchat')) {
                    platform = 'snapchat';
                } else if (src.includes('google') || src.includes('gclid') || med === 'cpc') {
                    platform = 'google';
                } else if (src) {
                    platform = src;
                }
                
                try {
                    const url = new URL(touchData.url || '');
                    utmId = url.searchParams.get('utm_id') || url.searchParams.get('campaign_id') || url.searchParams.get('__CAMPAIGN_ID__') || '';
                    adsetId = url.searchParams.get('sd_adset') || url.searchParams.get('adset_id') || url.searchParams.get('__AID__') || '';
                    adId = url.searchParams.get('sd_ad') || url.searchParams.get('ad_id') || url.searchParams.get('__CID__') || '';
                } catch(e) {}
            } else if (utmSource) {
                const src = utmSource.toLowerCase();
                const med = utmMedium.toLowerCase();
                
                if (src.includes('facebook') || src.includes('instagram') || src === 'fb' || src === 'ig') {
                    platform = 'facebook';
                } else if (src.includes('tiktok') || src === 'tt') {
                    platform = 'tiktok';
                } else if (src.includes('snap') || src.includes('snapchat')) {
                    platform = 'snapchat';
                } else if (src.includes('google') || med === 'cpc') {
                    platform = 'google';
                } else {
                    platform = src;
                }
            }
            
            db.run(`
                INSERT OR IGNORE INTO order_attribution 
                (order_id, sd_vid, platform, campaign_id, campaign_name, adset_id, ad_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, match_method, confidence) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                String(orderId),
                sdVid,
                platform,
                utmId || '',
                utmCampaign || (touchData && touchData.utm_campaign) || '',
                adsetId || '',
                adId || '',
                utmSource || (touchData && touchData.utm_source) || '',
                utmMedium || (touchData && touchData.utm_medium) || '',
                utmCampaign || (touchData && touchData.utm_campaign) || '',
                utmContent || (touchData && touchData.utm_content) || '',
                utmTerm || (touchData && touchData.utm_term) || '',
                matchMethod,
                confidence
            ], (errInsert) => {
                if (callback) callback(errInsert, { platform, campaign_id: utmId });
            });
        });
    });
}

module.exports = {
    router,
    syncSallaOrdersToLocal: SallaService.syncOrders,
    performFallbackAttribution
};
