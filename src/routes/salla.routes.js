const express = require('express');
const router = express.Router();
const axios = require('axios');
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
    const stateParam = Math.random().toString(36).substring(2, 15);
    const authUrl = `${SALLA_AUTH_URL}?response_type=code&client_id=${process.env.SALLA_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.SALLA_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${stateParam}`;
    res.redirect(authUrl);
});

// 2. Salla OAuth callback (mounted at /callback in server.js but we can handle it)
router.get('/callback-handler', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        console.error('خطأ من سلة أثناء التصريح:', error);
        return res.redirect('/?error=auth_denied');
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
    const perPage = req.query.per_page || 15;
    const status = req.query.status || '';
    const products = req.query.products || '';
    const q = req.query.q || '';
    const from = req.query.from || '';
    const to = req.query.to || '';
    const sort = req.query.sort || 'desc';
    const minAmt = req.query.min_amt || '';
    const maxAmt = req.query.max_amt || '';

    const token = await SallaService.getOrRefreshToken();

    if (!token) {
        db.get("SELECT COUNT(*) as count FROM salla_imported_orders", [], (err, countRow) => {
            if (!err && countRow && countRow.count > 0) {
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
                return res.json(getSimulatedOrders(page, perPage, status, products, sort, minAmt, maxAmt, q, from, to));
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
        const count = await SallaService.syncOrders(true);
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
    
    console.log(`[SallaWebhook] Received event: ${eventName}`);
    
    try {
        // Forward webhook payload to the WhatsApp bot at port 5001
        const signature = req.headers['x-salla-signature'] || req.headers['X-Salla-Signature'] || '';
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
            "INSERT INTO salla_webhook_logs (event_name, payload, status) VALUES (?, ?, ?)",
            [eventName, JSON.stringify(payload), 'success'],
            (err) => {
                if (err) console.error('[SallaWebhook] Error saving log to DB:', err.message);
            }
        );

        if (['order.created', 'order.updated', 'order.status.updated'].includes(eventName) && payload.data) {
            const o = payload.data;
            const refId = String(o.reference_id);
            const dateStr = o.created_at ? o.created_at.split(' ')[0] : new Date().toISOString().split('T')[0];
            const statusSlug = o.status?.slug || 'completed';
            const statusName = o.status?.name || 'تم التنفيذ';
            const paymentMethod = o.payment_method || 'mada';
            const amount = parseFloat(o.total?.amount || 0);
            const customerName = o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : 'عميل خارجي';
            
            const items = o.items || [];
            
            db.serialize(() => {
                db.run("DELETE FROM salla_imported_orders WHERE reference_id = ? OR reference_id LIKE ?", [refId, refId + '_%']);
                
                if (items.length > 0) {
                    const stmt = db.prepare(`
                        INSERT INTO salla_imported_orders 
                        (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    items.forEach(item => {
                        const prodName = item.name || 'منتج مستورد';
                        const thumbnail = item.thumbnail || '';
                        const qty = parseInt(item.quantity) || 1;
                        
                        stmt.run([
                            refId + '_' + item.id,
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
                    });
                    stmt.finalize();
                } else {
                    db.run(`
                        INSERT INTO salla_imported_orders 
                        (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        1
                    ]);
                }
            });
            console.log(`[SallaWebhook] Processed order ${refId} successfully.`);
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[SallaWebhook] Error processing webhook:', e.message);
        db.run(
            "INSERT INTO salla_webhook_logs (event_name, payload, status, error_message) VALUES (?, ?, ?, ?)",
            [eventName, JSON.stringify(payload), 'failed', e.message]
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

module.exports = {
    router,
    syncSallaOrdersToLocal: SallaService.syncOrders
};
