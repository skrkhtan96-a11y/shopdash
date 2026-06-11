const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();

const config = {
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    password: 'Eisa11223344@',
    readyTimeout: 30000
};

console.log("Connecting to Hostinger VPS to deploy updates...");

conn.on('ready', () => {
    console.log("Connected! Initializing SFTP to upload JSON key...");
    
    conn.sftp((err, sftp) => {
        if (err) {
            console.error("SFTP error:", err);
            conn.end();
            return;
        }

        const localKeyPath = path.join(__dirname, 'planar-momentum-484019-c2-74c0a1ece07b.json');
        const remoteKeyPath = '/var/www/shopdashboard/planar-momentum-484019-c2-74c0a1ece07b.json';

        console.log(`Uploading ${localKeyPath} to ${remoteKeyPath}...`);

        sftp.fastPut(localKeyPath, remoteKeyPath, {}, (uploadErr) => {
            if (uploadErr) {
                console.error("Error uploading credentials file via SFTP:", uploadErr);
                conn.end();
                return;
            }
            console.log("JSON Credentials file successfully uploaded!");

            // Run normal git deployment and pm2 restart commands
            const commands = [
                "cd /var/www/shopdashboard && git fetch origin && git reset --hard origin/main",
                "cd /var/www/shopdashboard && npm install",
                // Update VPS .env with drive variables
                "grep -q 'GOOGLE_DRIVE_FOLDER_ID' /var/www/shopdashboard/.env || (echo '' >> /var/www/shopdashboard/.env && echo 'GOOGLE_DRIVE_FOLDER_ID=1tCYz3pHOTV8_wj0woIX-5Qr9Eax-S03M' >> /var/www/shopdashboard/.env && echo 'GOOGLE_CREDENTIALS_FILE=planar-momentum-484019-c2-74c0a1ece07b.json' >> /var/www/shopdashboard/.env)",
                "cd /var/www/shopdashboard && (pm2 restart shopdashboard || pm2 restart server)",
                "pm2 status"
            ];

            executeSequential(commands, 0);
        });
    });
}).on('error', (err) => {
    console.error("SSH connection error:", err);
}).connect(config);

function executeSequential(commands, index) {
    if (index >= commands.length) {
        console.log("\nDeployment completed successfully. Closing connection.");
        conn.end();
        return;
    }
    
    const cmd = commands[index];
    console.log(`\nExecuting: ${cmd}`);
    
    conn.exec(cmd, (err, stream) => {
        if (err) {
            console.error(`Error executing ${cmd}:`, err);
            conn.end();
            return;
        }
        
        stream.on('close', (code, signal) => {
            if (code !== 0) {
                console.error(`Command exited with code ${code}. Aborting deployment.`);
                conn.end();
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
