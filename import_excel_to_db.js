const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.db');
// Find any excel file matching the pattern in this directory
const files = fs.readdirSync(__dirname);
const excelFile = files.find(f => f.endsWith('.xlsx'));

if (!excelFile) {
    console.error("Error: No .xlsx file found in the current directory!");
    process.exit(1);
}

const excelPath = path.join(__dirname, excelFile);

console.log("Starting unified import process...");
console.log("DB Path:", dbPath);
console.log("Excel Path:", excelPath);

const db = new sqlite3.Database(dbPath);

const cleanProductName = name => {
    if (!name) return '';
    let cleaned = name.trim();
    if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
        cleaned = cleaned.slice(1, -1).trim();
    } else {
        if (cleaned.startsWith("'")) cleaned = cleaned.substring(1).trim();
        if (cleaned.endsWith("'")) cleaned = cleaned.slice(0, -1).trim();
    }
    cleaned = cleaned.replace(/^\(?\'?SKU:\s*[^\)]*\'?\)?/gi, '');
    cleaned = cleaned.replace(/^\(?\'?رمز المنتج:\s*[^\)]*\'?\)?/gi, '');
    cleaned = cleaned.replace(/\(?\'?Qty:\s*\d+\'?\)?$/gi, '');
    cleaned = cleaned.replace(/\(?\'?الكمية:\s*\d+\'?\)?$/gi, '');
    cleaned = cleaned.replace(/\(Q$/gi, '');
    cleaned = cleaned.replace(/\(Qty$/gi, '');
    cleaned = cleaned.replace(/^['"\s\-\(]+/g, '');
    cleaned = cleaned.replace(/['"\s\-\)]+$/g, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/\(\s*شهر\s*\)/gi, '- شهر');
    cleaned = cleaned.replace(/\(\s*أشهر\s*\)/gi, '- أشهر');
    cleaned = cleaned.replace(/\(\s*شهرين\s*\)/gi, '- شهرين');
    cleaned = cleaned.replace(/\(\s*سنة\s*\)/gi, '- سنة');
    return cleaned;
};

try {
    const wb = XLSX.readFile(excelPath, { cellDates: true });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    console.log(`Parsed ${rows.length} rows from Excel.`);

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        let newCount = 0;
        
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO salla_imported_orders 
            (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, product_thumbnail, quantity) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        rows.forEach(r => {
            const refId = String(r['رقم الطلب'] || r['رقم مرجع الطلب'] || '').trim();
            if (!refId) return;

            let dateRaw = r['تاريخ الطلب'] || '';
            let dateStr = new Date().toISOString().split('T')[0];
            if (dateRaw) {
                if (dateRaw instanceof Date) {
                    dateStr = dateRaw.toISOString().split('T')[0];
                } else {
                    dateStr = String(dateRaw).substring(0, 10);
                }
            }

            const statusName = String(r['حالة الطلب'] || 'تم التنفيذ').trim();
            let statusSlug = 'completed';
            if (statusName.includes('معلق') || statusName.includes('بانتظار الدفع') || statusName.includes('pending')) {
                statusSlug = 'payment_pending';
            } else if (statusName.includes('مراجعة') || statusName.includes('review')) {
                statusSlug = 'under_review';
            }

            const payMethod = String(r['طريقة الدفع'] || 'mada').trim();
            let paySlug = 'mada';
            const lowerPay = payMethod.toLowerCase();
            if (lowerPay.includes('apple') || lowerPay.includes('آبل')) paySlug = 'apple_pay';
            else if (lowerPay.includes('stc') || lowerPay.includes('اس تي سي')) paySlug = 'stc_pay';
            else if (lowerPay.includes('credit') || lowerPay.includes('بطاقة') || lowerPay.includes('فيزا') || lowerPay.includes('visa') || lowerPay.includes('master')) paySlug = 'credit_card';
            else if (lowerPay.includes('cod') || lowerPay.includes('عند الاستلام')) paySlug = 'cod';
            else if (lowerPay.includes('انتظار')) paySlug = 'waiting';

            const totalAmount = parseFloat(r['إجمالي الطلب (شامل التخفيضات)'] || r['إجمالي الطلب (غير شامل التخفيضات)'] || r['مجموع السلة'] || 0);
            const customerName = String(r['اسم العميل'] || 'عميل خارجي').trim();

            let items = [];
            const skusJsonStr = r['skus_json'];
            if (skusJsonStr) {
                try {
                    const parsed = JSON.parse(skusJsonStr);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        items = parsed.map(item => {
                            return {
                                name: cleanProductName(item[0] || 'منتج مستورد'),
                                qty: parseInt(item[1]) || 1,
                                amount: parseFloat(item[4]) || 0
                            };
                        });
                    }
                } catch (e) {
                    // ignore
                }
            }

            if (items.length > 0) {
                items.forEach((item, idx) => {
                    const itemRefId = `${refId}_${idx}`;
                    stmt.run([
                        itemRefId,
                        dateStr,
                        statusSlug,
                        statusName,
                        paySlug,
                        item.amount * item.qty,
                        customerName,
                        item.name,
                        '',
                        item.qty
                    ]);
                    newCount++;
                });
            } else {
                const prodName = cleanProductName(String(r['اسماء المنتجات مع SKU'] || r['المنتج'] || 'منتج مستورد').trim());
                stmt.run([
                    refId,
                    dateStr,
                    statusSlug,
                    statusName,
                    paySlug,
                    totalAmount,
                    customerName,
                    prodName,
                    '',
                    1
                ]);
                newCount++;
            }
        });

        stmt.finalize((err) => {
            if (err) {
                console.error("Error finalizing statement:", err);
                db.run("ROLLBACK");
                db.close();
            } else {
                db.run("COMMIT", (errCommit) => {
                    if (errCommit) {
                        console.error("Error committing transaction:", errCommit);
                    } else {
                        console.log(`Successfully imported ${newCount} sales items into the database!`);
                    }
                    db.close();
                });
            }
        });
    });
} catch (err) {
    console.error("Error processing excel file:", err);
}
