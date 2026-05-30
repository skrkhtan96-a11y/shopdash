const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const FILE_PATH = path.join(__dirname, 'salla_dashboard_v4.html');

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html' || req.url === '/salla_dashboard_v4.html') {
        fs.readFile(FILE_PATH, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('خطأ في قراءة ملف HTML: ' + err.message);
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(content);
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('الصفحة غير موجودة');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`قم بفتح الرابط أعلاه في متصفحك لعرض لوحة التحكم الحالية.`);
});
