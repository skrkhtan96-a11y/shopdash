const db = require('../src/config/db');
db.serialize(() => {
    db.get("SELECT sql FROM sqlite_master WHERE name='product_inventory_counts'", (err, row) => {
        console.log('product_inventory_counts DDL:\n', row ? row.sql : 'NOT FOUND');
    });
    db.get("SELECT sql FROM sqlite_master WHERE name='product_stock_movements'", (err, row) => {
        console.log('product_stock_movements DDL:\n', row ? row.sql : 'NOT FOUND');
    });
});
