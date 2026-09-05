const db = require('../config/db');
const FacebookService = require('./facebook.service');
const TikTokService = require('./tiktok.service');
const { decryptToken } = require('../utils/crypto');

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function getPlatformConfig(platform) {
    const row = await getQuery("SELECT * FROM ad_platform_config WHERE platform = ? AND is_active = 1", [platform]);
    if (row) {
        try {
            const decrypted = decryptToken(row.access_token);
            return {
                account_id: row.account_id,
                access_token: decrypted
            };
        } catch (e) {
            console.error(`Failed to decrypt ${platform} token in scheduler:`, e);
        }
    }
    // Fallback
    const row2 = await getQuery("SELECT * FROM ads_connections WHERE platform = ? AND status = 'connected'", [
        platform === 'meta' ? 'facebook' : platform
    ]);
    if (row2) {
        return {
            account_id: row2.account_id,
            access_token: row2.access_token
        };
    }
    return null;
}

const SyncService = {
    // 1. Hourly campaigns & spend sync
    syncAllCampaigns: async (lookbackDays = 7) => {
        console.log(`[SyncService] Starting background campaigns sync (lookback: ${lookbackDays} days)...`);
        
        const to = new Date().toISOString().split('T')[0];
        const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const platforms = ['meta', 'tiktok'];
        
        for (const platform of platforms) {
            let rowsSynced = 0;
            try {
                const config = await getPlatformConfig(platform);
                if (!config || !config.access_token || !config.account_id) {
                    console.log(`[SyncService] Platform ${platform} is not configured or active. Skipping.`);
                    continue;
                }

                if (platform === 'meta') {
                    // Sync campaign-level metrics for ads_campaign_metrics
                    const campaigns = await FacebookService.fetchLiveCampaigns(config.access_token, config.account_id, from, to);
                    if (campaigns && campaigns.length > 0) {
                        await runQuery("DELETE FROM ads_campaign_metrics WHERE platform = 'facebook' AND date >= ?", [from]);
                        
                        const stmt = db.prepare(`
                            INSERT OR REPLACE INTO ads_campaign_metrics 
                            (campaign_id, campaign_name, platform, status, spend, clicks, impressions, conversions, date, budget, budget_mode, purchase_value, purchases, effective_status, objective, synced_at) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);
                        
                        campaigns.forEach(c => {
                            stmt.run([
                                c.campaign_id, c.campaign_name, 'facebook', c.status, c.spend, c.clicks, c.impressions, c.conversions, c.date, c.budget || 0, c.budget_mode || 'BUDGET_MODE_INFINITE',
                                c.purchase_value || 0, c.purchases || 0, c.effective_status || c.status, c.objective || '', c.synced_at
                            ]);
                            rowsSynced++;
                        });
                        stmt.finalize();
                    }

                    // Sync adset-level metrics for campaign_spend
                    const adsets = await FacebookService.fetchMetaCampaignInsights(from, to);
                    for (const row of adsets) {
                        await new Promise((resolve, reject) => {
                            db.run(`
                                INSERT OR REPLACE INTO campaign_spend
                                    (platform, account_id, campaign_id, campaign_name,
                                     adset_id, adset_name, date, spend, impressions, clicks,
                                     platform_purchases, platform_revenue, updated_at)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
                            `, [
                                row.platform, row.account_id, row.campaign_id, row.campaign_name,
                                row.adset_id, row.adset_name, row.date, row.spend,
                                row.impressions, row.clicks, row.platform_purchases,
                                row.platform_revenue
                            ], (err) => err ? reject(err) : resolve());
                        });
                    }
                } else if (platform === 'tiktok') {
                    // Sync campaign-level metrics for ads_campaign_metrics
                    const campaigns = await TikTokService.fetchLiveCampaigns(config.access_token, config.account_id, from, to);
                    if (campaigns && campaigns.length > 0) {
                        await runQuery("DELETE FROM ads_campaign_metrics WHERE platform = 'tiktok' AND date >= ?", [from]);
                        
                        const stmt = db.prepare(`
                            INSERT OR REPLACE INTO ads_campaign_metrics 
                            (campaign_id, campaign_name, platform, status, spend, clicks, impressions, conversions, date, budget, budget_mode, purchase_value, purchases, effective_status, objective, synced_at) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);
                        
                        campaigns.forEach(c => {
                            stmt.run([
                                c.campaign_id, c.campaign_name, 'tiktok', c.status, c.spend, c.clicks, c.impressions, c.conversions, c.date, c.budget || 0, c.budget_mode || 'BUDGET_MODE_INFINITE',
                                c.purchase_value || 0, c.purchases || 0, c.effective_status || c.status, c.objective || '', c.synced_at
                            ]);
                            rowsSynced++;
                        });
                        stmt.finalize();
                    }

                    // Sync adgroup-level metrics for campaign_spend
                    const adgroups = await TikTokService.fetchTikTokCampaignInsights(from, to);
                    for (const row of adgroups) {
                        await new Promise((resolve, reject) => {
                            db.run(`
                                INSERT OR REPLACE INTO campaign_spend
                                    (platform, account_id, campaign_id, campaign_name,
                                     adset_id, adset_name, date, spend, impressions, clicks,
                                     platform_purchases, platform_revenue, updated_at)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
                            `, [
                                row.platform, row.account_id, row.campaign_id, row.campaign_name,
                                row.adset_id, row.adset_name, row.date, row.spend,
                                row.impressions, row.clicks, row.platform_purchases,
                                row.platform_revenue
                            ], (err) => err ? reject(err) : resolve());
                        });
                    }
                }

                // Log success to sync_logs
                await runQuery(`
                    INSERT INTO sync_logs (platform, status, error_message, rows_synced)
                    VALUES (?, 'success', NULL, ?)
                `, [platform, rowsSynced]);
                console.log(`[SyncService] Platform ${platform} sync completed successfully. Synced ${rowsSynced} rows.`);

            } catch (err) {
                console.error(`[SyncService] Sync failed for platform ${platform}:`, err.message);
                // Log failure to sync_logs
                await runQuery(`
                    INSERT INTO sync_logs (platform, status, error_message, rows_synced)
                    VALUES (?, 'failed', ?, 0)
                `, [platform, err.message]);
            }
        }
    },

    // 2. Daily drift alert job
    checkDriftAlert: async () => {
        console.log("[SyncService] Running Daily Drift Alert Job...");
        
        // Yesterday to 3 days ago (last 3 completed days)
        const toDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const fromDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const platforms = ['meta', 'tiktok'];
        for (const platform of platforms) {
            try {
                const config = await getPlatformConfig(platform);
                if (!config || !config.access_token || !config.account_id) continue;

                // 1. Get sum from database
                const dbRes = await getQuery(`
                    SELECT SUM(spend) as total_spend FROM ads_campaign_metrics
                    WHERE platform = ? AND date >= ? AND date <= ?
                `, [platform === 'meta' ? 'facebook' : platform, fromDate, toDate]);
                const localSpendSum = dbRes ? (dbRes.total_spend || 0) : 0;

                // 2. Fetch directly from API
                let apiSpendSum = 0;
                if (platform === 'meta') {
                    const campaigns = await FacebookService.fetchLiveCampaigns(config.access_token, config.account_id, fromDate, toDate);
                    apiSpendSum = campaigns.reduce((sum, c) => sum + (c.spend || 0), 0);
                } else if (platform === 'tiktok') {
                    const campaigns = await TikTokService.fetchLiveCampaigns(config.access_token, config.account_id, fromDate, toDate);
                    if (campaigns) {
                        apiSpendSum = campaigns.reduce((sum, c) => sum + (c.spend || 0), 0);
                    }
                }

                // 3. Compare difference
                const diff = Math.abs(localSpendSum - apiSpendSum);
                const pct = apiSpendSum > 0 ? (diff / apiSpendSum) : 0;

                console.log(`[SyncService] Drift Check for ${platform}: Local Spend = ${localSpendSum}, API Spend = ${apiSpendSum}, Diff = ${diff} (${(pct * 100).toFixed(2)}%)`);

                if (pct > 0.05 && diff > 10) { // drift exceeds 5% and difference is greater than 10 units
                    const msg = `انحراف في الإنفاق الإعلاني لـ ${platform}: التكلفة المحلية=${localSpendSum.toFixed(2)}ر.س، الفعلية=${apiSpendSum.toFixed(2)}ر.س، نسبة الاختلاف=${(pct * 100).toFixed(2)}%`;
                    await runQuery(`
                        INSERT INTO sync_logs (platform, status, error_message, rows_synced)
                        VALUES (?, 'warning', ?, 0)
                    `, [platform, msg]);
                    console.warn(`[SyncService] Drift alert raised: ${msg}`);
                }
            } catch (err) {
                console.error(`[SyncService] Failed to check drift for platform ${platform}:`, err.message);
            }
        }
    }
};

module.exports = SyncService;
