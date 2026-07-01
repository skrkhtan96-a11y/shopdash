const express = require('express');
const router = express.Router();
const db = require('../config/db');
const axios = require('axios');
const { authenticateUser } = require('../middlewares/auth');
const { encryptToken } = require('../utils/crypto');
const FacebookService = require('../services/facebook.service');
const TikTokService = require('../services/tiktok.service');

// helper: classification of quality
function classifyDataQuality(row) {
    if (row.real_orders === 0 && row.total_spend > 0) return 'no_attribution';
    if (row.real_orders > 0 && row.attribution_rate > 2) return 'good';
    if (row.real_orders > 0) return 'partial';
    return 'unknown';
}

// helper: get dashboard data
function getCampaignDashboardData(from, to, campaignIds = null) {
    return new Promise((resolve, reject) => {
        let query = `
            SELECT
                cs.platform,
                cs.campaign_id,
                cs.campaign_name,

                -- بيانات المنصة الخام
                SUM(cs.spend)               AS total_spend,
                SUM(cs.impressions)         AS total_impressions,
                SUM(cs.clicks)             AS total_clicks,

                -- أرقام المنصة للمقارنة
                SUM(cs.platform_purchases)  AS platform_orders,
                SUM(cs.platform_revenue)    AS platform_revenue,

                -- الطلبات الحقيقية من الإسناد
                COUNT(DISTINCT oa.order_id) AS real_orders,
                COALESCE(SUM(oi.amount), 0)  AS real_revenue,

                -- الحسابات الحقيقية
                COALESCE(ROUND(SUM(oi.amount) / NULLIF(SUM(cs.spend), 0), 2), 0) AS real_roas,
                COALESCE(ROUND(SUM(cs.spend) / NULLIF(COUNT(DISTINCT oa.order_id), 0), 2), 0) AS real_cpa,
                COALESCE(ROUND(SUM(cs.spend) / NULLIF(SUM(cs.clicks), 0), 2), 0) AS cpc,
                COALESCE(ROUND(SUM(cs.clicks) * 100.0 / NULLIF(SUM(cs.impressions), 0), 2), 0) AS ctr,

                -- صافي الربح = إيراد حقيقي − صرف − تكلفة المنتجات
                COALESCE(ROUND(
                    COALESCE(SUM(oi.amount), 0)
                    - SUM(cs.spend)
                    - (COUNT(DISTINCT oa.order_id) * COALESCE(ip.avg_cost, 0)),
                2), -SUM(cs.spend)) AS net_profit

            FROM campaign_spend cs

            LEFT JOIN order_attribution oa
                ON oa.campaign_id = cs.campaign_id
                AND DATE(oa.created_at) BETWEEN ? AND ?

            LEFT JOIN salla_imported_orders oi
                ON oi.reference_id = oa.order_id
                AND oi.status_slug NOT IN ('cancelled', 'refunded')

            LEFT JOIN (
                SELECT
                    AVG(amt / NULLIF(quantity, 0)) AS avg_cost
                FROM expenses
                WHERE cat = 'مشتريات'
            ) ip ON 1=1

            WHERE cs.date BETWEEN ? AND ?
        `;
        const params = [from, to, from, to];

        if (campaignIds && Array.isArray(campaignIds) && campaignIds.length > 0) {
            const placeholders = campaignIds.map(() => '?').join(',');
            query += ` AND cs.campaign_id IN (${placeholders})`;
            params.push(...campaignIds);
        }

        query += " GROUP BY cs.platform, cs.campaign_id, cs.campaign_name ORDER BY total_spend DESC";

        db.all(query, params, (err, rows) => {
            if (err) return reject(err);
            
            const enriched = rows.map(row => ({
                ...row,
                attribution_rate: row.total_clicks > 0
                    ? Math.round((row.real_orders / row.total_clicks) * 100)
                    : 0,
                data_quality: classifyDataQuality(row),
                order_discrepancy: row.platform_orders - row.real_orders
            }));
            resolve(enriched);
        });
    });
}

// ─── POST /api/campaigns/config ───
// حفظ إعدادات الربط الإعلاني (مع التشفير المسبق)
router.post('/config', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'غير مصرح للقيام بهذه العملية.' });
    }
    const { platform, account_id, access_token, extra_config } = req.body;
    if (!platform || !account_id || !access_token) {
        return res.status(400).json({ error: 'الرجاء تزويد المنصة، معرّف الحساب، والتوكن.' });
    }

    try {
        const encryptedToken = encryptToken(access_token);
        const extraJson = extra_config ? JSON.stringify(extra_config) : null;

        db.run(`
            INSERT INTO ad_platform_config (platform, account_id, access_token, extra_config, is_active)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(platform) DO UPDATE SET
                account_id = excluded.account_id,
                access_token = excluded.access_token,
                extra_config = excluded.extra_config,
                is_active = 1,
                last_verified = datetime('now')
        `, [platform, account_id, encryptedToken, extraJson], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: `تم حفظ وتفعيل إعدادات ${platform} بنجاح.` });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── GET /api/campaigns/config/:platform ───
