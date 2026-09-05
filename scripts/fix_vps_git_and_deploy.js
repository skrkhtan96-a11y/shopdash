const { Client } = require('ssh2');
const fs = require('fs');

const keyPath = 'C:\\Users\\TWc\\.ssh\\id_ed25519_vps';
const privateKey = fs.readFileSync(keyPath, 'utf8');

const conn = new Client();

console.log("🚀 Inspecting & Fixing VPS Git Remote...");

conn.on('ready', () => {
    console.log("✅ SSH Connected as root!");

    const commands = [
        // Check current git remote URL and ssh key on VPS
        "cd /var/www/shopdashboard && git remote -v",
        "cat /root/.ssh/id_rsa.pub || cat /root/.ssh/id_ed25519.pub || echo 'No pub key'",
        // Test git fetch or switch remote if public repo or set credentials
        "cd /var/www/shopdashboard && git config --get remote.origin.url"
    ];

    executeSequential(commands, 0);
}).on('error', (err) => {
    console.error("❌ SSH error:", err.message);
}).connect({
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    privateKey: privateKey,
    readyTimeout: 30000
});

function executeSequential(commands, index) {
    if (index >= commands.length) {
        conn.end();
        return;
    }
    const cmd = commands[index];
    console.log(`\n▶️ [${index+1}] ${cmd}`);
    conn.exec(cmd, (err, stream) => {
        if (err) throw err;
        stream.on('close', () => executeSequential(commands, index + 1))
              .on('data', d => process.stdout.write(d.toString()))
              .stderr.on('data', d => process.stderr.write(d.toString()));
    });
}
