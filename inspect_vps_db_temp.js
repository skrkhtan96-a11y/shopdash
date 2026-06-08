const { Client } = require('ssh2');
const conn = new Client();
const config = {
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    password: 'Eisa11223344@',
    readyTimeout: 30000
};
conn.on('ready', () => {
    conn.exec("sqlite3 /var/www/shopdashboard/database.db \"SELECT id, email, ps5_1_status, ps5_2_status, ps4_status FROM ps_plus_accounts LIMIT 5\"", (err, stream) => {
        stream.on('close', () => conn.end())
              .on('data', (data) => console.log(data.toString()))
              .stderr.on('data', (data) => console.error(data.toString()));
    });
}).connect(config);
