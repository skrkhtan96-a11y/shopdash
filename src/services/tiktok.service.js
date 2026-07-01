const axios = require('axios');
const db = require('../config/db');
const { decryptToken } = require('../utils/crypto');

async function getTikTokConfig() {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM ad_platform_config WHERE platform = 'tiktok' AND is_active = 1", [], (err, row) => {
            if (!err && row) {
                try {
                    const decrypted = decryptToken(row.access_token);
                    return resolve({
                        account_id: row.account_id,
                        access_token: decrypted
                    });
                } catch (e) {
                    console.error("Failed to decrypt tiktok config token:", e);
                }
            }
            // Fallback to ads_connections
            db.get("SELECT * FROM ads_connections WHERE platform = 'tiktok' AND status = 'connected'", [], (err2, row2) => {
                if (err2 || !row2) resolve(null);
                else {
                    resolve({
                        account_id: row2.account_id,
                        access_token: row2.access_token
                    });
                }
            });
        });
    });
}

const TikTokService = {
    fetchLiveCampaigns: async (token, advertiserId, fromDate, toDate) => {
        try {
            const ids = String(advertiserId).split(',');
            let allResults = [];
            for (const id of ids) {
                const trimmedId = id.trim();
                if (!trimmedId) continue;
                const results = await TikTokService.fetchSingleAdvertiserCampaigns(token, trimmedId, fromDate, toDate);
                if (results && results.length > 0) {
                    allResults = allResults.concat(results);
                }
            }
            return allResults;
        } catch (e) {
            console.error("[TikTokService] Failed to fetch live TikTok campaigns:", e.message);
            return null;
        }
    },
    
    fetchSingleAdvertiserCampaigns: async (token, advertiserId, fromDate, toDate) => {
        try {
            const todayStr = new Date().toISOString().split('T')[0];
            const start = fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const end = toDate || todayStr;

            console.log(`[TikTokService] Fetching campaigns metadata for advertiser: ${advertiserId}...`);
            
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
                console.error("[TikTokService] TikTok Campaign Get API error:", campaignsRes.data ? campaignsRes.data.message : 'Unknown');
                return null;
            }

            const chunks = [];
            let curr = new Date(start);
            const endLimit = new Date(end);
            while (curr <= endLimit) {
                const chunkEnd = new Date(curr);
                chunkEnd.setDate(chunkEnd.getDate() + 29);
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

            for (const chunk of chunks) {
                console.log(`[TikTokService] Fetching report metrics from ${chunk.start} to ${chunk.end}...`);
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
                        const date = dateRaw.split(' ')[0];
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
                    console.error("[TikTokService] TikTok Reporting API error for chunk:", chunk, reportRes.data ? reportRes.data.message : 'Unknown');
                }
            }

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
            console.error("[TikTokService] Failed to fetch live TikTok campaigns and reports:", e.message);
            return null;
        }
    },

    fetchTikTokCampaignInsights: async (dateFrom, dateTo) => {
        const config = await getTikTokConfig();
        if (!config) throw new Error('TikTok غير مُهيَّأ');

        const token = config.access_token;
        const accountId = config.account_id;

        const body = {
            advertiser_id: accountId,
            report_type: 'BASIC',
            data_level: 'AUCTION_ADGROUP',
            dimensions: ['adgroup_id', 'stat_time_day'],
            metrics: [
                'campaign_id', 'campaign_name',
                'adgroup_id', 'adgroup_name',
                'spend', 'impressions', 'clicks',
                'real_time_conversion',
                'real_time_value'
            ],
            start_date: dateFrom,
            end_date: dateTo,
            page_size: 1000
        };

        const response = await axios.post('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/', body, {
            headers: {
                'Access-Token': token,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data || {};
        if (data.code !== 0) throw new Error(`TikTok error: ${data.message}`);

        return (data.data?.list || []).map(row => ({
            platform: 'tiktok',
            account_id: accountId,
            campaign_id: row.dimensions?.campaign_id || row.metrics?.campaign_id,
            campaign_name: row.metrics?.campaign_name,
            adset_id: row.dimensions?.adgroup_id,
            adset_name: row.metrics?.adgroup_name,
            date: row.dimensions?.stat_time_day?.split(' ')[0],
            spend: parseFloat(row.metrics?.spend || 0),
            impressions: parseInt(row.metrics?.impressions || 0),
            clicks: parseInt(row.metrics?.clicks || 0),
            platform_purchases: parseInt(row.metrics?.real_time_conversion || 0),
            platform_revenue: parseFloat(row.metrics?.real_time_value || 0),
        }));
    }
};

module.exports = TikTokService;
