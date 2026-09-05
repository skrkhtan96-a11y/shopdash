const { Client } = require('ssh2');

const conn = new Client();

console.log("Testing SSH connection to 153.92.211.46...");

conn.on('ready', () => {
    console.log("SUCCESS! SSH Connection established.");
    conn.exec("uptime; git --version; pm2 -v", (err, stream) => {
        if (err) throw err;
        stream.on('close', (code, signal) => {
            console.log("Test finished.");
            conn.end();
        }).on('data', (data) => {
            process.stdout.write(data.toString());
        });
    });
}).on('error', (err) => {
    console.error("SSH Error:", err.message);
}).connect({
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    password: 'Eisa11223344@',
    readyTimeout: 10000
});
