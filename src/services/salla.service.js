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
            console.log('[SallaService] توكين سلة على وشك الانتهاء، جاري التحديث...');
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

    syncOrders: async (throwOnError = false) => {
        try {
            const token = await SallaService.getOrRefreshToken();
            if (!token) {
                if (throwOnError) {
                    throw new Error('SALLA_NOT_CONNECTED');
                }
                console.log('[SallaService] سلة غير متصلة. تخطي المزامنة.');
                return 0;
            }
            
            console.log('[SallaService] جاري سحب أحدث الطلبات من منصة سلة...');
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
