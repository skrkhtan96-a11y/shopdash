const assert = require('assert');
const db = require('../src/config/db');
const { runMigration } = require('../src/migrations/migration_v1_product_control');

describe('Database Stage & Hardening - Product Control Center Integrity Tests', () => {
    const beforeFn = typeof before === 'function' ? before : beforeAll;
    beforeFn(async () => {
        // Run migration with forceRebuild to ensure strict RESTRICT schema
        await runMigration(true);
    });

    it('1. Schema migration version is recorded in schema_migrations', (done) => {
        db.get("SELECT * FROM schema_migrations WHERE version = 1", [], (err, row) => {
            assert.strictEqual(err, null);
            assert.ok(row);
            assert.strictEqual(row.version, 1);
            assert.ok(row.name.includes('v1_product_control_center_init'));
            done();
        });
    });

    it('2. Product Control tables exist in database', (done) => {
        const requiredTables = [
            'schema_migrations',
            'salla_product_mapping',
            'product_inventory_counts',
            'purchase_headers',
            'purchase_items',
            'product_expense_allocations',
            'product_status_history',
            'product_control_audit_logs',
            'product_stock_movements',
            'product_control_config'
        ];

        db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
            assert.strictEqual(err, null);
            const tableNames = rows.map(r => r.name);
            requiredTables.forEach(table => {
                assert.ok(tableNames.includes(table), `Table ${table} should exist`);
            });
            done();
        });
    });

    it('3. Idempotency constraint on product_stock_movements rejects duplicate movement events', (done) => {
        const nowIso = new Date().toISOString();
        db.run("INSERT INTO inventory_products (product_name, quantity, created_at) VALUES ('منتج تجريبي 1', 10, ?)", [nowIso], function(errProd) {
            assert.strictEqual(errProd, null);
            const prodId = this.lastID;

            const movement = [
                prodId, 'SALE', -1, 'ORDER_TEST_1', 'ITEM_TEST_1', 'MAIN', nowIso
            ];

            db.run(
                `INSERT INTO product_stock_movements 
                (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                movement,
                function (err1) {
                    assert.strictEqual(err1, null);

                    // Attempt duplicate insert with exact same idempotency tuple
                    db.run(
                        `INSERT INTO product_stock_movements 
                        (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) 
                        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        movement,
                        function (err2) {
                            assert.ok(err2);
                            assert.ok(err2.message.includes('UNIQUE constraint failed'));
                            done();
                        }
                    );
                }
            );
        });
    });

    it('4. Partial return idempotency allows different return event reference IDs', (done) => {
        const nowIso = new Date().toISOString();
        db.run("INSERT INTO inventory_products (product_name, quantity, created_at) VALUES ('منتج تجريبي 2', 5, ?)", [nowIso], function(errProd) {
            assert.strictEqual(errProd, null);
            const prodId = this.lastID;

            const return1 = [prodId, 'SALE_RETURN', 1, 'ORDER_TEST_2', 'ITEM_TEST_2', 'RET_EVENT_1', nowIso];
            const return2 = [prodId, 'SALE_RETURN', 1, 'ORDER_TEST_2', 'ITEM_TEST_2', 'RET_EVENT_2', nowIso];

            db.run(
                `INSERT INTO product_stock_movements 
                (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                return1,
                function (err1) {
                    assert.strictEqual(err1, null);

                    db.run(
                        `INSERT INTO product_stock_movements 
                        (product_id, movement_type, quantity, source_reference_id, source_item_reference_id, source_event_reference_id, movement_at) 
                        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        return2,
                        function (err2) {
                            assert.strictEqual(err2, null);
                            done();
                        }
                    );
                }
            );
        });
    });

    it('5. Multi-product purchase invoice headers and items hierarchy works with Integer Halalas', (done) => {
        const nowIso = new Date().toISOString();
        db.run("INSERT INTO inventory_products (product_name, quantity, created_at) VALUES ('منتج تجريبي 3', 20, ?)", [nowIso], function(errProd) {
            assert.strictEqual(errProd, null);
            const prodId = this.lastID;

            db.run(
                `INSERT INTO purchase_headers (purchased_at, supplier, invoice_ref, total_invoice_amount_halalas, created_by)
                 VALUES (?, 'المورد التكتيكي', 'INV-1005', 150000, 'عصام')`,
                [nowIso],
                function (errHeader) {
                    assert.strictEqual(errHeader, null);
                    const headerId = this.lastID;

                    db.run(
                        `INSERT INTO purchase_items (header_id, product_id, quantity, unit_cost_halalas, total_amount_halalas)
                         VALUES (?, ?, 10, 15000, 150000)`,
                        [headerId, prodId],
                        function (errItem) {
                            assert.strictEqual(errItem, null);
                            done();
                        }
                    );
                }
            );
        });
    });

    it('6. RESTRICT policy prevents deleting product with historical records', (done) => {
        const nowIso = new Date().toISOString();
        db.run("INSERT INTO inventory_products (product_name, quantity, created_at) VALUES ('منتج تجريبي 4', 15, ?)", [nowIso], function(errProd) {
            assert.strictEqual(errProd, null);
            const prodId = this.lastID;

            db.run(
                `INSERT INTO product_inventory_counts (product_id, inventory_at, actual_qty, expected_qty_at_count, variance, created_by)
                 VALUES (?, ?, 15, 15, 0, 'tester')`,
                [prodId, nowIso],
                function(errCount) {
                    assert.strictEqual(errCount, null);

                    db.run("DELETE FROM inventory_products WHERE id = ?", [prodId], function(errDelete) {
                        assert.ok(errDelete);
                        assert.ok(errDelete.message.includes('FOREIGN KEY constraint failed'));
                        done();
                    });
                }
            );
        });
    });

    it('7. Legacy expenses and sales integrity is untouched', (done) => {
        db.all("SELECT * FROM expenses", [], (err, rows) => {
            assert.strictEqual(err, null);
            assert.ok(rows);
            done();
        });
    });
});
