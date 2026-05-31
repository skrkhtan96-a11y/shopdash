const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('خطأ أثناء فتح قاعدة البيانات:', err.message);
    } else {
        console.log('قاعدة البيانات متصلة بنجاح (SQLite)');
    }
});

// تهيئة الجداول
db.serialize(() => {
    // 1. جدول المصروفات
    db.run(`
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            desc TEXT NOT NULL,
            cat TEXT NOT NULL,
            amt REAL NOT NULL,
            date TEXT NOT NULL,
            note TEXT,
            archived_in TEXT DEFAULT NULL
        )
    `);

    // ترقية جدول المصروفات لإضافة أعمدة المشتريات والتسويق إن لم تكن موجودة
    db.run("ALTER TABLE expenses ADD COLUMN product_name TEXT", (err) => { /* تجاهل الخطأ إذا كان العمود موجوداً */ });
    db.run("ALTER TABLE expenses ADD COLUMN quantity INTEGER", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE expenses ADD COLUMN purchase_price REAL", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE expenses ADD COLUMN selling_price REAL", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE expenses ADD COLUMN platform_name TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE expenses ADD COLUMN period TEXT", (err) => { /* تجاهل الخطأ */ });

    // 2. جدول الأرشيف الشهري
    db.run(`
        CREATE TABLE IF NOT EXISTS archives (
            key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            month TEXT NOT NULL,
            archived_at TEXT NOT NULL,
            expenses_json TEXT,
            sales_json TEXT,
            wallet_json TEXT
        )
    `);

    // 3. جدول الاتصال بـ سلة (OAuth state & credentials)
    db.run(`
        CREATE TABLE IF NOT EXISTS salla_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // 4. جدول الطلبات المستوردة من إكسل
    db.run(`
        CREATE TABLE IF NOT EXISTS salla_imported_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reference_id TEXT UNIQUE,
            date TEXT NOT NULL,
            status_slug TEXT DEFAULT 'completed',
            status_name TEXT DEFAULT 'تم التنفيذ',
            payment_method TEXT DEFAULT 'mada',
            amount REAL NOT NULL,
            customer_name TEXT,
            product_name TEXT,
            product_thumbnail TEXT,
            quantity INTEGER DEFAULT 1
        )
    `);

    // 5. جدول عمليات المحفظة المستوردة من إكسل
    db.run(`
        CREATE TABLE IF NOT EXISTS salla_imported_wallet (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reference_id TEXT UNIQUE,
            amount REAL NOT NULL,
            commission REAL NOT NULL,
            net REAL NOT NULL,
            tax REAL DEFAULT 0,
            date TEXT NOT NULL,
            status TEXT DEFAULT 'مدفوعة',
            note TEXT
        )
    `);

    // 6. جدول تسويات وجرد المخزون اليدوي والأسعار المخصصة
    db.run(`
        CREATE TABLE IF NOT EXISTS product_adjustments (
            product_name TEXT PRIMARY KEY,
            stock_offset INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            price REAL DEFAULT 0
        )
    `);

    // 7. جدول المستخدمين (المصادقة والصلاحيات)
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'موظف',
            created_at TEXT NOT NULL
        )
    `);

    // 8. جدول جلسات العمل (Sessions)
    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 9. جدول استيراد مبيعات إكسل المخصصة والمقارنة
    db.run(`
        CREATE TABLE IF NOT EXISTS product_sales_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id TEXT NOT NULL,
            import_title TEXT NOT NULL,
            import_date TEXT NOT NULL,
            product_type TEXT,
            brand_name TEXT,
            qty_sold INTEGER DEFAULT 0,
            sales_before_discount REAL DEFAULT 0,
            discount REAL DEFAULT 0,
            cost_of_sales REAL DEFAULT 0,
            net_sales REAL DEFAULT 0,
            taxes REAL DEFAULT 0,
            total_sales REAL DEFAULT 0
        )
    `);

    // 10. جدول المقارنات المحفوظة
    db.run(`
        CREATE TABLE IF NOT EXISTS saved_comparisons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            compare_type TEXT NOT NULL,
            param1 TEXT,
            param2 TEXT,
            summary_json TEXT,
            created_at TEXT NOT NULL
        )
    `);


    // إضافة بيانات تجريبية للمصروفات في حال كان الجدول فارغاً
    db.get("SELECT COUNT(*) as count FROM expenses", (err, row) => {
        if (!err && row.count === 0) {
            console.log('جدول المصروفات فارغ، جاري تعبئة بيانات تجريبية...');
            const defaultExpenses = [
                ["راتب عصام", "رواتب", 500, "2026-05-01", ""],
                ["راتب علي", "رواتب", 500, "2026-05-01", ""],
                ["راتب سمير", "رواتب", 500, "2026-05-02", ""],
                ["تمويل تيك توك", "تسويق", 115, "2026-05-02", ""],
                ["تمويل سناب", "تسويق", 92, "2026-05-02", ""],
                ["تمويل فيس بوك", "تسويق", 212, "2026-05-02", ""],
                ["شراء تيفي شحن", "شراء منتجات", 500, "2026-05-03", ""],
                ["شراء سناب زيرة", "شراء منتجات", 1330, "2026-05-04", ""],
                ["راتب زين", "رواتب", 500, "2026-05-05", ""],
                ["تمويل فيس بوك", "تسويق", 280, "2026-05-05", ""],
                ["سلفة عبد العزيز", "سلف", 100, "2026-05-06", ""],
                ["شهادات آبل", "شراء منتجات", 5000, "2026-05-09", ""],
                ["شهادة آبل", "شراء منتجات", 1650, "2026-05-12", ""],
                ["أرباح خالد", "أرباح", 1000, "2026-05-12", ""],
                ["أرباح عيسى", "أرباح", 1000, "2026-05-12", ""],
                ["استضافة هوستينجر", "أخرى", 230, "2026-05-14", "هشام"],
                ["تمويل فيس بوك", "تسويق", 356, "2026-05-14", ""],
                ["سلفة عبد العزيز", "سلف", 70, "2026-05-15", ""],
                ["حملة تيك توك", "تسويق", 230, "2026-05-17", ""],
                ["حساب المصمم", "أخرى", 261, "2026-05-20", ""],
                ["راتب عصام (2)", "رواتب", 508, "2026-05-21", ""],
                ["راتب علي (2)", "رواتب", 508, "2026-05-21", ""],
                ["شهادة آبل", "شراء منتجات", 850, "2026-05-22", ""],
                ["سلفة عبد العزيز", "سلف", 500, "2026-05-23", ""],
                ["تجديد إسكربت", "أخرى", 500, "2026-05-24", ""],
                ["شهادة آبل", "شراء منتجات", 850, "2026-05-26", ""],
                ["تمويل سناب", "تسويق", 267, "2026-05-27", ""],
                ["راتب زين (2)", "رواتب", 500, "2026-05-28", ""],
                ["راتب سيف", "رواتب", 1000, "2026-05-28", ""],
                ["تمويل فيس بوك", "تسويق", 200, "2026-05-28", ""]
            ];
            
            const stmt = db.prepare("INSERT INTO expenses (desc, cat, amt, date, note) VALUES (?, ?, ?, ?, ?)");
            defaultExpenses.forEach(exp => stmt.run(exp));
            stmt.finalize();
        }
    });
});

const crypto = require('crypto');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    const [salt, hash] = storedPassword.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
}

module.exports = {
    db,
    hashPassword,
    verifyPassword,
    // دوال مساعدة لجدول التهيئات (salla_config)
    getConfig: (key) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT value FROM salla_config WHERE key = ?", [key], (err, row) => {
                if (err) reject(err);
                else resolve(row ? JSON.parse(row.value) : null);
            });
        });
    },
    setConfig: (key, value) => {
        return new Promise((resolve, reject) => {
            const valStr = JSON.stringify(value);
            db.run(
                "INSERT INTO salla_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
                [key, valStr, valStr],
                (err) => {
                    if (err) reject(err);
                    else resolve(true);
                }
            );
        });
    },
    deleteConfig: (key) => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM salla_config WHERE key = ?", [key], (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }
};
