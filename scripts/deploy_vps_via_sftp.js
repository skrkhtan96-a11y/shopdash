const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const keyPath = 'C:\\Users\\TWc\\.ssh\\id_ed25519_vps';
const privateKey = fs.readFileSync(keyPath, 'utf8');

const localBasePath = path.join(__dirname, '..');
const remoteBasePath = '/var/www/shopdashboard';

// Files and directories to sync to VPS
const filesToDeploy = [
    'server.js',
    'database.js',
    'package.json',
    'public/index.html',
    'public/system-control.html',
    'public/js/app.js',
    'public/js/app_v2.js',
    'public/js/product_control_ui.js',
    'src/controllers/product_control.controller.js',
    'src/migrations/migration_v1_product_control.js',
    'src/migrations/migration_v2_product_families.js',
    'src/repositories/product_control.repository.js',
    'src/repositories/product_family.repository.js',
    'src/routes/product_control.routes.js',
    'src/routes/ads.routes.js',
    'src/routes/ai.routes.js',
    'src/routes/attribution.routes.js',
    'src/routes/campaigns.routes.js',
    'src/routes/delivery.routes.js',
    'src/routes/salla.routes.js',
    'src/routes/system.routes.js',
    'src/middlewares/auth.js',
    'src/services/product_control.service.js',
    'src/services/product_family.service.js',
    'src/services/sync.service.js',
    'src/services/salla.service.js',
    'src/services/facebook.service.js',
    'src/services/tiktok.service.js',
    'src/utils/currency.js',
    'scripts/prod_apply_opening_inventory.js',
    'scripts/prod_extract_5_products.js',
    'scripts/prod_go_live_execution.js',
    'scripts/prod_onboard_catalog.js',
    'scripts/prod_permissions_smoke_test.js',
    'scripts/prod_post_deployment_smoke_test.js',
    'scripts/prod_release_gate_checker.js',
    'scripts/prod_run_migration.js',
    'scripts/prod_salla_orders_analysis.js',
    'scripts/seed_plus_catalog.js'
];

const conn = new Client();

console.log("🚀 Deploying Codebase to Hostinger VPS (153.92.211.46) via SFTP...");

conn.on('ready', () => {
    console.log("✅ SSH Connected as root!");

    conn.sftp((err, sftp) => {
        if (err) {
            console.error("❌ SFTP Error:", err);
            conn.end();
            process.exit(1);
            return;
        }

        async function uploadFiles() {
            for (const fileRel of filesToDeploy) {
                const localPath = path.join(localBasePath, fileRel);
                const remotePath = `${remoteBasePath}/${fileRel.replace(/\\/g, '/')}`;
                const remoteDir = path.dirname(remotePath).replace(/\\/g, '/');

                // Ensure remote dir exists via SSH command
                await new Promise((resDir) => {
                    conn.exec(`mkdir -p ${remoteDir}`, () => resDir());
                });

                if (fs.existsSync(localPath)) {
                    await new Promise((resPut, rejPut) => {
                        sftp.fastPut(localPath, remotePath, {}, (errPut) => {
                            if (errPut) {
                                console.error(` ❌ Error uploading ${fileRel}:`, errPut.message);
                                rejPut(errPut);
                            } else {
                                console.log(` ⬆️ Uploaded ${fileRel}`);
                                resPut();
                            }
                        });
                    });
                }
            }

            console.log("\n✅ All Production Files Uploaded via SFTP Successfully!");

            // Run post-upload commands on VPS
            const postCommands = [
                "cd /var/www/shopdashboard && npm install --production",
                "cd /var/www/shopdashboard && node -e \"require('./src/migrations/migration_v1_product_control').runMigration(false).then(r=>console.log('VPS Migration v1:', r)).catch(e=>console.error(e))\"",
                "cd /var/www/shopdashboard && node -e \"require('./src/migrations/migration_v2_product_families').runMigration(false).then(r=>console.log('VPS Migration v2:', r)).catch(e=>console.error(e))\"",
                "cd /var/www/shopdashboard && node scripts/seed_plus_catalog.js",
                "cd /var/www/shopdashboard && (pm2 restart shopdashboard --update-env || pm2 restart server --update-env || pm2 start server.js --name shopdashboard)",
                "pm2 status",
                "curl -I -s http://localhost:3000/ | head -n 5"
            ];

            executeSequential(postCommands, 0);
        }

        uploadFiles().catch(e => {
            console.error("❌ Upload process failed:", e);
            conn.end();
            process.exit(1);
        });
    });

}).on('error', (err) => {
    console.error("❌ SSH Error:", err.message);
    process.exit(1);
}).connect({
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    privateKey: privateKey,
    readyTimeout: 30000
});

function executeSequential(commands, index) {
    if (index >= commands.length) {
        console.log("\n🎉 VPS Production Deployment & Migration Completed Successfully!");
        conn.end();
        process.exit(0);
        return;
    }
    
    const cmd = commands[index];
    console.log(`\n▶️ VPS Command [${index + 1}/${commands.length}]: ${cmd}`);
    
    conn.exec(cmd, (err, stream) => {
        if (err) {
            console.error(`❌ Error executing ${cmd}:`, err);
            conn.end();
            process.exit(1);
            return;
        }
        
        stream.on('close', (code, signal) => {
            executeSequential(commands, index + 1);
        }).on('data', (data) => {
            process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
            process.stderr.write(data.toString());
        });
    });
}
