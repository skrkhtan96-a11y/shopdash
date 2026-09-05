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

async function main() {
    console.log('--- Table Info: salla_imported_orders ---');
    const tableInfo = await allSql("PRAGMA table_info(salla_imported_orders)");
    console.log(tableInfo.map(c => `${c.name} (${c.type})`).join(', '));

    console.log('\n--- 5 Distinct Product Names Metadata ---');
    const productsMeta = await allSql(`
        SELECT 
            product_name,
            COUNT(*) AS order_count,
            SUM(quantity) AS total_units_sold,
            MIN(date) AS first_sale_date,
            MAX(date) AS last_sale_date,
            SUM(amount) AS total_revenue
        FROM salla_imported_orders
        WHERE product_name IS NOT NULL AND product_name != ''
        GROUP BY product_name
        ORDER BY order_count DESC
    `);

    console.dir(productsMeta, { depth: null });

    // Check sample rows for each product to see if any extra columns/fields exist
    console.log('\n--- Sample Rows for each Product ---');
    for (const p of productsMeta) {
        const samples = await allSql(
            "SELECT * FROM salla_imported_orders WHERE product_name = ? LIMIT 1",
            [p.product_name]
        );
        console.log(`Product: "${p.product_name}" -> Sample Row:`, samples[0]);
    }

    db.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
