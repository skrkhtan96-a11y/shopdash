const express = require('express');
const router = express.Router();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('../../database').db;
const { authenticateUser } = require('../middlewares/auth');

// 1. تحديد معدل الطلبات لحماية السيرفر من السبام (Rate Limiting)
const collectLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 200, // حد 200 طلب لكل IP
    message: { error: 'Too many tracking requests from this IP.' }
});

// 2. إعداد CORS ديناميكي يسمح فقط بدومين متجر سلة المسجل وبنطاق سلة الافتراضي
const attributionCors = cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        
        db.get("SELECT value FROM salla_config WHERE key = 'salla_store' LIMIT 1", [], (err, row) => {
            if (!err && row) {
                try {
                    const store = JSON.parse(row.value);
                    const storeDomain = store.domain;
                    const originUrl = new URL(origin);
                    
                    if (
                        originUrl.hostname === storeDomain ||
                        originUrl.hostname.endsWith('.' + storeDomain) ||
                        originUrl.hostname.endsWith('.salla.sa') ||
                        originUrl.hostname === 'salla.sa'
                    ) {
                        return callback(null, true);
                    }
                } catch (e) {
                    console.error('[Attribution CORS] Parse error:', e);
                }
            }
            if (process.env.NODE_ENV !== 'production') {
                return callback(null, true);
            }
            callback(new Error('Not allowed by CORS for Attribution'));
        });
    },
    credentials: true
});

router.use(attributionCors);

// دالة لاستخراج المعرفات الرقمية للحملات من معاملات الرابط
function parseMarketingIds(urlStr, body) {
    let utmId = body.utm_campaign || '';
    let adsetId = body.adset_id || '';
    let adId = body.ad_id || '';
    
    try {
        const url = new URL(urlStr);
        const params = url.searchParams;
        
        // استخراج معرف الحملة (utm_id هو المعيار لـ Meta)
        utmId = params.get('utm_id') || params.get('campaign_id') || params.get('__CAMPAIGN_ID__') || body.utm_campaign || '';
        // استخراج معرف المجموعة الإعلانية
        adsetId = params.get('sd_adset') || params.get('adset_id') || params.get('__AID__') || '';
        // استخراج معرف الإعلان الفردي
        adId = params.get('sd_ad') || params.get('ad_id') || params.get('__CID__') || '';
    } catch(e) {}
    
    return { utmId, adsetId, adId };
}

// 3. مسار استقبال وحفظ الزيارات التسويقية (Collect)
router.post('/collect', collectLimiter, (req, res) => {
    const {
        sd_vid,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        fbclid,
        ttclid,
        sclid,
        fbp,
        fbc,
        referrer,
        url
    } = req.body;

    if (!sd_vid) {
        return res.status(400).json({ error: 'sd_vid is required' });
    }

    const { utmId, adsetId, adId } = parseMarketingIds(url || '', req.body);

    const trackingData = {
        utm_source: utm_source || '',
        utm_medium: utm_medium || '',
        utm_campaign: utm_campaign || '',
        utm_campaign_id: utmId || '',
        utm_content: utm_content || '',
        utm_term: utm_term || '',
        fbclid: fbclid || '',
        ttclid: ttclid || '',
        sclid: sclid || '',
        fbp: fbp || '',
        fbc: fbc || '',
        referrer: referrer || '',
        url: url || '',
        timestamp: new Date().toISOString()
    };

    const trackingDataStr = JSON.stringify(trackingData);

    db.get("SELECT sd_vid FROM attribution_sessions WHERE sd_vid = ?", [sd_vid], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        if (!row) {
            // أول لمسة (First Touch)
            db.run(`
                INSERT INTO attribution_sessions 
                (sd_vid, first_touch, last_touch, fbp, fbc, fbclid, ttclid, sclid) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                sd_vid,
                trackingDataStr,
                trackingDataStr,
                fbp || '',
                fbc || '',
                fbclid || '',
                ttclid || '',
                sclid || ''
            ], (errInsert) => {
                if (errInsert) return res.status(500).json({ error: errInsert.message });
                res.json({ success: true, action: 'created', sd_vid });
            });
        } else {
            // آخر لمسة (Last Touch)
            db.run(`
                UPDATE attribution_sessions 
                SET last_touch = ?, 
                    fbp = COALESCE(?, fbp), 
                    fbc = COALESCE(?, fbc), 
                    fbclid = COALESCE(?, fbclid), 
                    ttclid = COALESCE(?, ttclid), 
                    sclid = COALESCE(?, sclid),
                    updated_at = CURRENT_TIMESTAMP 
                WHERE sd_vid = ?
            `, [
                trackingDataStr,
                fbp || null,
                fbc || null,
                fbclid || null,
                ttclid || null,
                sclid || null,
                sd_vid
            ], (errUpdate) => {
                if (errUpdate) return res.status(500).json({ error: errUpdate.message });
                res.json({ success: true, action: 'updated', sd_vid });
            });
        }
    });
});

// 4. مسار ربط الجلسة بالطلب عند إتمام الشراء (Bind)
router.post('/bind', (req, res) => {
    const { order_id, sd_vid } = req.body;

    if (!order_id || !sd_vid) {
        return res.status(400).json({ error: 'order_id and sd_vid are required' });
    }

    db.get("SELECT * FROM attribution_sessions WHERE sd_vid = ?", [sd_vid], (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(404).json({ error: 'Session not found' });

        // نستخدم آخر لمسة كنموذج إسناد افتراضي للربط
        let touchData = {};
        try {
            touchData = JSON.parse(session.last_touch || session.first_touch);
        } catch(e) {}

        const { utmId, adsetId, adId } = parseMarketingIds(touchData.url || '', touchData);

        // تحديد المنصة الإعلانية الرئيسية المستهدفة بالإسناد
        let platform = 'direct';
        const source = (touchData.utm_source || '').toLowerCase();
        const medium = (touchData.utm_medium || '').toLowerCase();

        if (session.fbclid || source.includes('facebook') || source.includes('instagram') || source === 'fb' || source === 'ig') {
            platform = 'facebook';
        } else if (session.ttclid || source.includes('tiktok') || source === 'tt') {
            platform = 'tiktok';
        } else if (session.sclid || source.includes('snap') || source.includes('snapchat')) {
            platform = 'snapchat';
        } else if (source.includes('google') || source.includes('gclid') || medium === 'cpc' || medium === 'ppc') {
            platform = 'google';
        } else if (source) {
            platform = source;
        } else if (touchData.referrer) {
            try {
                const refUrl = new URL(touchData.referrer);
                if (refUrl.hostname.includes('google.') || refUrl.hostname.includes('bing.') || refUrl.hostname.includes('yahoo.')) {
                    platform = 'organic';
                } else {
                    platform = 'referral';
                }
            } catch(e) {
                platform = 'referral';
            }
        }

        db.run(`
            INSERT OR REPLACE INTO order_attribution 
            (order_id, sd_vid, platform, campaign_id, campaign_name, adset_id, ad_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, match_method, confidence) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            String(order_id),
            sd_vid,
            platform,
            utmId || '',
            touchData.utm_campaign || '',
            adsetId || '',
            adId || '',
            touchData.utm_source || '',
            touchData.utm_medium || '',
            touchData.utm_campaign || '',
            touchData.utm_content || '',
            touchData.utm_term || '',
            'thank_you_page',
            1.0 // دقة قصوى 100% لأن الربط حدث بصفحة الشكر مباشرة
        ], (errInsert) => {
            if (errInsert) return res.status(500).json({ error: errInsert.message });
            res.json({ success: true, platform, campaign_id: utmId });
        });
    });
});

