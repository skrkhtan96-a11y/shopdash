const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const isTest = process.env.NODE_ENV === 'test';
const dbPath = isTest ? ':memory:' : path.join(__dirname, 'database.db');

if (isTest) {
    console.log('🧪 Running in TEST mode. Initializing SQLite IN-MEMORY database (:memory:)');
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('خطأ أثناء فتح قاعدة البيانات:', err.message);
    } else {
        console.log(isTest ? '🧪 Test SQLite DB connected in-memory (:memory:)' : 'قاعدة البيانات متصلة بنجاح (SQLite)');
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

    // 3.5 جدول الاتصال بـ جوجل درايف (OAuth state & credentials)
    db.run(`
        CREATE TABLE IF NOT EXISTS google_config (
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
            quantity INTEGER DEFAULT 1,
            customer_phone TEXT
        )
    `);

    db.run("ALTER TABLE salla_imported_orders ADD COLUMN customer_phone TEXT", (err) => { /* تجاهل الخطأ إذا كان العمود موجوداً */ });

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
            can_add INTEGER DEFAULT 1,
            can_edit INTEGER DEFAULT 1,
            can_delete INTEGER DEFAULT 1,
            can_deliver INTEGER DEFAULT 1,
            can_view_ps_details INTEGER DEFAULT 1,
            can_view_games_details INTEGER DEFAULT 1,
            can_view_external_sales INTEGER DEFAULT 1,
            
            can_view_expenses INTEGER DEFAULT 1,
            can_add_expenses INTEGER DEFAULT 1,
            can_edit_expenses INTEGER DEFAULT 1,
            can_delete_expenses INTEGER DEFAULT 1,
            
            can_add_external_sales INTEGER DEFAULT 1,
            can_edit_external_sales INTEGER DEFAULT 1,
            can_delete_external_sales INTEGER DEFAULT 1,
            
            can_view_campaigns INTEGER DEFAULT 1,
            can_add_campaigns INTEGER DEFAULT 1,
            can_edit_campaigns INTEGER DEFAULT 1,
            can_delete_campaigns INTEGER DEFAULT 1,
            
            can_view_certificates INTEGER DEFAULT 1,
            can_add_certificates INTEGER DEFAULT 1,
            can_edit_certificates INTEGER DEFAULT 1,
            can_delete_certificates INTEGER DEFAULT 1,
            
            can_view_ps INTEGER DEFAULT 1,
            can_add_ps INTEGER DEFAULT 1,
            can_edit_ps INTEGER DEFAULT 1,
            can_delete_ps INTEGER DEFAULT 1,
            
            can_view_games INTEGER DEFAULT 1,
            can_add_games INTEGER DEFAULT 1,
            can_edit_games INTEGER DEFAULT 1,
            can_delete_games INTEGER DEFAULT 1,
            
            can_view_salla_orders INTEGER DEFAULT 1,
            can_view_salla_carts INTEGER DEFAULT 1,
            can_view_salla_wallet INTEGER DEFAULT 1,
            can_view_salla_products INTEGER DEFAULT 1,
            can_edit_salla_products INTEGER DEFAULT 1,
            can_view_salla_compare INTEGER DEFAULT 1,
            can_view_salla_webhooks INTEGER DEFAULT 1,
            can_edit_salla_webhooks INTEGER DEFAULT 1,
            
            can_view_import INTEGER DEFAULT 1,
            can_add_import INTEGER DEFAULT 1,
            can_view_archive_tool INTEGER DEFAULT 1,
            can_add_archive_tool INTEGER DEFAULT 1,
            can_view_export INTEGER DEFAULT 1,
            can_view_db_management INTEGER DEFAULT 1,
            can_edit_db_management INTEGER DEFAULT 1,
            can_view_activity_logs INTEGER DEFAULT 1,
            
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

    // 11. جدول الاتصال بالحسابات الإعلانية
    db.run(`
        CREATE TABLE IF NOT EXISTS ads_connections (
            platform TEXT PRIMARY KEY,
            account_id TEXT,
            access_token TEXT,
            refresh_token TEXT,
            expires_at TEXT,
            status TEXT DEFAULT 'disconnected'
        )
    `);

    // 12. جدول إحصائيات تحليلات الحملات الإعلانية
    db.run(`
        CREATE TABLE IF NOT EXISTS ads_campaign_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id TEXT UNIQUE,
            campaign_name TEXT NOT NULL,
            platform TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            spend REAL DEFAULT 0,
            clicks INTEGER DEFAULT 0,
            impressions INTEGER DEFAULT 0,
            conversions INTEGER DEFAULT 0,
            date TEXT NOT NULL,
            archived_in TEXT DEFAULT NULL
        )
    `);

    // 13. جدول الشهادات والتقارير (بلس ايفون وسناب)
    db.run(`
        CREATE TABLE IF NOT EXISTS certificates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            total_subs INTEGER DEFAULT 0,
            sold_subs INTEGER DEFAULT 0,
            comp_subs INTEGER DEFAULT 0,
            ads_spend REAL DEFAULT 0,
            status TEXT DEFAULT 'active',
            note TEXT,
            updated_at TEXT NOT NULL
        )
    `);

    // 14. جدول مخزون حسابات بلايستيشن بلس
    db.run(`
        CREATE TABLE IF NOT EXISTS ps_plus_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            plus_type TEXT NOT NULL,
            plus_duration TEXT NOT NULL,
            ps5_1_order TEXT,
            ps5_1_phone TEXT,
            ps5_1_status TEXT DEFAULT 'available',
            ps5_2_order TEXT,
            ps5_2_phone TEXT,
            ps5_2_status TEXT DEFAULT 'available',
            ps4_order TEXT,
            ps4_phone TEXT,
            ps4_status TEXT DEFAULT 'available',
            created_by TEXT,
            ps5_1_delivered_by TEXT,
            ps5_2_delivered_by TEXT,
            ps4_delivered_by TEXT,
            ps5_1_code TEXT,
            ps5_2_code TEXT,
            ps4_code TEXT,
            ps5_1_delivered_at TEXT,
            ps5_2_delivered_at TEXT,
            ps4_delivered_at TEXT,
            is_archived INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    `);

    // 14.5 جدول مخزون حسابات الألعاب
    db.run(`
        CREATE TABLE IF NOT EXISTS game_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            game_name TEXT NOT NULL,
            created_by TEXT,
            created_at TEXT NOT NULL
        )
    `);

    // 14.6 جدول نسخ/سلوتات الألعاب
    db.run(`
        CREATE TABLE IF NOT EXISTS game_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            slot_type TEXT NOT NULL, -- 'PS5' or 'PS4'
            slot_index INTEGER NOT NULL,
            status TEXT DEFAULT 'available', -- 'available' or 'delivered'
            code TEXT,
            order_number TEXT,
            phone TEXT,
            delivered_by TEXT,
            delivered_at TEXT,
            FOREIGN KEY(account_id) REFERENCES game_accounts(id) ON DELETE CASCADE
        )
    `);

    // 15. جدول سجل النشاطات (Activity Logs)
    db.run(`
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            action_type TEXT NOT NULL,
            section TEXT NOT NULL,
            details TEXT NOT NULL,
            timestamp TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    // 16. جدول المنتجات وإدارة المخزون المستقلة
    db.run(`
        CREATE TABLE IF NOT EXISTS inventory_products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_name TEXT UNIQUE NOT NULL,
            sku TEXT,
            quantity INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            price REAL DEFAULT 0,
            category TEXT DEFAULT 'عام',
            notes TEXT,
            created_at TEXT NOT NULL
        )
    `);

    // 16.5. جدول إعدادات أسعار المنتجات (كتالوج الأسعار الديناميكي)
    db.run(`
        CREATE TABLE IF NOT EXISTS product_pricing_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_name TEXT NOT NULL,
            period TEXT NOT NULL DEFAULT '',
            purchase_price REAL NOT NULL DEFAULT 0,
            selling_price REAL NOT NULL DEFAULT 0,
            copies_per_unit INTEGER DEFAULT 1,
            free_bundle_product TEXT DEFAULT NULL,
            free_bundle_qty_multiplier REAL DEFAULT 0,
            notes TEXT,
            UNIQUE(product_name, period)
        )
    `);

    // بذرة بيانات كتالوج الأسعار الافتراضية للمنتجات
    db.get("SELECT COUNT(*) as count FROM product_pricing_rules", (err, row) => {
        if (!err && row && row.count === 0) {
            console.log('[Pricing] جدول أسعار المنتجات فارغ، جاري تعبئة الأسعار الافتراضية...');
            const defaults = [
                // سناب ماكس
                ['كود سناب max', 'يومي', 2.5, 5, 1, null, 0, null],
                ['كود سناب max', 'اسبوعي', 5, 15, 1, null, 0, null],
                ['كود سناب max', 'شهري', 15, 25, 1, 'كود سناب max (يومي)', 1, 'شراء شهري يمنح يومي مجاني بنفس الكمية'],
                ['كود سناب max', '3 أشهر', 45, 69, 1, null, 0, null],
                ['كود سناب max', '6 أشهر', 85, 129, 1, null, 0, null],
                ['كود سناب max', '9 أشهر', 130, 189, 1, null, 0, null],
                ['كود سناب max', 'سنة', 170, 249, 1, null, 0, null],
                // سناب بلس
                ['سناب بلس', 'يومي', 3, 7.5, 1, null, 0, null],
                ['سناب بلس', 'اسبوعي', 5, 15, 1, null, 0, null],
                ['سناب بلس', 'شهري', 15, 25, 1, 'سناب بلس - يومي', 1, 'شراء شهري يمنح يومي مجاني بنفس الكمية'],
                // بلايستيشن بلس أساسي PS5
                ['بلس PS5 أساسي', 'شهري', 34.0, 23.0, 3, null, 0, 'الباقة 3 نسخ: 2 PS5 + 1 PS4'],
                ['بلس PS5 أساسي', '3 أشهر', 87.0, 50.0, 3, null, 0, null],
                ['بلس PS5 أساسي', 'سنة', 245.0, 135.0, 3, null, 0, null],
                // بلايستيشن بلس إضافي PS5
                ['بلس PS5 إضافي', 'شهري', 52.0, 37.0, 3, null, 0, null],
                ['بلس PS5 إضافي', '3 أشهر', 143.0, 85.0, 3, null, 0, null],
                ['بلس PS5 إضافي', 'سنة', 406.0, 195.0, 3, null, 0, null],
                // بلايستيشن بلس فاخر PS5
                ['بلس PS5 فاخر', 'شهري', 61.0, 48.0, 3, null, 0, null],
                ['بلس PS5 فاخر', '3 أشهر', 166.0, 115.0, 3, null, 0, null],
                ['بلس PS5 فاخر', 'سنة', 469.0, 265.0, 3, null, 0, null]
            ];
            const stmt = db.prepare("INSERT OR IGNORE INTO product_pricing_rules (product_name, period, purchase_price, selling_price, copies_per_unit, free_bundle_product, free_bundle_qty_multiplier, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            defaults.forEach(d => stmt.run(d));
            stmt.finalize();
        } else {
            // تصحيح الأسعار القديمة لتكون أسعار الحزم الكاملة بدلاً من أسعار النسخ الفردية
            db.run(`UPDATE product_pricing_rules SET purchase_price = 34.0 WHERE product_name = 'بلس PS5 أساسي' AND period = 'شهري' AND purchase_price < 12`);
            db.run(`UPDATE product_pricing_rules SET purchase_price = 87.0 WHERE product_name = 'بلس PS5 أساسي' AND period = '3 أشهر' AND purchase_price < 30`);
            db.run(`UPDATE product_pricing_rules SET purchase_price = 245.0 WHERE product_name = 'بلس PS5 أساسي' AND period = 'سنة' AND purchase_price < 85`);
            
            db.run(`UPDATE product_pricing_rules SET purchase_price = 52.0 WHERE product_name = 'بلس PS5 إضافي' AND period = 'شهري' AND purchase_price < 18`);
            db.run(`UPDATE product_pricing_rules SET purchase_price = 143.0 WHERE product_name = 'بلس PS5 إضافي' AND period = '3 أشهر' AND purchase_price < 48`);
            db.run(`UPDATE product_pricing_rules SET purchase_price = 406.0 WHERE product_name = 'بلس PS5 إضافي' AND period = 'سنة' AND purchase_price < 136`);
            
            db.run(`UPDATE product_pricing_rules SET purchase_price = 61.0 WHERE product_name = 'بلس PS5 فاخر' AND period = 'شهري' AND purchase_price < 21`);
            db.run(`UPDATE product_pricing_rules SET purchase_price = 166.0 WHERE product_name = 'بلس PS5 فاخر' AND period = '3 أشهر' AND purchase_price < 56`);
            db.run(`UPDATE product_pricing_rules SET purchase_price = 469.0 WHERE product_name = 'بلس PS5 فاخر' AND period = 'سنة' AND purchase_price < 157`);
        }
    });

    // 18. جدول المبيعات الخارجية المبسطة
    db.run(`
        CREATE TABLE IF NOT EXISTS external_sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_name TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            amount REAL NOT NULL,
            bank_account TEXT NOT NULL,
            customer_name TEXT,
            customer_phone TEXT,
            transfer_reference TEXT,
            status TEXT DEFAULT 'delivered',
            notes TEXT,
            country TEXT,
            order_number TEXT,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);

    // 19. جدول سجلات الويب هوك (Salla Webhook Logs)
    db.run(`
        CREATE TABLE IF NOT EXISTS salla_webhook_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            payload TEXT,
            status TEXT DEFAULT 'success',
            error_message TEXT,
            received_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);



    // ترقية جدول إحصائيات الإعلانات لإضافة الميزانية ونمط الميزانية
    db.run("ALTER TABLE ads_campaign_metrics ADD COLUMN budget REAL DEFAULT 0", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ads_campaign_metrics ADD COLUMN budget_mode TEXT DEFAULT 'BUDGET_MODE_INFINITE'", (err) => { /* تجاهل الخطأ */ });
    
    // ترقية جدول المصروفات والمبيعات الخارجية لإضافة رابط إيصال الرفع (اختياري)
    db.run("ALTER TABLE expenses ADD COLUMN receipt_url TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE external_sales ADD COLUMN receipt_url TEXT", (err) => { /* تجاهل الخطأ */ });

    // ترقية جدول المبيعات الخارجية لإضافة عمود الدولة ورقم الطلب
    db.run("ALTER TABLE external_sales ADD COLUMN country TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE external_sales ADD COLUMN order_number TEXT", (err) => { /* تجاهل الخطأ */ });
    
    // ترقية جدول المستخدمين لإضافة صلاحيات التحكم بمخزون الحسابات بلس والألعاب
    db.run("ALTER TABLE users ADD COLUMN can_add INTEGER DEFAULT 1", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit INTEGER DEFAULT 1", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE users ADD COLUMN can_delete INTEGER DEFAULT 1", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE users ADD COLUMN can_deliver INTEGER DEFAULT 1", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_ps_details INTEGER DEFAULT 1", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_games_details INTEGER DEFAULT 1", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_external_sales INTEGER DEFAULT 1", (err) => { /* تجاهل الخطأ */ });

    // ترقية جدول المستخدمين لإضافة الصلاحيات التفصيلية الجديدة
    db.run("ALTER TABLE users ADD COLUMN can_view_expenses INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_add_expenses INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_expenses INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_delete_expenses INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    
    db.run("ALTER TABLE users ADD COLUMN can_add_external_sales INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_external_sales INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_delete_external_sales INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    
    db.run("ALTER TABLE users ADD COLUMN can_view_campaigns INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_add_campaigns INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_campaigns INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_delete_campaigns INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    
    db.run("ALTER TABLE users ADD COLUMN can_view_certificates INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_add_certificates INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_certificates INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_delete_certificates INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    
    db.run("ALTER TABLE users ADD COLUMN can_view_ps INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_add_ps INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_ps INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_delete_ps INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    
    db.run("ALTER TABLE users ADD COLUMN can_view_games INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_add_games INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_games INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_delete_games INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    
    db.run("ALTER TABLE users ADD COLUMN can_view_salla_orders INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_salla_carts INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_salla_wallet INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_salla_products INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_salla_products INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_salla_compare INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_salla_webhooks INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_salla_webhooks INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    
    db.run("ALTER TABLE users ADD COLUMN can_view_import INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_add_import INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_archive_tool INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_add_archive_tool INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_export INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_db_management INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_edit_db_management INTEGER DEFAULT 1", (err) => { /* تجاهل */ });
    db.run("ALTER TABLE users ADD COLUMN can_view_activity_logs INTEGER DEFAULT 1", (err) => { /* تجاهل */ });

    // ترقية جدول حسابات البلس لإضافة اسم المستخدم الذي قام بإضافة الحساب
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN created_by TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps5_1_delivered_by TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps5_2_delivered_by TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps4_delivered_by TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps5_1_code TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps5_2_code TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps4_code TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps5_1_delivered_at TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps5_2_delivered_at TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN ps4_delivered_at TEXT", (err) => { /* تجاهل الخطأ */ });
    db.run("ALTER TABLE ps_plus_accounts ADD COLUMN is_archived INTEGER DEFAULT 0", (err) => { /* تجاهل الخطأ */ });

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

const { hashPassword, verifyPassword } = require('./src/utils/crypto');

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
    },
    logActivity: (username, action_type, section, details) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO activity_logs (username, action_type, section, details) VALUES (?, ?, ?, ?)",
                [username || 'System', action_type, section, details],
                (err) => {
                    if (err) reject(err);
                    else resolve(true);
                }
            );
        });
    }
};
