const axios = require('axios');
const ConfigRepository = require('../repositories/config.repository');
const db = require('../config/db');
const { extractSallaTimestamp } = require('../utils/salla_timestamp');
const SallaOrderItemsService = require('./salla_order_items.service');

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
        if (process.env.NODE_ENV === 'test') return 'test_access_token';
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

            // Sorted by Salla's own updated_at (newest-updated first, confirmed supported query param:
            // sort_by=updated_at-desc — see docs.salla.dev List Orders). This lets the stop-heuristic below
            // reason correctly about *status changes on old orders*, not just about newly-created orders —
            // created_at ordering could never surface those, since an old order that changed status keeps
            // its old created_at.
            let nextPageUrl = 'https://api.salla.dev/admin/v2/orders?per_page=50&sort_by=updated_at-desc';
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

                // Stop only once every order on this page is BOTH already known locally AND not stale
                // (i.e. our stored external_updated_at is already >= what Salla reports now). Merely
                // existing locally is not enough — that was the original bug: an order can exist with a
                // status that has since changed in Salla, and mere-existence pagination would never catch it.
                if (!forceFull && pageOrders.length > 0) {
                    const refIds = pageOrders.map(o => String(o.reference_id));
                    const conditions = refIds.map(() => '(reference_id = ? OR reference_id LIKE ?)').join(' OR ');
                    const params = refIds.flatMap(id => [id, id + '_%']);
                    const existingRows = await new Promise((resolve, reject) => {
                        db.all(`SELECT reference_id, external_updated_at FROM salla_imported_orders WHERE ${conditions}`, params, (err, rows) => {
                            if (err) reject(err); else resolve(rows || []);
                        });
                    });

                    // Per base order id (stripping any "_itemId" suffix), the freshest external_updated_at we have.
                    const localFreshness = new Map();
                    existingRows.forEach(row => {
                        const baseId = row.reference_id.includes('_') ? row.reference_id.split('_')[0] : row.reference_id;
                        const current = localFreshness.get(baseId);
                        if (row.external_updated_at && (!current || row.external_updated_at > current)) {
                            localFreshness.set(baseId, row.external_updated_at);
                        } else if (!localFreshness.has(baseId)) {
                            localFreshness.set(baseId, row.external_updated_at || null);
                        }
                    });

                    const allUpToDate = pageOrders.every(o => {
                        const refId = String(o.reference_id);
                        if (!localFreshness.has(refId)) return false; // never seen locally at all
                        const local = localFreshness.get(refId);
                        if (!local) return false; // seen but no timestamp recorded yet -> needs reconciling
                        const remote = extractSallaTimestamp(o.updated_at);
                        if (!remote) return true; // API gave no timestamp to compare against; nothing more we can do
                        return local >= remote;
                    });

                    if (allUpToDate) {
                        console.log(`[SallaService] All ${pageOrders.length} orders on page ${pageCount} are already up to date locally. Stopping pagination.`);
                        stopSync = true;
                    }
                }

                // Get next page URL
                nextPageUrl = response.data?.pagination?.links?.next || null;
            }
            
            console.log(`[SallaService] تم جلب ${orders.length} طلب من سلة.`);
            if (orders.length === 0) return 0;
            
            let newCount = 0;

            for (const o of orders) {
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
                let orderAmount = 0;
                if (typeof o.total === 'number') {
                    orderAmount = o.total;
                } else if (o.total && typeof o.total.amount !== 'undefined') {
                    orderAmount = parseFloat(o.total.amount) || 0;
                } else if (o.amounts && o.amounts.total && typeof o.amounts.total.amount !== 'undefined') {
                    orderAmount = parseFloat(o.amounts.total.amount) || 0;
                } else if (o.amounts && typeof o.amounts.total === 'number') {
                    orderAmount = o.amounts.total;
                } else if (typeof o.amount === 'number') {
                    orderAmount = o.amount;
                } else if (typeof o.amount === 'string') {
                    orderAmount = parseFloat(o.amount) || 0;
                } else if (o.payment_actions?.refund_action?.paid_amount?.amount) {
                    orderAmount = parseFloat(o.payment_actions.refund_action.paid_amount.amount) || 0;
                }

                const amount = orderAmount;
                const customerName = o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : 'عميل خارجي';
                const customerPhone = o.customer ? (o.customer.mobile || o.customer.phone || '') : '';

                // دمج كل المنتجات في صف واحد لكل طلب (لا suffix)
                const items = o.items || [];
                let productName = 'منتج مستورد';
                let thumbnail = '';
                let totalQty = 1;

                if (items.length > 0) {
                    const productNames = items.map(item => {
                        let name = item.name || 'منتج';
                        if (item.options && Array.isArray(item.options) && item.options.length > 0) {
                            const opts = item.options.map(opt => {
                                if (!opt) return '';
                                if (typeof opt === 'string') return opt;
                                if (typeof opt.value === 'string') return opt.value;
                                if (opt.value && typeof opt.value === 'object') {
                                    return opt.value.name || opt.value.label || opt.value.value || opt.value.text || '';
                                }
                                if (typeof opt.name === 'string') return opt.name;
                                return '';
                            }).filter(v => v && v !== '[object Object]').join(' - ');
                            if (opts) name += ' - ' + opts;
                        }
                        return name;
                    });
                    productName = productNames.join(' + ').replace(/\s*-\s*\[object Object\]/gi, '').trim();
                    thumbnail = items[0].thumbnail || '';
                    totalQty = items.reduce((sum, item) => sum + (parseInt(item.quantity) || 1), 0);
                }

                const externalUpdatedAt = extractSallaTimestamp(o.updated_at);

                // Does this order already have a local row — either the single merged row this function
                // itself writes, or per-item rows written by the webhook handler? Match both key shapes.
                const existingRows = await new Promise((resolve, reject) => {
                    db.all(
                        "SELECT reference_id, external_updated_at FROM salla_imported_orders WHERE reference_id = ? OR reference_id LIKE ?",
                        [refId, refId + '_%'],
                        (err, rows) => err ? reject(err) : resolve(rows || [])
                    );
                });

                if (existingRows.length > 0) {
                    // Existing order: only refresh status/payment/timestamp, guarded so an older API
                    // snapshot can never overwrite a newer state already recorded (e.g. by a webhook that
                    // arrived after this sync request was sent to Salla). Product/amount/item details are
                    // intentionally left untouched here — they are only ever written by the webhook handler,
                    // which has the authoritative per-item breakdown; rewriting them from this merged-order
                    // view would blow away that granularity.
                    await new Promise((resolve, reject) => {
                        db.run(`
                            UPDATE salla_imported_orders
                            SET status_slug = ?, status_name = ?, payment_method = ?, external_updated_at = ?
                            WHERE (reference_id = ? OR reference_id LIKE ?)
                              AND (external_updated_at IS NULL OR ? IS NULL OR external_updated_at <= ?)
                        `, [statusSlug, statusName, paymentMethod, externalUpdatedAt, refId, refId + '_%', externalUpdatedAt, externalUpdatedAt],
                        (err) => err ? reject(err) : resolve());
                    });
                } else {
                    // Brand new order this store has never recorded — insert as a single merged row.
                    await new Promise((resolve, reject) => {
                        db.run(`
                            INSERT INTO salla_imported_orders
                            (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity, customer_phone, external_updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [refId, dateStr, statusSlug, statusName, paymentMethod, amount, customerName, productName, thumbnail, totalQty, customerPhone, externalUpdatedAt],
                        (err) => err ? reject(err) : resolve());
                    });
                }

                // Item-level write (salla_order_items) — the authoritative source for product sales
                // reporting, built from Salla's own per-item amounts rather than this function's
                // equal-split merged-order total. Isolated in its own try/catch: a failure here must
                // never affect the order-level sync above.
                try {
                    await SallaOrderItemsService.upsertOrderItemsForOrder(o, {
                        statusSlug,
                        statusName,
                        orderDate: dateStr,
                        externalUpdatedAt,
                        source: 'sync'
                    });
                } catch (itemErr) {
                    console.error(`[SallaSync] Failed to write order items for ${refId}:`, itemErr.message);
                }

                newCount++;
            }

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

            console.log(`[SallaService] تم الانتهاء بنجاح! جلب ومزامنة ${newCount} بند مبيعات من سلة.`);
            return newCount;
        } catch (error) {
            console.error('[SallaService] خطأ أثناء المزامنة تلقائياً:', error.message);
            if (throwOnError) {
                throw error;
            }
            return 0;
        }
    },

    updateOrderStatus: async (orderId, slug) => {
        try {
            const token = await SallaService.getOrRefreshToken();
            if (!token) {
                console.error('[SallaService] Salla not connected, cannot update order status.');
                return { success: false, error: 'SALLA_NOT_CONNECTED' };
            }
            
            // Clean order suffix if any (e.g. 12345_678 -> 12345)
            const cleanOrderId = String(orderId).split('_')[0];
            
            console.log(`[SallaService] Updating order status for ${cleanOrderId} to ${slug}...`);
            const response = await axios.post(`https://api.salla.dev/admin/v2/orders/${cleanOrderId}/status`, {
                slug: slug
            }, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log(`[SallaService] Order ${cleanOrderId} status updated to ${slug} on Salla.`);
            
            // Update local DB status immediately to keep UI in sync
            db.run(
                "UPDATE salla_imported_orders SET status_slug = ?, status_name = ? WHERE reference_id = ? OR reference_id LIKE ?",
                [slug, slug === 'completed' ? 'تم التنفيذ' : slug, cleanOrderId, cleanOrderId + '_%'],
                (dbErr) => {
                    if (dbErr) {
                        console.error('[SallaService] Failed to update local DB order status:', dbErr.message);
                    } else {
                        console.log('[SallaService] Local DB order status updated.');
                    }
                }
            );

            return { success: true, data: response.data };
        } catch (error) {
            console.error('[SallaService] Failed to update order status:', error.response ? error.response.data : error.message);
            return { success: false, error: error.response ? error.response.data : error.message };
        }
    }
};

module.exports = SallaService;
