const axios = require('axios');
const ConfigRepository = require('../repositories/config.repository');
const db = require('../config/db');

const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

const SallaService = {
    hasRealCredentials: () => {
        const clientId = process.env.SALLA_CLIENT_ID;
        const clientSecret = process.env.SALLA_CLIENT_SECRET;
        return (
            clientId &&
            clientId !== 'salla_client_id_here' &&
            clientSecret &&
            clientSecret !== 'salla_client_secret_here'
        );
    },

    getOrRefreshToken: async () => {
        const sallaAuth = await ConfigRepository.getConfig('salla_auth');
        if (!sallaAuth) return null;

        const now = Math.floor(Date.now() / 1000);
        if (sallaAuth.expires_at - now < 300) {
            try {
                const params = new URLSearchParams();
                params.append('client_id', process.env.SALLA_CLIENT_ID);
                params.append('client_secret', process.env.SALLA_CLIENT_SECRET);
                params.append('grant_type', 'refresh_token');
                params.append('refresh_token', sallaAuth.refresh_token);
                params.append('redirect_uri', process.env.SALLA_REDIRECT_URI);

                const response = await axios.post(SALLA_TOKEN_URL, params, {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });

                const { access_token, refresh_token, expires_in } = response.data;
                const updatedAuth = {
                    access_token,
                    refresh_token,
                    expires_at: Math.floor(Date.now() / 1000) + expires_in
                };
                
                await ConfigRepository.setConfig('salla_auth', updatedAuth);
                console.log('[SallaService] تم تحديث التوكين بنجاح!');
                return access_token;
            } catch (error) {
                console.error('[SallaService] فشل تحديث التوكين:', error.response ? error.response.data : error.message);
                return null;
            }
        }
        return sallaAuth.access_token;
    },

    syncOrders: async (throwOnError = false, forceFull = false) => {
        try {
            const token = await SallaService.getOrRefreshToken();
            if (!token) {
                if (throwOnError) {
                    throw new Error('SALLA_NOT_CONNECTED');
                }
                console.log('[SallaService] سلة غير متصلة. تخطي المزامنة.');
                return 0;
            }
            
            console.log('[SallaService] جاري سحب الطلبات من منصة سلة...');
            
            let nextPageUrl = 'https://api.salla.dev/admin/v2/orders?per_page=50';
            let orders = [];
            let stopSync = false;
            let pageCount = 0;
            
            while (nextPageUrl && !stopSync && pageCount < 60) {
                pageCount++;
                console.log(`[SallaService] Fetching orders page ${pageCount} from: ${nextPageUrl}`);
                const response = await axios.get(nextPageUrl, {
                    headers: { 
                        'Authorization': `Bearer ${token}`,
                        'Accept-Language': 'ar'
                    }
                });
                
                const pageOrders = response.data?.data || [];
                if (pageOrders.length === 0) break;
                
                orders.push(...pageOrders);
                
                // Check if the last order on this page already exists in the database
                if (!forceFull) {
                    const lastOrder = pageOrders[pageOrders.length - 1];
                    if (lastOrder) {
                        const lastRefId = String(lastOrder.reference_id);
                        const exists = await new Promise((resolve) => {
                            db.get("SELECT 1 FROM salla_imported_orders WHERE reference_id = ? OR reference_id LIKE ? LIMIT 1", 
                                [lastRefId, lastRefId + '_%'], 
                                (err, row) => resolve(!err && row ? true : false)
                            );
                        });
                        if (exists) {
                            console.log(`[SallaService] Order ${lastRefId} already exists in DB. Stopping pagination.`);
                            stopSync = true;
                        }
                    }
                }
                
                // Get next page URL
                nextPageUrl = response.data?.pagination?.links?.next || null;
            }
            
            console.log(`[SallaService] تم جلب ${orders.length} طلب من سلة.`);
            if (orders.length === 0) return 0;
            
            let newCount = 0;
            
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO salla_imported_orders 
                (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity, customer_phone) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            orders.forEach(o => {
                const refId = String(o.reference_id);
                let dateStr = new Date().toISOString().split('T')[0];
                const rawDate = o.date || o.created_at;
                if (rawDate) {
                    if (typeof rawDate === 'number') {
                        dateStr = new Date(rawDate * 1000).toISOString().split('T')[0];
                    } else if (typeof rawDate === 'string') {
                        dateStr = rawDate.split(' ')[0];
                    } else if (typeof rawDate === 'object' && rawDate.date) {
                        dateStr = rawDate.date.split(' ')[0];
                    }
                }
                const statusSlug = o.status?.slug || 'completed';
                const statusName = o.status?.name || 'تم التنفيذ';
                const paymentMethod = o.payment_method || 'mada';
                const amount = parseFloat(o.total?.amount || o.payment_actions?.refund_action?.paid_amount?.amount || 0);
                const customerName = o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : 'عميل خارجي';
                const customerPhone = o.customer ? (o.customer.mobile || o.customer.phone || '') : '';
                
                const items = o.items || [];
                if (items.length > 0) {
                    items.forEach(item => {
                        const prodName = item.name || 'منتج مستورد';
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
                        1,
                        customerPhone
                    ]);
                    newCount++;
                }
            });
            
            await new Promise((resolve, reject) => {
                stmt.finalize((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        // تشغيل الإسناد الاحتياطي لكل طلب للتأكد من عدم ضياع الإسناد
                        try {
                            const { performFallbackAttribution } = require('../routes/salla.routes');
                            orders.forEach(o => {
                                const refId = String(o.reference_id);
                                performFallbackAttribution(refId, o, (errMatch, result) => {
                                    if (errMatch) {
                                        console.error(`[SallaSync] Error during fallback attribution for order ${refId}:`, errMatch.message);
                                    }
                                });
                            });
                        } catch (e) {
                            console.error('[SallaSync] Failed to perform fallback attribution during sync:', e.message);
                        }
                        resolve();
                    }
                });
            });
            
            console.log(`[SallaService] تم الانتهاء بنجاح! جلب ومزامنة ${newCount} بند مبيعات من سلة.`);
            return newCount;
        } catch (error) {
            console.error('[SallaService] خطأ أثناء المزامنة تلقائياً:', error.message);
            if (throwOnError) {
                throw error;
            }
            return 0;
        }
    }
};

module.exports = SallaService;
