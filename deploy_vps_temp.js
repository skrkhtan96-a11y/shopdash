const { Client } = require('ssh2');

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
    console.log("Connected! Running deployment commands...");
    
    const commands = [
        "cd /var/www/shopdashboard && git fetch origin && git reset --hard origin/main",
        "cd /var/www/shopdashboard && (pm2 restart shopdashboard || pm2 restart server)",
        "pm2 status"
    ];

    executeSequential(commands, 0);
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
