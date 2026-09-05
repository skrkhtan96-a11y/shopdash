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

// Request wrappers with exponential backoff retry (3 attempts)
async function requestWithRetryGet(url, options, retries = 3, delay = 1000) {
    try {
        return await axios.get(url, options);
    } catch (e) {
        if (retries > 0) {
            console.warn(`[TikTokService] GET Request failed: ${e.message}. Retrying in ${delay}ms... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return requestWithRetryGet(url, options, retries - 1, delay * 2);
        }
        throw e;
    }
}

async function requestWithRetryPost(url, body, options, retries = 3, delay = 1000) {
    try {
        return await axios.post(url, body, options);
    } catch (e) {
        if (retries > 0) {
            console.warn(`[TikTokService] POST Request failed: ${e.message}. Retrying in ${delay}ms... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return requestWithRetryPost(url, body, options, retries - 1, delay * 2);
        }
        throw e;
    }
}

// Fetch all pages recursively to handle pagination
async function fetchAllTikTokPages(method, url, headers, params, isPost = false) {
    let allList = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        let response;
        const currentParams = { ...params, page, page_size: 100 };
        if (isPost) {
            response = await requestWithRetryPost(url, currentParams, { headers });
        } else {
            response = await requestWithRetryGet(url, { headers, params: currentParams });
        }
        
        const data = response.data || {};
        if (data.code === 0 && data.data) {
            const list = data.data.list || [];
            allList = allList.concat(list);
            
            const pageInfo = data.data.page_info;
            if (pageInfo) {
                if (pageInfo.page >= pageInfo.total_page) {
                    hasMore = false;
                } else {
                    page++;
                }
            } else {
                if (list.length < 100) {
                    hasMore = false;
                } else {
                    page++;
                }
            }
        } else {
            console.error(`[TikTokService] API returned error at page ${page}:`, data.message);
            hasMore = false;
        }
    }
    return allList;
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
            const campaignsList = await fetchAllTikTokPages('GET', "https://business-api.tiktok.com/open_api/v1.3/campaign/get/", { 
                'Access-Token': token,
                'Content-Type': 'application/json'
            }, {
                advertiser_id: advertiserId
            });

            const campaignMeta = {};
            campaignsList.forEach(c => {
                campaignMeta[c.campaign_id] = {
                    name: c.campaign_name,
                    status: c.operation_status === 'ENABLE' ? 'active' : 'paused',
                    budget: parseFloat(c.budget || 0),
                    budget_mode: c.budget_mode || 'BUDGET_MODE_INFINITE',
                    objective: c.objective_type || '',
                    effective_status: c.operation_status || 'DISABLE'
                };
            });

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
                const list = await fetchAllTikTokPages('GET', "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
                    'Access-Token': token,
                    'Content-Type': 'application/json'
                }, {
                    advertiser_id: advertiserId,
                    report_type: 'BASIC',
                    data_level: 'AUCTION_CAMPAIGN',
                    dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
                    metrics: JSON.stringify(["spend", "clicks", "impressions", "conversion"]),
                    start_date: chunk.start,
                    end_date: chunk.end
                });

                list.forEach(r => {
                    const campaignId = r.dimensions.campaign_id;
                    const dateRaw = r.dimensions.stat_time_day;
                    const date = dateRaw.split(' ')[0];
                    const meta = campaignMeta[campaignId] || { 
                        name: 'حملة غير معروفة - TikTok', 
                        status: 'paused',
                        budget: 0,
                        budget_mode: 'BUDGET_MODE_INFINITE',
                        objective: '',
                        effective_status: 'DISABLE'
                    };
                    
                    campaignsInReport.add(campaignId);

                    const purchases = parseInt(r.metrics.conversion || 0);
                    const purchaseValue = 0.00;

                    results.push({
                        campaign_id: campaignId + '_' + date,
                        campaign_name: meta.name,
                        platform: 'tiktok',
                        status: meta.status,
                        spend: parseFloat(r.metrics.spend || 0),
                        clicks: parseInt(r.metrics.clicks || 0),
                        impressions: parseInt(r.metrics.impressions || 0),
                        conversions: purchases,
                        date: date,
                        budget: meta.budget || 0,
                        budget_mode: meta.budget_mode || 'BUDGET_MODE_INFINITE',
                        purchase_value: purchaseValue,
                        purchases: purchases,
                        effective_status: meta.effective_status,
                        objective: meta.objective,
                        synced_at: new Date().toISOString()
                    });
                });
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
                        budget_mode: campaignMeta[cid].budget_mode || 'BUDGET_MODE_INFINITE',
                        purchase_value: 0.00,
                        purchases: 0,
                        effective_status: campaignMeta[cid].effective_status,
                        objective: campaignMeta[cid].objective,
                        synced_at: new Date().toISOString()
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

        // Step 1: Fetch adgroup metadata (name, campaign_id) separately
        console.log(`[TikTokService] Fetching adgroup metadata...`);
        const adgroupMeta = {};
        try {
            const metaRes = await requestWithRetryGet('https://business-api.tiktok.com/open_api/v1.3/adgroup/get/', {
                headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
                params: { advertiser_id: accountId, page_size: 100 }
            });
            const list = metaRes.data?.data?.list || [];
            list.forEach(ag => {
                adgroupMeta[ag.adgroup_id] = {
                    adgroup_name: ag.adgroup_name || `Ad Group ${ag.adgroup_id}`,
                    campaign_id: ag.campaign_id,
                    campaign_name: ag.campaign_name || ''
                };
            });
        } catch (e) {
            console.warn('[TikTokService] Could not fetch adgroup metadata:', e.message);
        }

        // Step 2: Fetch report metrics for adgroups
        console.log(`[TikTokService] Fetching adgroup report metrics from ${dateFrom} to ${dateTo}...`);
        const response = await requestWithRetryGet('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/', {
            headers: {
                'Access-Token': token,
                'Content-Type': 'application/json'
            },
            params: {
                advertiser_id: accountId,
                report_type: 'BASIC',
                data_level: 'AUCTION_ADGROUP',
                dimensions: JSON.stringify(['adgroup_id', 'stat_time_day']),
                metrics: JSON.stringify([
                    'spend',
                    'impressions',
                    'clicks',
                    'conversion',
                    'total_purchase_value'
                ]),
                start_date: dateFrom,
                end_date: dateTo,
                page_size: 1000
            }
        });

        const data = response.data || {};
        if (data.code !== 0) throw new Error(`TikTok error: ${data.message}`);

        return (data.data?.list || []).map(row => {
            const adgroupId = row.dimensions?.adgroup_id;
            const meta = adgroupMeta[adgroupId] || {};
            const campaignId = meta.campaign_id || '';
            const campaignName = meta.campaign_name || 'حملة غير معروفة - TikTok';
            const adgroupName = meta.adgroup_name || `Ad Group ${adgroupId}`;
            return {
                platform: 'tiktok',
                account_id: accountId,
                campaign_id: campaignId,
                campaign_name: campaignName,
                adset_id: adgroupId,
                adset_name: adgroupName,
                date: row.dimensions?.stat_time_day?.split(' ')[0],
                spend: parseFloat(row.metrics?.spend || 0),
                impressions: parseInt(row.metrics?.impressions || 0),
                clicks: parseInt(row.metrics?.clicks || 0),
                platform_purchases: parseInt(row.metrics?.conversion || 0),
                platform_revenue: parseFloat(row.metrics?.total_purchase_value || 0)
            };
        });
    }
};

module.exports = TikTokService;
