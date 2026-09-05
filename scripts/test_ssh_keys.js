const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const sshDir = 'C:\\Users\\TWc\\.ssh';
const keyFiles = [
    { name: 'id_ed25519_vps', user: 'root' },
    { name: 'id_ed25519_nuzum', user: 'nuzum1' },
    { name: 'id_ed25519_nuzum', user: 'root' },
    { name: 'id_rsa', user: 'root' }
];

async function testKey(keyItem) {
    return new Promise((resolve) => {
        const keyPath = path.join(sshDir, keyItem.name);
        if (!fs.existsSync(keyPath)) {
            console.log(`Skipping ${keyItem.name}: file not found`);
            return resolve(false);
        }

        const privateKey = fs.readFileSync(keyPath, 'utf8');
        console.log(`Testing key "${keyItem.name}" with user "${keyItem.user}"...`);

        const conn = new Client();
        conn.on('ready', () => {
            console.log(`✅ SUCCESS! Connected to 153.92.211.46 with key "${keyItem.name}" and user "${keyItem.user}"!`);
            conn.exec("uptime; git --version; pm2 -v", (err, stream) => {
                if (!err) {
                    stream.on('data', d => process.stdout.write(d.toString()));
                }
                conn.end();
                resolve({ success: true, keyName: keyItem.name, user: keyItem.user, privateKey });
            });
        }).on('error', (err) => {
            console.log(`❌ Failed with key "${keyItem.name}" (${keyItem.user}): ${err.message}`);
            resolve(false);
        }).connect({
            host: '153.92.211.46',
            port: 22,
            username: keyItem.user,
            privateKey: privateKey,
            readyTimeout: 10000
        });
    });
}

async function run() {
    for (const item of keyFiles) {
        const res = await testKey(item);
        if (res && res.success) {
            console.log(`\n🎉 WORKING KEY FOUND: ${res.keyName} (user: ${res.user})`);
            return;
        }
    }
    console.log("None of the SSH keys worked.");
}

run();