// التحقق من حالة الربط الإعلاني لمنصة محددة
router.get('/config/:platform', authenticateUser, (req, res) => {
    const { platform } = req.params;
    db.get("SELECT platform, account_id, is_active, last_verified FROM ad_platform_config WHERE platform = ?", [platform], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, config: row || null });
    });
});

// ─── POST /api/campaigns/sync ───
// جلب ومزامنة البيانات الخام من المنصات وحفظها
router.post('/sync', authenticateUser, async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية مزامنة الحملات الإعلانية.' });
    }

    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];

    const results = { meta: 0, tiktok: 0, errors: [] };

    // 1. مزامنة Meta Ads
    try {
        const metaRows = await FacebookService.fetchMetaCampaignInsights(from, to);
        for (const row of metaRows) {
            await upsertCampaignSpend(row);
            results.meta++;
        }
    } catch (e) {
        results.errors.push({ platform: 'meta', error: e.message });
    }

    // 2. مزامنة TikTok Ads
    try {
        const tikTokRows = await TikTokService.fetchTikTokCampaignInsights(from, to);
        for (const row of tikTokRows) {
            await upsertCampaignSpend(row);
            results.tiktok++;
        }
    } catch (e) {
        results.errors.push({ platform: 'tiktok', error: e.message });
    }

    res.json({ success: true, synced: results, period: { from, to } });
});

// ─── GET /api/campaigns/dashboard ───
// عرض تقرير الأداء الموحد (دمج الإنفاق مع الإسناد)
router.get('/dashboard', authenticateUser, async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض تقارير الحملات.' });
    }

    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];

    try {
        const campaigns = await getCampaignDashboardData(from, to);

        const dailySpendQuery = `
            SELECT date(date) as day, SUM(spend) as total_spend 
            FROM campaign_spend
            WHERE date(date) >= date(?) AND date(date) <= date(?)
            GROUP BY day
        `;

        const dailySalesQuery = `
            SELECT date(o.date) as day, SUM(o.amount) as total_sales
            FROM order_attribution oa
            JOIN salla_imported_orders o ON o.reference_id = oa.order_id OR o.reference_id LIKE oa.order_id || '_%'
            WHERE date(o.date) >= date(?) AND date(o.date) <= date(?)
              AND o.status_slug NOT IN ('cancelled', 'refunded', 'returned')
            GROUP BY day
        `;

        db.all(dailySpendQuery, [from, to], (errDS, spendRows) => {
            if (errDS) return res.status(500).json({ error: errDS.message });
            db.all(dailySalesQuery, [from, to], (errSO, salesRows) => {
                if (errSO) return res.status(500).json({ error: errSO.message });

                const daysMap = {};
                spendRows.forEach(r => {
                    daysMap[r.day] = { date: r.day, spend: r.total_spend || 0, sales: 0 };
                });
                salesRows.forEach(r => {
                    if (!daysMap[r.day]) {
                        daysMap[r.day] = { date: r.day, spend: 0, sales: r.total_sales || 0 };
                    } else {
                        daysMap[r.day].sales = r.total_sales || 0;
                    }
                });

                const daily = Object.values(daysMap).sort((a,b) => a.date.localeCompare(b.date));
                res.json({ success: true, data: campaigns, daily });
            });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── POST /api/campaigns/analyze ───
// تحليل البيانات الحقيقية باستخدام الذكاء الاصطناعي (Claude)
router.post('/analyze', authenticateUser, async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تحليل الحملات.' });
    }

    const { from, to, campaign_ids } = req.body;
    if (!from || !to) {
        return res.status(400).json({ error: 'الرجاء إدخال تاريخ البداية والنهاية.' });
    }

    try {
        const campaigns = await getCampaignDashboardData(from, to, campaign_ids);
        if (!campaigns.length) {
            return res.json({
                success: false,
                error: 'لا توجد بيانات صرف للحملات في هذه الفترة — يرجى مزامنة البيانات أولاً.'
            });
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return res.json({
                success: false,
                error: 'التحليل الذكي غير متاح حالياً. يرجى إضافة مفتاح ANTHROPIC_API_KEY في ملف التكوين .env لتشغيل Claude.'
            });
        }

        const context = buildAnalysisContext(campaigns, from, to);

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 2000,
            system: `أنت محلل إعلانات رقمية متخصص في متاجر سلة السعودية.
تحلل بيانات حملات Meta وTikTok الحقيقية من نظام إسناد first-party.
الأرقام التي تراها هي الطلبات الفعلية المؤكدة — ليست أرقام المنصة المضخّمة.
قدّم تحليلاً مباشراً وقابلاً للتنفيذ باللغة العربية مع إعطاء توصيات واضحة ومحددة.`,
            messages: [{
                role: 'user',
                content: context
            }]
        }, {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            }
        });

        const claude = response.data || {};
        const analysis = claude.content?.[0]?.text || 'تعذّر استرجاع التحليل.';

        // حفظ التحليل في قاعدة البيانات للأرشيف
        db.run(`
            INSERT INTO campaign_analyses (period_from, period_to, campaigns_count, analysis_text, data_snapshot)
            VALUES (?, ?, ?, ?, ?)
        `, [from, to, campaigns.length, analysis, JSON.stringify(campaigns)]);

        res.json({
            success: true,
            analysis,
            campaigns,
            period: { from, to },
            generated: new Date().toISOString()
        });
    } catch (e) {
        console.error("AI Analysis failed:", e.message);
        res.status(500).json({ error: e.response?.data?.error?.message || e.message });
    }
});

