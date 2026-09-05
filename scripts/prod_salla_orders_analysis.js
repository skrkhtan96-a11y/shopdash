const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath);

const allSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

async function analyze() {
    const orderCount = await allSql("SELECT COUNT(*) as count FROM salla_imported_orders");
    console.log(`Total Salla Imported Orders: ${orderCount[0].count}`);

    const distinctProducts = await allSql(`
        SELECT product_name, COUNT(*) as order_count, SUM(quantity) as total_qty, SUM(amount) as total_revenue
        FROM salla_imported_orders
        WHERE product_name IS NOT NULL AND product_name != ''
        GROUP BY product_name
        ORDER BY order_count DESC
    `);

    console.log(`\nDistinct Product Names in Imported Orders (${distinctProducts.length}):`);
    distinctProducts.forEach((p, idx) => {
        console.log(`  ${idx + 1}. "${p.product_name}" | Orders: ${p.order_count} | Total Qty Sold: ${p.total_qty} | Total Revenue: ${p.total_revenue} SAR`);
    });

    const nullProductOrders = await allSql("SELECT COUNT(*) as count FROM salla_imported_orders WHERE product_name IS NULL OR product_name = ''");
    console.log(`\nOrders with NULL or Empty product_name: ${nullProductOrders[0].count}`);

    db.close();
}

analyze().catch(err => {
    console.error(err);
    process.exit(1);
});
