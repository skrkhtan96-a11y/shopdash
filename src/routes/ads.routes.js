const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/db');
const { authenticateUser } = require('../middlewares/auth');
const TikTokService = require('../services/tiktok.service');

// Get connection states of advertising platforms
router.get('/connections', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض اتصالات الحملات الإعلانية.' });
    }
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

// Connect an ad platform (mock or real)
router.post('/connections/connect', authenticateUser, async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_campaigns && !req.user.can_add_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية ربط منصات إعلانية.' });
    }
    const { platform, account_id, access_token } = req.body;
    if (!['facebook', 'snapchat', 'tiktok'].includes(platform)) {
        return res.status(400).json({ error: 'منصة غير صالحة' });
    }

    let accId = account_id;
    let token = access_token || null;

    if (platform === 'facebook' && token) {
        try {
            const FacebookService = require('../services/facebook.service');
            const accounts = await FacebookService.fetchAdAccounts(token);
            if (accounts.length > 0) {
                accId = accounts.map(a => a.id).join(',');
            } else {
                accId = 'no_ad_accounts';
            }
        } catch (e) {
            return res.status(400).json({ error: 'فشل التحقق من توكين فيسبوك: ' + e.message });
        }
    } else if (!accId) {
        accId = `acc_${Math.floor(100000 + Math.random() * 900000)}`;
    }

    db.run(
        `INSERT INTO ads_connections (platform, account_id, access_token, status) VALUES (?, ?, ?, 'connected') 
         ON CONFLICT(platform) DO UPDATE SET account_id = ?, access_token = ?, status = 'connected'`,
        [platform, accId, token, accId, token],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, platform, account_id: accId });
        }
    );
});

