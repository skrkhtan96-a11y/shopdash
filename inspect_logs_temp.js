const { Client } = require('ssh2');

const conn = new Client();

const config = {
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    password: 'Eisa11223344@',
    readyTimeout: 30000
};

console.log("Connecting to VPS to inspect logs...");

conn.on('ready', () => {
    console.log("Connected!");
    
    conn.exec("pm2 logs shopdashboard --lines 100 --nostream", (err, stream) => {
        if (err) {
            console.error("Error executing command:", err);
            conn.end();
            return;
        }
        stream.on('close', (code, signal) => {
            conn.end();
        }).on('data', (data) => {
            process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
            process.stderr.write(data.toString());
        });
    });
}).on('error', (err) => {
    console.error("SSH connection error:", err);
}).connect(config);
