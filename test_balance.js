const { Client } = require('ssh2');

const conn = new Client();

const config = {
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    password: 'Eisa11223344@',
    readyTimeout: 30000
};

console.log("Connecting to VPS to run TikTok account balance test...");

conn.on('ready', () => {
    console.log("Connected!");
    
    const testScript = `
const axios = require('axios');
const token = '05cbf7c1809cc62faa45a1972c3bf7bcf1a905d6';
const advertiserId = '7492167669576351745';
axios.get("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
    headers: { 
        'Access-Token': token,
        'Content-Type': 'application/json'
    },
    params: {
        advertiser_id: advertiserId,
        report_type: 'BASIC',
        data_level: 'AUCTION_CAMPAIGN',
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(["spend", "clicks", "impressions", "conversion"]),
        start_date: '2026-06-01',
        end_date: '2026-06-03',
        page_size: 100
    }
}).then(res => {
    console.log("Report API Res:", JSON.stringify(res.data, null, 2));
}).catch(err => {
    console.error("Report Error:", err.response ? err.response.data : err.message);
});
`;
    const cmd = `cd /var/www/shopdashboard && node -e "const sqlite3 = require('sqlite3'); const db = new sqlite3.Database('database.db'); db.all('SELECT DISTINCT cat, desc FROM expenses', [], (e, r) => console.log(r))"`;
    
    conn.exec(cmd, (err, stream) => {
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