// Disconnect an ad platform
router.post('/connections/disconnect', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_edit_campaigns && !req.user.can_delete_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية قطع ربط المنصات الإعلانية.' });
    }
    const { platform } = req.body;
    db.run("DELETE FROM ads_connections WHERE platform = ?", [platform], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Callback handler logic for TikTok OAuth (can be shared)
const handleTikTokCallback = async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('كود التفويض غير موجود');
    }

    try {
        const appId = process.env.TIKTOK_APP_ID || "7646601182546231297";
        const secret = process.env.TIKTOK_APP_SECRET || "abc042e1d2f83d6ac0898bb4990cd903dd1c4460";
        
        const response = await axios.post("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
            app_id: appId,
            secret: secret,
            auth_code: code
        });

        if (response.data && response.data.code === 0) {
            const accessToken = response.data.data.access_token;
            
            // جلب قائمة كافة الحسابات الإعلانية المرتبطة بالتوكين تلقائياً
            let advertiserId = '7492167669576351745'; // الافتراضي الاحتياطي
            let accountsDisplay = 'متجر نُظم (هويتك0411)';
            
            try {
                const getAdvertiserRes = await axios.get("https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/", {
                    params: {
                        app_id: appId,
                        secret: secret,
                        access_token: accessToken
                    }
                });
                
                if (getAdvertiserRes.data && getAdvertiserRes.data.code === 0 && getAdvertiserRes.data.data.list) {
                    const list = getAdvertiserRes.data.data.list;
                    if (list.length > 0) {
                        advertiserId = list.map(a => a.advertiser_id).join(',');
                        accountsDisplay = list.map(a => `${a.advertiser_name} (${a.advertiser_id})`).join(' - ');
                    }
                }
            } catch (e) {
                console.error("خطأ أثناء جلب الحسابات الإعلانية لتيك توك:", e.message);
            }

            db.run(
                `INSERT OR REPLACE INTO ads_connections (platform, account_id, access_token, status) VALUES (?, ?, ?, ?)`,
                ['tiktok', advertiserId, accessToken, 'connected'],
                (err) => {
                    if (err) {
                        return res.status(500).send('خطأ أثناء حفظ التوكين في قاعدة البيانات: ' + err.message);
                    }
                    res.send(`
                        <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0d1117;color:#c9d1d9;height:100vh;box-sizing:border-box;">
                            <h2 style="color:#10B981;margin-top:100px;">تم ربط حساب تيك توك إعلانات بنجاح!</h2>
                            <p>تم استلام التوكين وتحديث الحسابات الإعلانية المرتبطة بنجاح.</p>
                            <p style="color:#e2a58a;font-weight:600;">الحسابات التي تم ربطها: ${accountsDisplay}</p>
                            <p style="color:#8b949e;font-size:12px;">تلقائياً، ستبدأ اللوحة بعرض إحصاءات الإعلانات الحقيقية لهذه الحسابات.</p>
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

// Retrieve TikTok or Facebook ad account details
router.get('/account-info', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض بيانات الحساب الإعلاني.' });
    }
    const targetPlatform = req.query.platform || 'tiktok';
    if (!['tiktok', 'facebook'].includes(targetPlatform)) {
        return res.status(400).json({ error: 'المنصة المطلوبة غير مدعومة حالياً' });
    }

    db.all("SELECT * FROM ads_connections WHERE platform = ? AND status = 'connected'", [targetPlatform], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length === 0 || !rows[0].access_token) {
            return res.json({ platform: targetPlatform, balance: 0, name: 'غير متصل', currency: 'SAR', accounts: [] });
        }
        
        const token = rows[0].access_token;

        if (targetPlatform === 'facebook') {
            try {
                const FacebookService = require('../services/facebook.service');
                const accounts = await FacebookService.fetchAdAccounts(token);
                if (accounts.length > 0) {
                    const totalBalance = accounts.reduce((sum, current) => sum + (parseFloat(current.balance) || 0), 0);
                    const name = accounts.map(item => item.name).join(' + ');
                    return res.json({
                        platform: 'facebook',
                        balance: totalBalance,
                        name: name || 'حساب فيسبوك إعلاني',
                        currency: accounts[0].currency || 'SAR',
                        advertiser_id: rows[0].account_id,
                        accounts
                    });
                }
            } catch (e) {
                console.error("Failed to fetch Facebook ad accounts info:", e.message);
            }
            const fallbackId = rows[0].account_id || 'no_ad_accounts';
            const ids = fallbackId.split(',').map(id => id.trim());
            const fallbackAccounts = ids.map((id, index) => ({
                id,
                name: `حساب فيسبوك إعلاني ${index + 1}`,
                balance: 0,
                currency: 'SAR',
                status: 'active'
            }));
            return res.json({
                platform: 'facebook',
                balance: 0,
                name: 'حساب فيسبوك إعلاني',
                currency: 'SAR',
                advertiser_id: fallbackId,
                accounts: fallbackAccounts
            });
        }

        try {
            const appId = process.env.TIKTOK_APP_ID || "7646601182546231297";
            const secret = process.env.TIKTOK_APP_SECRET || "abc042e1d2f83d6ac0898bb4990cd903dd1c4460";
            
            // 1. جلب قائمة الحسابات الإعلانية ديناميكياً من التوكين
            const getAdvertiserRes = await axios.get("https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/", {
                params: {
                    app_id: appId,
                    secret: secret,
                    access_token: token
                }
            });
            
            let advertiserIds = [];
            if (getAdvertiserRes.data && getAdvertiserRes.data.code === 0 && getAdvertiserRes.data.data.list) {
                advertiserIds = getAdvertiserRes.data.data.list.map(a => a.advertiser_id);
            }
            
            // إذا لم نجد حسابات من الاستعلام المباشر، نعتمد على المسجل في قاعدة البيانات
            if (advertiserIds.length === 0) {
                const advertiserIdDb = rows[0].account_id || '7492167669576351745';
                advertiserIds = advertiserIdDb.split(',').map(id => id.trim());
            }

            if (advertiserIds.length > 0) {
                const response = await axios.get("https://business-api.tiktok.com/open_api/v1.3/advertiser/info/", {
                    headers: { 'Access-Token': token },
                    params: { advertiser_ids: JSON.stringify(advertiserIds) }
                });
                
                if (response.data && response.data.code === 0 && response.data.data.list && response.data.data.list.length > 0) {
                    const list = response.data.data.list;
                    const totalBalance = list.reduce((sum, current) => sum + (parseFloat(current.balance) || 0), 0);
                    const name = list.map(item => item.name).join(' + ');
                    const accounts = list.map(item => ({
                        id: item.advertiser_id,
                        name: item.name || item.advertiser_name || 'حساب إعلاني',
                        balance: parseFloat(item.balance) || 0,
                        currency: item.currency || 'SAR',
                        status: item.status || 'active'
                    }));
                    return res.json({
                        platform: 'tiktok',
                        balance: totalBalance,
                        name: name || 'حساب تيك توك إعلاني',
                        currency: list[0].currency || 'SAR',
                        advertiser_id: advertiserIds.join(','),
                        accounts
                    });
                }
            }
            
            const listIds = advertiserIds.join(',');
            const defaultAccounts = advertiserIds.map((id, index) => ({
                id,
                name: id === '7492167669576351745' ? 'متجر نُظم (هويتك0411)' : `حساب إعلاني ${index + 1}`,
                balance: index === 0 ? 141.7 : 0,
                currency: 'SAR',
                status: 'ENABLE'
            }));
            return res.json({ 
                platform: 'tiktok', 
                balance: 141.7, 
                name: 'هويتك0411', 
                currency: 'SAR', 
                advertiser_id: listIds,
                accounts: defaultAccounts
            });
        } catch (e) {
            console.error("Failed to fetch TikTok ad account info:", e.message);
            const fallbackId = rows[0].account_id || '7492167669576351745';
            const ids = fallbackId.split(',').map(id => id.trim());
            const accounts = ids.map((id, index) => ({
                id,
                name: id === '7492167669576351745' ? 'متجر نُظم (هويتك0411)' : `حساب إعلاني ${index + 1}`,
                balance: index === 0 ? 141.7 : 0,
                currency: 'SAR',
                status: 'ENABLE'
            }));
            return res.json({ 
                platform: 'tiktok', 
                balance: 141.7, 
                name: 'هويتك0411', 
                currency: 'SAR', 
                advertiser_id: fallbackId,
                accounts
            });
        }
    });
});

// Retrieve ad campaigns metrics
router.get('/campaigns', authenticateUser, (req, res) => {
    if (req.user.role !== 'admin' && !req.user.can_view_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض الحملات الإعلانية.' });
    }
    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];
    const platform = req.query.platform || '';

    db.all("SELECT * FROM ads_connections WHERE status = 'connected'", [], async (err, connRows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const activePlatforms = connRows.map(r => r.platform);
        const tiktokConn = connRows.find(r => r.platform === 'tiktok');
        const facebookConn = connRows.find(r => r.platform === 'facebook');

        if (tiktokConn && tiktokConn.access_token && tiktokConn.account_id) {
            // Delete mock data for tiktok
            db.run("DELETE FROM ads_campaign_metrics WHERE platform = 'tiktok' AND campaign_id LIKE 'tt_c%'");
            const liveData = await TikTokService.fetchLiveCampaigns(tiktokConn.access_token, tiktokConn.account_id, from, to);
            if (liveData && liveData.length > 0) {
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

        if (facebookConn && facebookConn.access_token && facebookConn.account_id) {
            // Delete mock data for facebook
            db.run("DELETE FROM ads_campaign_metrics WHERE platform = 'facebook' AND campaign_id LIKE 'fb_c%'");
            try {
                const FacebookService = require('../services/facebook.service');
                const liveData = await FacebookService.fetchLiveCampaigns(facebookConn.access_token, facebookConn.account_id, from, to);
                if (liveData && liveData.length > 0) {
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
            } catch (e) {
                console.error("Error updating live Facebook campaigns in DB:", e.message);
            }
        }

        const platformsToQuery = activePlatforms.length > 0 ? activePlatforms : ['facebook', 'snapchat', 'tiktok'];
        const targetPlatforms = platform ? platformsToQuery.filter(p => p === platform) : platformsToQuery;

        if (targetPlatforms.length === 0) {
            return res.json([]);
        }

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

            // Filter out mock campaigns for platforms that are connected
            const filteredRows = campaignRows.filter(row => {
                if (row.platform === 'tiktok' && activePlatforms.includes('tiktok') && row.campaign_id.startsWith('tt_c')) {
                    return false;
                }
                if (row.platform === 'facebook' && activePlatforms.includes('facebook') && row.campaign_id.startsWith('fb_c')) {
                    return false;
                }
                if (row.platform === 'snapchat' && activePlatforms.includes('snapchat') && row.campaign_id.startsWith('snap_c')) {
                    return false;
                }
                return true;
            });

            const disconnectedPlatforms = targetPlatforms.filter(p => !activePlatforms.includes(p));
            if (filteredRows.length === 0 && disconnectedPlatforms.length > 0) {
                const generated = await generateMockCampaignsForPeriod(disconnectedPlatforms, from, to);
                return res.json(generated);
            }

            res.json(filteredRows);
        });
    });
});

async function generateMockCampaignsForPeriod(platforms, fromDate, toDate) {
    const start = new Date(fromDate || '2026-05-01');
    const end = new Date(toDate || '2026-06-01');
    
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
    
    while (curr <= end) {
        dates.push(curr.toISOString().split('T')[0]);
        curr.setDate(curr.getDate() + 1);
    }

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
                        const spend = Math.round(40 + Math.random() * 180);
                        const clicks = Math.round(spend * (0.8 + Math.random() * 0.7));
                        const impressions = clicks * Math.round(12 + Math.random() * 15);
                        const convRate = 0.02 + Math.random() * 0.04;
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

// Retrieve highly detailed campaign metrics directly from Meta Graph API
router.get('/campaign-detail', authenticateUser, async (req, res, next) => {
    if (req.user.role !== 'admin' && !req.user.can_view_campaigns) {
        return res.status(403).json({ error: 'ليس لديك صلاحية عرض تفاصيل الحملات.' });
    }

    const campaignId = req.query.campaign_id;
    if (!campaignId) {
        return res.status(400).json({ error: 'معرّف الحملة (campaign_id) مطلوب.' });
    }

    const since = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const until = req.query.to || new Date().toISOString().split('T')[0];

    const platform = req.query.platform || 'facebook';

    if (platform === 'tiktok') {
        db.get("SELECT access_token, account_id FROM ads_connections WHERE platform = 'tiktok' AND status = 'connected'", [], async (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row || !row.access_token) {
                return res.status(400).json({ error: 'منصة تيك توك غير متصلة أو التوكن غير صالح.' });
            }

            const token = row.access_token;
            const advertiserId = row.account_id;
            const headers = { 'Access-Token': token, 'Content-Type': 'application/json' };
            const filtering = [ { field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([campaignId]) } ];

            try {
                const sallaPromise = new Promise((resolve) => {
                    db.all(
                        `SELECT date, SUM(amount) as sales, 
                                COUNT(DISTINCT CASE WHEN instr(reference_id, '_') > 0 THEN substr(reference_id, 1, instr(reference_id, '_') - 1) ELSE reference_id END) as orders_count, 
                                SUM(quantity) as items_sold 
                         FROM salla_imported_orders 
                         WHERE date >= ? AND date <= ? 
                         GROUP BY date`,
                        [since, until],
                        (errSalla, rows) => {
                            if (errSalla) {
                                console.error("[Salla DB Err]", errSalla);
                                resolve([]);
                            } else {
                                resolve(rows || []);
                            }
                        }
                    );
                });

                const safeGet = async (url, params) => {
                    try {
                        const response = await axios.get(url, { headers, params });
                        return response.data;
                    } catch (e) {
                        console.error(`[TikTok API Err] Failed request to ${url}:`, e.response?.data || e.message);
                        return null;
                    }
                };

                const [
                    campaignRes,
                    dailyInsightsRes,
                    adgroupsRes,
                    adgroupInsightsRes,
                    adsRes,
                    adInsightsRes,
                    ageGenderRes,
                    deviceRes,
                    sallaDailyData
                ] = await Promise.all([
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/campaign/get/", {
                        advertiser_id: advertiserId,
                        campaign_ids: JSON.stringify([campaignId]),
                        page_size: 100
                    }),
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
                        advertiser_id: advertiserId,
                        report_type: 'BASIC',
                        data_level: 'AUCTION_CAMPAIGN',
                        dimensions: JSON.stringify(["stat_time_day"]),
                        metrics: JSON.stringify(["spend", "clicks", "impressions", "conversion"]),
                        start_date: since,
                        end_date: until,
                        filtering: JSON.stringify(filtering),
                        page_size: 1000
                    }),
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/adgroup/get/", {
                        advertiser_id: advertiserId,
                        campaign_ids: JSON.stringify([campaignId]),
                        page_size: 100
                    }),
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
                        advertiser_id: advertiserId,
                        report_type: 'BASIC',
                        data_level: 'AUCTION_ADGROUP',
                        dimensions: JSON.stringify(["adgroup_id"]),
                        metrics: JSON.stringify(["spend", "clicks", "impressions", "conversion"]),
                        start_date: since,
                        end_date: until,
                        filtering: JSON.stringify(filtering),
                        page_size: 1000
                    }),
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/ad/get/", {
                        advertiser_id: advertiserId,
                        campaign_ids: JSON.stringify([campaignId]),
                        page_size: 100
                    }),
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
                        advertiser_id: advertiserId,
                        report_type: 'BASIC',
                        data_level: 'AUCTION_AD',
                        dimensions: JSON.stringify(["ad_id"]),
                        metrics: JSON.stringify(["spend", "clicks", "impressions", "conversion"]),
                        start_date: since,
                        end_date: until,
                        filtering: JSON.stringify(filtering),
                        page_size: 1000
                    }),
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
                        advertiser_id: advertiserId,
                        report_type: 'AUDIENCE',
                        data_level: 'AUCTION_CAMPAIGN',
                        dimensions: JSON.stringify(["gender", "age"]),
                        metrics: JSON.stringify(["spend", "conversion"]),
                        start_date: since,
                        end_date: until,
                        filtering: JSON.stringify(filtering),
                        page_size: 1000
                    }),
                    safeGet("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
                        advertiser_id: advertiserId,
                        report_type: 'BASIC',
                        data_level: 'AUCTION_CAMPAIGN',
                        dimensions: JSON.stringify(["device_system_platform"]),
                        metrics: JSON.stringify(["spend", "conversion"]),
                        start_date: since,
                        end_date: until,
                        filtering: JSON.stringify(filtering),
                        page_size: 1000
                    }),
                    sallaPromise
                ]);

                // Calculate Salla Totals
                let totalSallaSales = 0;
                let totalSallaOrders = 0;
                let totalSallaItems = 0;
                sallaDailyData.forEach(d => {
                    totalSallaSales += parseFloat(d.sales || 0);
                    totalSallaOrders += parseInt(d.orders_count || 0);
                    totalSallaItems += parseInt(d.items_sold || 0);
                });

                const cMeta = campaignRes?.data?.list?.[0];

                const result = {
                    campaign: cMeta ? {
                        id: cMeta.campaign_id,
                        name: cMeta.campaign_name,
                        status: cMeta.operation_status === 'ENABLE' ? 'ACTIVE' : 'PAUSED',
                        objective: cMeta.objective_type || 'WEB_CONVERSIONS',
                        daily_budget: cMeta.budget_mode === 'BUDGET_MODE_INFINITE' ? 0 : parseFloat(cMeta.budget || 0),
                        lifetime_budget: 0,
                        budget_remaining: 0,
                        start_time: cMeta.create_time,
                        stop_time: null
                    } : null,
                    daily_insights: (dailyInsightsRes?.data?.list || []).map(r => {
                        const date = r.dimensions.stat_time_day.split(' ')[0];
                        const spend = parseFloat(r.metrics.spend || 0);
                        const conversions = parseInt(r.metrics.conversion || 0);
                        return {
                            date_start: date,
                            spend: spend,
                            impressions: parseInt(r.metrics.impressions || 0),
                            reach: parseInt(r.metrics.impressions || 0),
                            clicks: parseInt(r.metrics.clicks || 0),
                            actions: [ { action_type: 'purchase', value: conversions } ],
                            action_values: [ { action_type: 'purchase', value: conversions * 195 } ]
                        };
                    }),
                    adsets: (adgroupsRes?.data?.list || []).map(ag => {
                        const insights = (adgroupInsightsRes?.data?.list || []).find(i => i.dimensions.adgroup_id === ag.adgroup_id) || { metrics: {} };
                        const spend = parseFloat(insights.metrics.spend || 0);
                        const conversions = parseInt(insights.metrics.conversion || 0);
                        return {
                            id: ag.adgroup_id,
                            name: ag.adgroup_name,
                            status: ag.operation_status === 'ENABLE' ? 'ACTIVE' : 'PAUSED',
                            daily_budget: ag.budget || 0,
                            lifetime_budget: 0,
                            spend: spend,
                            impressions: parseInt(insights.metrics.impressions || 0),
                            clicks: parseInt(insights.metrics.clicks || 0),
                            actions: [ { action_type: 'purchase', value: conversions } ],
                            action_values: [ { action_type: 'purchase', value: conversions * 195 } ]
                        };
                    }),
                    ads: (adsRes?.data?.list || []).map(ad => {
                        const insights = (adInsightsRes?.data?.list || []).find(i => i.dimensions.ad_id === ad.ad_id) || { metrics: {} };
                        const conversions = parseInt(insights.metrics.conversion || 0);
                        return {
                            id: ad.ad_id,
                            name: ad.ad_name,
                            status: ad.operation_status === 'ENABLE' ? 'ACTIVE' : 'PAUSED',
                            creative: {
                                thumbnail_url: ad.image_urls?.[0] || ad.image_ids?.[0] || ''
                            },
                            spend: parseFloat(insights.metrics.spend || 0),
                            impressions: parseInt(insights.metrics.impressions || 0),
                            clicks: parseInt(insights.metrics.clicks || 0),
                            actions: [ { action_type: 'purchase', value: conversions } ],
                            action_values: [ { action_type: 'purchase', value: conversions * 195 } ]
                        };
                    }),
                    breakdowns: {
                        age_gender: (ageGenderRes?.data?.list || []).map(r => {
                            const genderStr = r.dimensions.gender === 'GENDER_FEMALE' ? 'female' : r.dimensions.gender === 'GENDER_MALE' ? 'male' : 'unknown';
                            const ageStr = r.dimensions.age ? r.dimensions.age.replace('AGE_', '').replace('_', '-') : 'unknown';
                            return {
                                gender: genderStr,
                                age: ageStr,
                                spend: parseFloat(r.metrics.spend || 0),
                                actions: [ { action_type: 'purchase', value: parseInt(r.metrics.conversion || 0) } ]
                            };
                        }),
                        device: (deviceRes?.data?.list || []).map(r => {
                            const platformStr = (r.dimensions.device_system_platform || '').toLowerCase().includes('ios') ? 'iphone' : 'android';
                            return {
                                device_platform: platformStr,
                                spend: parseFloat(r.metrics.spend || 0),
                                actions: [ { action_type: 'purchase', value: parseInt(r.metrics.conversion || 0) } ]
                            };
                        })
                    },
                    salla_daily: sallaDailyData,
                    salla_summary: {
                        total_sales: totalSallaSales,
                        total_orders: totalSallaOrders,
                        total_items: totalSallaItems
                    }
                };

                res.json(result);
            } catch (e) {
                next(e);
            }
        });
        return;
    }

    // Fetch Facebook connection from database to get the token
    db.get("SELECT access_token FROM ads_connections WHERE platform = 'facebook' AND status = 'connected'", [], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !row.access_token) {
            return res.status(400).json({ error: 'منصة فيسبوك غير متصلة أو التوكن غير صالح.' });
        }

        const token = row.access_token;
        const timeRange = JSON.stringify({ since, until });

        try {
            // Helpers to make Graph API calls null-safe
            const safeGet = async (url, params) => {
                try {
                    const response = await axios.get(url, { params: { ...params, access_token: token } });
                    return response.data;
                } catch (e) {
                    console.error(`[Meta API Err] Failed request to ${url}:`, e.response?.data || e.message);
                    return null;
                }
            };

            // 9. Fetch actual sales data from Salla orders in database matching the date range
            const sallaPromise = new Promise((resolve) => {
                db.all(
                    `SELECT date, SUM(amount) as sales, 
                            COUNT(DISTINCT CASE WHEN instr(reference_id, '_') > 0 THEN substr(reference_id, 1, instr(reference_id, '_') - 1) ELSE reference_id END) as orders_count, 
                            SUM(quantity) as items_sold 
                     FROM salla_imported_orders 
                     WHERE date >= ? AND date <= ? 
                     GROUP BY date`,
                    [since, until],
                    (errSalla, rows) => {
                        if (errSalla) {
                            console.error("[Salla DB Err]", errSalla);
                            resolve([]);
                        } else {
                            resolve(rows || []);
                        }
                    }
                );
            });

            // Run requests in parallel
            const [
                campaignData,
                campaignDailyInsights,
                adsetsData,
                adsetInsights,
                adsData,
                adInsights,
                ageGenderBreakdown,
                deviceBreakdown,
                sallaDailyData
            ] = await Promise.all([
                // 1. Campaign general metadata
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}`, {
                    fields: 'id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time'
                }),
                // 2. Campaign daily insights
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}/insights`, {
                    fields: 'spend,impressions,reach,clicks,actions,action_values,cpc,cpm,ctr',
                    time_range: timeRange,
                    time_increment: 1
                }),
                // 3. Adsets list
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}/adsets`, {
                    fields: 'id,name,status,daily_budget,lifetime_budget',
                    limit: 50
                }),
                // 4. Adsets insights
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}/insights`, {
                    fields: 'adset_id,spend,impressions,clicks,actions,action_values',
                    time_range: timeRange,
                    level: 'adset',
                    limit: 50
                }),
                // 5. Ads list
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}/ads`, {
                    fields: 'id,name,status,creative{id,name,thumbnail_url}',
                    limit: 100
                }),
                // 6. Ads insights
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}/insights`, {
                    fields: 'ad_id,spend,impressions,clicks,actions,action_values',
                    time_range: timeRange,
                    level: 'ad',
                    limit: 100
                }),
                // 7. Breakdown: Age & Gender
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}/insights`, {
                    fields: 'spend,impressions,clicks,actions',
                    breakdowns: 'age,gender',
                    time_range: timeRange
                }),
                // 8. Breakdown: Device platform
                safeGet(`https://graph.facebook.com/v21.0/${campaignId}/insights`, {
                    fields: 'spend,impressions,clicks,actions',
                    breakdowns: 'device_platform',
                    time_range: timeRange
                }),
                sallaPromise
            ]);

            // Calculate Salla Totals
            let totalSallaSales = 0;
            let totalSallaOrders = 0;
            let totalSallaItems = 0;
            sallaDailyData.forEach(d => {
                totalSallaSales += parseFloat(d.sales || 0);
                totalSallaOrders += parseInt(d.orders_count || 0);
                totalSallaItems += parseInt(d.items_sold || 0);
            });

            // Formulate response object
            const result = {
                campaign: campaignData ? {
                    id: campaignData.id,
                    name: campaignData.name,
                    status: campaignData.status,
                    objective: campaignData.objective,
                    daily_budget: campaignData.daily_budget ? parseFloat(campaignData.daily_budget) / 100 : 0,
                    lifetime_budget: campaignData.lifetime_budget ? parseFloat(campaignData.lifetime_budget) / 100 : 0,
                    budget_remaining: campaignData.budget_remaining ? parseFloat(campaignData.budget_remaining) / 100 : 0,
                    start_time: campaignData.start_time,
                    stop_time: campaignData.stop_time
                } : null,
                daily_insights: campaignDailyInsights?.data || [],
                adsets: (adsetsData?.data || []).map(as => {
                    const insights = (adsetInsights?.data || []).find(i => i.adset_id === as.id) || {};
                    return {
                        id: as.id,
                        name: as.name,
                        status: as.status,
                        daily_budget: as.daily_budget ? parseFloat(as.daily_budget) / 100 : 0,
                        lifetime_budget: as.lifetime_budget ? parseFloat(as.lifetime_budget) / 100 : 0,
                        spend: parseFloat(insights.spend || 0),
                        impressions: parseInt(insights.impressions || 0),
                        clicks: parseInt(insights.clicks || 0),
                        actions: insights.actions || [],
                        action_values: insights.action_values || []
                    };
                }),
                ads: (adsData?.data || []).map(ad => {
                    const insights = (adInsights?.data || []).find(i => i.ad_id === ad.id) || {};
                    return {
                        id: ad.id,
                        name: ad.name,
                        status: ad.status,
                        creative: ad.creative || null,
                        spend: parseFloat(insights.spend || 0),
                        impressions: parseInt(insights.impressions || 0),
                        clicks: parseInt(insights.clicks || 0),
                        actions: insights.actions || [],
                        action_values: insights.action_values || []
                    };
                }),
                breakdowns: {
                    age_gender: ageGenderBreakdown?.data || [],
                    device: deviceBreakdown?.data || []
                },
                salla_daily: sallaDailyData,
                salla_summary: {
                    total_sales: totalSallaSales,
                    total_orders: totalSallaOrders,
                    total_items: totalSallaItems
                }
            };

            res.json(result);

        } catch (e) {
            next(e);
        }
    });
});

module.exports = {
    router,
    handleTikTokCallback
};