function buildAnalysisContext(campaigns, from, to) {
    const totalSpend   = campaigns.reduce((s, c) => s + (c.total_spend || 0), 0);
    const totalOrders  = campaigns.reduce((s, c) => s + (c.real_orders || 0), 0);
    const totalRevenue = campaigns.reduce((s, c) => s + (c.real_revenue || 0), 0);
    const totalProfit  = campaigns.reduce((s, c) => s + (c.net_profit || 0), 0);

    const campaignDetails = campaigns.map((c, i) => `
${i + 1}. ${c.campaign_name} (${c.platform})
   الصرف: ${c.total_spend?.toFixed(2)} ريال
   الطلبات الحقيقية: ${c.real_orders} طلب (مؤكدة من نظام الإسناد)
   أرقام المنصة للمقارنة: ${c.platform_orders} (قد تكون مضخّمة)
   الإيراد الحقيقي: ${c.real_revenue?.toFixed(2)} ريال
   ROAS الحقيقي: ${c.real_roas}x
   CPA الحقيقي: ${c.real_cpa?.toFixed(2)} ريال/طلب
   صافي الربح: ${c.net_profit?.toFixed(2)} ريال
   CTR: ${c.ctr}%  |  CPC: ${c.cpc?.toFixed(2)} ريال
   جودة البيانات: ${translateQuality(c.data_quality)}
`).join('\n');

    return `
تحليل حملات إعلانية للفترة: ${from} إلى ${to}

=== الملخص الإجمالي ===
إجمالي الصرف: ${totalSpend.toFixed(2)} ريال
إجمالي الطلبات الحقيقية: ${totalOrders} طلب
إجمالي الإيراد: ${totalRevenue.toFixed(2)} ريال
صافي الربح الإجمالي: ${totalProfit.toFixed(2)} ريال
ROAS الإجمالي: ${totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : 0}x

=== تفاصيل الحملات ===
${campaignDetails}

=== المطلوب منك ===
١. قيّم أداء كل حملة بناءً على ROAS وصافي الربح الحقيقي
٢. حدّد الحملات الرابحة وغير الرابحة بوضوح
٣. قدّم ٣-٥ توصيات عملية محددة (ليست عامة)
٤. إذا كانت جودة بيانات حملة "بدون إسناد" — نبّه بأن أرقامها تقديرية فقط
٥. اقترح توزيع الميزانية للشهر القادم
`;
}

function translateQuality(q) {
    return { good: 'جيدة', partial: 'جزئية', no_attribution: 'بدون إسناد', unknown: 'غير محددة' }[q] || q;
}

function upsertCampaignSpend(row) {
    return new Promise((resolve, reject) => {
        db.run(`
            INSERT INTO campaign_spend
                (platform, account_id, campaign_id, campaign_name,
                 adset_id, adset_name, date, spend, impressions, clicks,
                 platform_purchases, platform_revenue, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(platform, campaign_id, date) DO UPDATE SET
                spend              = excluded.spend,
                impressions        = excluded.impressions,
                clicks             = excluded.clicks,
                platform_purchases = excluded.platform_purchases,
                platform_revenue   = excluded.platform_revenue,
                updated_at         = excluded.updated_at
        `, [
            row.platform, row.account_id, row.campaign_id, row.campaign_name,
            row.adset_id, row.adset_name, row.date, row.spend,
            row.impressions, row.clicks, row.platform_purchases,
            row.platform_revenue
        ], (err) => err ? reject(err) : resolve());
    });
}

module.exports = router;
