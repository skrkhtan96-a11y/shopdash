const axios = require('axios');
const db = require('../config/db');
const { decryptToken } = require('../utils/crypto');

async function getMetaConfig() {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM ad_platform_config WHERE platform = 'meta' AND is_active = 1", [], (err, row) => {
            if (!err && row) {
                try {
                    const decrypted = decryptToken(row.access_token);
                    return resolve({
                        account_id: row.account_id,
                        access_token: decrypted
                    });
                } catch (e) {
                    console.error("Failed to decrypt meta config token:", e);
                }
            }
            // Fallback to ads_connections
            db.get("SELECT * FROM ads_connections WHERE platform = 'facebook' AND status = 'connected'", [], (err2, row2) => {
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

const FacebookService = {
    fetchAdAccounts: async (token) => {
        try {
            console.log("[FacebookService] Fetching ad accounts...");
            const response = await axios.get("https://graph.facebook.com/v21.0/me/adaccounts", {
                params: {
                    fields: 'id,name,account_status,balance,currency,amount_spent',
                    access_token: token
                }
            });
            if (response.data && response.data.data) {
                return response.data.data.map(acc => ({
                    id: acc.id,
                    name: acc.name || 'حساب فيسبوك إعلاني',
                    balance: parseFloat(acc.balance || 0) / 100,
                    currency: acc.currency || 'SAR',
                    status: acc.account_status === 1 ? 'active' : 'paused'
                }));
            }
            return [];
        } catch (e) {
            console.error("[FacebookService] Failed to fetch ad accounts:", e.message);
            throw e;
        }
    },

    fetchLiveCampaigns: async (token, adAccountIds, fromDate, toDate) => {
        try {
            const ids = String(adAccountIds).split(',');
            let allResults = [];
            for (const id of ids) {
                const trimmedId = id.trim();
                if (!trimmedId) continue;
                const results = await FacebookService.fetchSingleAccountCampaigns(token, trimmedId, fromDate, toDate);
                if (results && results.length > 0) {
                    allResults = allResults.concat(results);
                }
            }
            return allResults;
        } catch (e) {
            console.error("[FacebookService] Failed to fetch Facebook campaigns:", e.message);
            return [];
        }
    },

    fetchSingleAccountCampaigns: async (token, adAccountId, fromDate, toDate) => {
        try {
            const start = fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const end = toDate || new Date().toISOString().split('T')[0];

            console.log(`[FacebookService] Fetching campaign metadata for: ${adAccountId}...`);
            
            const configRes = await axios.get(`https://graph.facebook.com/v21.0/${adAccountId}/campaigns`, {
                params: {
                    fields: 'id,name,status,daily_budget,lifetime_budget,budget_remaining',
                    limit: 100,
                    access_token: token
                }
            });

            const campaignMeta = {};
            if (configRes.data && configRes.data.data) {
                configRes.data.data.forEach(c => {
                    const budget = parseFloat(c.daily_budget || c.lifetime_budget || 0) / 100;
                    const budgetMode = c.daily_budget ? 'BUDGET_MODE_DAY' : c.lifetime_budget ? 'BUDGET_MODE_TOTAL' : 'BUDGET_MODE_INFINITE';
                    campaignMeta[c.id] = {
                        name: c.name,
                        status: c.status === 'ACTIVE' ? 'active' : 'paused',
                        budget: budget,
                        budget_mode: budgetMode
                    };
                });
            }

            console.log(`[FacebookService] Fetching insights for ${adAccountId} from ${start} to ${end}...`);
            const insightsRes = await axios.get(`https://graph.facebook.com/v21.0/${adAccountId}/insights`, {
                params: {
                    level: 'campaign',
                    time_increment: 1,
                    fields: 'campaign_id,campaign_name,spend,clicks,impressions,actions',
                    time_range: JSON.stringify({ since: start, until: end }),
                    limit: 150,
                    access_token: token
                }
            });

            const results = [];
            const campaignsInReport = new Set();

            if (insightsRes.data && insightsRes.data.data) {
                insightsRes.data.data.forEach(r => {
                    const campaignId = r.campaign_id;
                    const date = r.date_start;
                    const meta = campaignMeta[campaignId] || { name: r.campaign_name || 'حملة غير معروفة - Facebook', status: 'paused', budget: 0, budget_mode: 'BUDGET_MODE_INFINITE' };

                    campaignsInReport.add(campaignId);

                    let conversions = 0;
                    if (r.actions && Array.isArray(r.actions)) {
                        const purchaseAction = r.actions.find(a => ['purchase', 'offsite_conversion.fb_pixel_purchase'].includes(a.action_type));
                        if (purchaseAction) {
                            conversions = parseInt(purchaseAction.value || 0);
                        } else {
                            const leadAction = r.actions.find(a => ['lead', 'onsite_conversion.messaging_first_reply'].includes(a.action_type));
                            if (leadAction) {
                                conversions = parseInt(leadAction.value || 0);
                            }
                        }
                    }

                    results.push({
                        campaign_id: campaignId + '_' + date,
                        campaign_name: meta.name,
                        platform: 'facebook',
                        status: meta.status,
                        spend: parseFloat(r.spend || 0),
                        clicks: parseInt(r.clicks || 0),
                        impressions: parseInt(r.impressions || 0),
                        conversions: conversions,
                        date: date,
                        budget: meta.budget || 0,
                        budget_mode: meta.budget_mode || 'BUDGET_MODE_INFINITE'
                    });
                });
            }

            Object.keys(campaignMeta).forEach(cid => {
                if (!campaignsInReport.has(cid)) {
                    results.push({
                        campaign_id: cid + '_' + end,
                        campaign_name: campaignMeta[cid].name,
                        platform: 'facebook',
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
            console.error(`[FacebookService] Failed to fetch insights for: ${adAccountId}:`, e.message);
            return [];
        }
    },

    fetchMetaCampaignInsights: async (dateFrom, dateTo) => {
        const config = await getMetaConfig();
        if (!config) throw new Error('Meta غير مُهيَّأ — أضف التوكن وحساب الإعلانات');

        const token = config.access_token;
        const accountId = config.account_id;

        const fields = [
            'campaign_id',
            'campaign_name',
            'adset_id',
            'adset_name',
            'spend',
            'impressions',
            'clicks',
            'actions',
            'action_values',
            'cpc',
            'cpm',
            'ctr'
        ].join(',');

        const params = {
            fields,
            level: 'adset',
            time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
            time_increment: 1,
            limit: 500,
            access_token: token
        };

        const cleanAccountId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
        const response = await axios.get(`https://graph.facebook.com/v21.0/${cleanAccountId}/insights`, { params });
        const data = response.data || {};

        return (data.data || []).map(row => ({
            platform: 'meta',
            account_id: accountId,
            campaign_id: row.campaign_id,
            campaign_name: row.campaign_name,
            adset_id: row.adset_id,
            adset_name: row.adset_name,
            date: row.date_start,
            spend: parseFloat(row.spend || 0),
            impressions: parseInt(row.impressions || 0),
            clicks: parseInt(row.clicks || 0),
            platform_purchases: extractAction(row.actions, 'purchase'),
            platform_revenue: extractActionValue(row.action_values, 'purchase'),
        }));
    }
};

function extractAction(actions, actionType) {
    if (!Array.isArray(actions)) return 0;
    const found = actions.find(a => a.action_type === actionType);
    return found ? parseInt(found.value || 0) : 0;
}

function extractActionValue(actionValues, actionType) {
    if (!Array.isArray(actionValues)) return 0;
    const found = actionValues.find(a => a.action_type === actionType);
    return found ? parseFloat(found.value || 0) : 0;
}

module.exports = FacebookService;
