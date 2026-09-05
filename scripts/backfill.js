require('dotenv').config();
const db = require('../src/config/db');
const FacebookService = require('../src/services/facebook.service');
const TikTokService = require('../src/services/tiktok.service');
const { decryptToken } = require('../src/utils/crypto');

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
            console.error(`Failed to decrypt ${platform} token:`, e);
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

(async () => {
    // Parse args
    const args = process.argv.slice(2);
    const params = {};
    args.forEach(arg => {
        if (arg.startsWith('--')) {
            const [key, value] = arg.split('=');
            params[key.replace('--', '')] = value;
        }
    });

    const targetPlatform = params.platform; // meta or tiktok
    const fromDate = params.from; // YYYY-MM-DD
    const toDate = params.to; // YYYY-MM-DD

    if (!targetPlatform || !fromDate || !toDate) {
        console.error("Usage: node scripts/backfill.js --platform=[meta|tiktok] --from=YYYY-MM-DD --to=YYYY-MM-DD");
        process.exit(1);
    }

    try {
        await db.ready;
        console.log(`[Backfill] Starting backfill for ${targetPlatform} from ${fromDate} to ${toDate}...`);

        const config = await getPlatformConfig(targetPlatform);
        if (!config || !config.access_token || !config.account_id) {
            console.error(`Error: Platform ${targetPlatform} credentials not found or not active.`);
            process.exit(1);
        }

        console.log(`[Backfill] Config loaded. Account ID: ${config.account_id}`);

        if (targetPlatform === 'meta') {
            // 1. Campaign-level metrics (ads_campaign_metrics)
            console.log("[Backfill] Fetching campaign-level insights from Facebook Graph API...");
            const campaigns = await FacebookService.fetchLiveCampaigns(config.access_token, config.account_id, fromDate, toDate);
            console.log(`[Backfill] Fetched ${campaigns ? campaigns.length : 0} campaign-level rows.`);

            if (campaigns && campaigns.length > 0) {
                // Delete existing rows for this period to avoid duplicates
                await runQuery("DELETE FROM ads_campaign_metrics WHERE platform = 'facebook' AND date >= ? AND date <= ?", [fromDate, toDate]);
                
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
                });
                stmt.finalize();
                console.log(`[Backfill] Saved campaign-level metrics to ads_campaign_metrics.`);
            }

            // 2. Adset-level metrics (campaign_spend)
            console.log("[Backfill] Fetching adset-level insights from Facebook Graph API...");
            const adsets = await FacebookService.fetchMetaCampaignInsights(fromDate, toDate);
            console.log(`[Backfill] Fetched ${adsets ? adsets.length : 0} adset-level rows.`);

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
            console.log(`[Backfill] Saved adset-level spend metrics to campaign_spend.`);

        } else if (targetPlatform === 'tiktok') {
            // 1. Campaign-level metrics (ads_campaign_metrics)
            console.log("[Backfill] Fetching campaign-level insights from TikTok Business API...");
            const campaigns = await TikTokService.fetchLiveCampaigns(config.access_token, config.account_id, fromDate, toDate);
            console.log(`[Backfill] Fetched ${campaigns ? campaigns.length : 0} campaign-level rows.`);

            if (campaigns && campaigns.length > 0) {
                await runQuery("DELETE FROM ads_campaign_metrics WHERE platform = 'tiktok' AND date >= ? AND date <= ?", [fromDate, toDate]);
                
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
                });
                stmt.finalize();
                console.log(`[Backfill] Saved campaign-level metrics to ads_campaign_metrics.`);
            }

            // 2. Adgroup-level spend metrics (campaign_spend)
            console.log("[Backfill] Fetching adgroup-level insights from TikTok Business API...");
            const adgroups = await TikTokService.fetchTikTokCampaignInsights(fromDate, toDate);
            console.log(`[Backfill] Fetched ${adgroups ? adgroups.length : 0} adgroup-level rows.`);

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
            console.log(`[Backfill] Saved adgroup-level spend metrics to campaign_spend.`);
        }

        // Log success to sync_logs
        await runQuery(`
            INSERT INTO sync_logs (platform, status, error_message, rows_synced)
            VALUES (?, 'success', 'Backfill completed manually', 0)
        `, [targetPlatform]);

        console.log(`[Backfill] SUCCESS! Completed backfill for platform ${targetPlatform}.`);
        process.exit(0);

    } catch (e) {
        console.error("[Backfill] FAILED:", e.stack);
        await runQuery(`
            INSERT INTO sync_logs (platform, status, error_message, rows_synced)
            VALUES (?, 'failed', ?, 0)
        `, [targetPlatform, `Backfill failed: ${e.message}`]);
        process.exit(1);
    }
})();
