const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const keyPath = 'C:\\Users\\TWc\\.ssh\\id_ed25519_vps';
const privateKey = fs.readFileSync(keyPath, 'utf8');

const conn = new Client();

console.log("🚀 Starting Production VPS Deployment to Hostinger (153.92.211.46)...");

conn.on('ready', () => {
    console.log("✅ SSH Connection Established as root!");

    const commands = [
        "cd /var/www/shopdashboard && git fetch origin && git reset --hard origin/main",
        "cd /var/www/shopdashboard && npm install",
        "cd /var/www/shopdashboard && node -e \"require('./src/migrations/migration_v1_product_control').runMigration(false).then(r=>console.log('VPS Migration:', r)).catch(e=>console.error(e))\"",
        "cd /var/www/shopdashboard && (pm2 restart shopdashboard --update-env || pm2 restart server --update-env || pm2 start server.js --name shopdashboard)",
        "pm2 status",
        "curl -I -s http://localhost:3000/ | head -n 5"
    ];

    executeSequential(commands, 0);
}).on('error', (err) => {
    console.error("❌ SSH connection error:", err.message);
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
        console.log("\n🎉 VPS Deployment & Process Restart Completed Successfully!");
        conn.end();
        process.exit(0);
        return;
    }
    
    const cmd = commands[index];
    console.log(`\n▶️ Executing VPS Command [${index + 1}/${commands.length}]: ${cmd}`);
    
    conn.exec(cmd, (err, stream) => {
        if (err) {
            console.error(`❌ Error executing command: ${cmd}`, err);
            conn.end();
            process.exit(1);
            return;
        }
        
        stream.on('close', (code, signal) => {
            if (code !== 0 && !cmd.includes('pm2 restart')) {
                console.error(`❌ Command exited with code ${code}. Aborting deployment.`);
                conn.end();
                process.exit(1);
                return;
            }
            executeSequential(commands, index + 1);
        }).on('data', (data) => {
            process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
            process.stderr.write(data.toString());
        });
    });
}