// 5. مسار لوحة تحليلات الإسناد والعائد التسويقي (Dashboard Metrics)
router.get('/dashboard', authenticateUser, (req, res) => {
    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];
    const reliableOnly = req.query.reliable_only === 'true';

    // جلب تكاليف صرف الحملات من جدول إحصائيات المنصات المدمج
    const spendQuery = `
        SELECT 
            platform, 
            campaign_id, 
            campaign_name, 
            MAX(status) as status,
            SUM(spend) as total_spend, 
            SUM(impressions) as total_impressions, 
            SUM(clicks) as total_clicks,
            SUM(purchase_value) as total_purchase_value,
            SUM(purchases) as total_purchases,
            MAX(effective_status) as effective_status,
            MAX(objective) as objective
        FROM ads_campaign_metrics
        WHERE date(date) >= date(?) AND date(date) <= date(?)
        GROUP BY platform, campaign_id, campaign_name
    `;

    // جلب المبيعات الفعلية المسندة للطلبات المدفوعة
    let salesQuery = `
        SELECT
            oa.platform,
            oa.campaign_id,
            oa.campaign_name,
            COUNT(DISTINCT oa.order_id) as orders_count,
            SUM(o.amount) as sales_amount
        FROM order_attribution oa
        JOIN salla_imported_orders o ON o.reference_id = oa.order_id
        WHERE date(o.date) >= date(?) AND date(o.date) <= date(?)
          AND o.status_slug NOT IN ('canceled', 'refunded', 'returned')
    `;
    if (reliableOnly) {
        salesQuery += ` AND oa.match_method = 'thank_you_page'`;
    }
    salesQuery += ` GROUP BY oa.platform, oa.campaign_id, oa.campaign_name`;

    // استعلام الصرف اليومي للرسومات البيانية
    const dailySpendQuery = `
        SELECT date(date) as day, SUM(spend) as total_spend 
        FROM ads_campaign_metrics
        WHERE date(date) >= date(?) AND date(date) <= date(?)
        GROUP BY day
    `;

    // استعلام المبيعات المسندة اليومية للرسومات البيانية
    let dailySalesQuery = `
        SELECT date(o.date) as day,
               SUM(o.amount) as total_sales
        FROM order_attribution oa
        JOIN salla_imported_orders o ON o.reference_id = oa.order_id
        WHERE date(o.date) >= date(?) AND date(o.date) <= date(?)
          AND o.status_slug NOT IN ('canceled', 'refunded', 'returned')
    `;
    if (reliableOnly) {
        dailySalesQuery += ` AND oa.match_method = 'thank_you_page'`;
    }
    dailySalesQuery += ` GROUP BY day`;

    db.all(spendQuery, [from, to], (errSpend, spendRows) => {
        if (errSpend) return res.status(500).json({ error: errSpend.message });

        db.all(salesQuery, [from, to], (errSales, salesRows) => {
            if (errSales) return res.status(500).json({ error: errSales.message });

            db.all(dailySpendQuery, [from, to], (errDailySpend, dailySpendRows) => {
                if (errDailySpend) return res.status(500).json({ error: errDailySpend.message });

                db.all(dailySalesQuery, [from, to], (errDailySales, dailySalesRows) => {
                    if (errDailySales) return res.status(500).json({ error: errDailySales.message });

                    // دمج البيانات ومقارنتها بالـ Campaign ID أو الاسم كخيار احتياطي
                    const campaignsMap = {};

                    // 1. ملء بيانات الصرف
                    spendRows.forEach(s => {
                        const baseCampaignId = s.campaign_id.split('_')[0];
                        // نقوم بالتخزين بالـ ID والـ Name لتمكين المطابقة الثنائية
                        const keyId = `${s.platform}_id_${baseCampaignId}`;
                        const keyName = `${s.platform}_name_${(s.campaign_name || '').toLowerCase().trim()}`;
                        
                        const campaignObj = {
                            platform: s.platform,
                            campaign_id: baseCampaignId,
                            campaign_name: s.campaign_name,
                            status: s.status || 'active',
                            spend: s.total_spend || 0,
                            impressions: s.total_impressions || 0,
                            clicks: s.total_clicks || 0,
                            orders: 0,
                            sales: 0,
                            purchase_value: s.total_purchase_value || 0,
                            purchases: s.total_purchases || 0,
                            effective_status: s.effective_status || s.status,
                            objective: s.objective || ''
                        };

                        if (baseCampaignId) campaignsMap[keyId] = campaignObj;
                        campaignsMap[keyName] = campaignObj;
                    });

                    // 2. ملء بيانات المبيعات الفعلية المسندة
                    salesRows.forEach(sa => {
                        const baseCampaignId = sa.campaign_id || '';
                        const baseCampaignName = (sa.campaign_name || '').toLowerCase().trim();
                        
                        const keyId = `${sa.platform}_id_${baseCampaignId}`;
                        const keyName = `${sa.platform}_name_${baseCampaignName}`;

                        // نحاول المطابقة بالـ ID أولاً، ثم بالاسم كاحتياط
                        let campaignObj = null;
                        if (baseCampaignId && campaignsMap[keyId]) {
                            campaignObj = campaignsMap[keyId];
                        } else if (baseCampaignName && campaignsMap[keyName]) {
                            campaignObj = campaignsMap[keyName];
                        }

                        if (!campaignObj) {
                            campaignObj = {
                                platform: sa.platform,
                                campaign_id: baseCampaignId,
                                campaign_name: sa.campaign_name || 'حملة غير مصنفة',
                                status: 'paused',
                                spend: 0,
                                impressions: 0,
                                clicks: 0,
                                orders: 0,
                                sales: 0,
                                purchase_value: 0,
                                purchases: 0,
                                effective_status: 'PAUSED',
                                objective: ''
                            };
                            if (baseCampaignId) campaignsMap[keyId] = campaignObj;
                            if (baseCampaignName) campaignsMap[keyName] = campaignObj;
                        }
                        
                        campaignObj.orders += sa.orders_count || 0;
                        campaignObj.sales += sa.sales_amount || 0;
                    });

                    // تصفية الكائنات الفريدة لمنع التكرار الناتج عن حفظ كبسات المفاتيح المتعددة لنفس الحملة
                    const uniqueCampaigns = Array.from(new Set(Object.values(campaignsMap)));

                    const campaignsList = uniqueCampaigns.map(c => {
                        const roas = c.spend > 0 ? (c.sales / c.spend) : 0;
                        const cpa = c.orders > 0 ? (c.spend / c.orders) : 0;
                        return {
                            ...c,
                            roas: parseFloat(roas.toFixed(2)),
                            cpa: parseFloat(cpa.toFixed(2))
                        };
                    });

                    // 3. تجميع الإحصائيات اليومية
                    const dailyMap = {};
                    dailySpendRows.forEach(ds => {
                        dailyMap[ds.day] = { date: ds.day, spend: ds.total_spend || 0, sales: 0 };
                    });
                    dailySalesRows.forEach(ds => {
                        if (!dailyMap[ds.day]) {
                            dailyMap[ds.day] = { date: ds.day, spend: 0, sales: 0 };
                        }
                        dailyMap[ds.day].sales += ds.total_sales || 0;
                    });
                    const dailyList = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

                    res.json({
                        success: true,
                        from,
                        to,
                        campaigns: campaignsList,
                        daily: dailyList
                    });
                });
            });
        });
    });
});

module.exports = router;
