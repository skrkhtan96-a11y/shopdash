process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const app = require('../server');
const { db, hashPassword } = require('../database');
const { runMigration } = require('../src/migrations/migration_v1_product_control');

async function runPostDeploymentSmokeTest() {
    console.log('=== 4. Post-Deployment Smoke Test (9 Operational Journeys) ===');

    const server = app.listen(0, async () => {
        try {
            await runMigration(false);

            // Seed test product
            const resSeed = await new Promise((resolve, reject) => {
                db.run("INSERT INTO inventory_products (product_name, salla_product_id, sku, quantity, cost, price, cost_halalas, price_halalas, inventory_value_halalas, current_control_status, created_at) VALUES ('منتج تجريبي Smoke', 'SALLA-SMOKE', 'SKU-SMOKE', 0, 0, 0, 0, 0, 0, 'normal', datetime('now'))", function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            });

            // Create admin & employee
            const adminHash = hashPassword('AdminGoLive123!');
            const empHash = hashPassword('EmpGoLive123!');

            db.run("INSERT OR REPLACE INTO users (id, username, email, password, role, created_at) VALUES (8881, 'golive_admin', 'admin@golive.local', ?, 'admin', '2026-09-05')", [adminHash]);
            db.run("INSERT OR REPLACE INTO users (id, username, email, password, role, created_at) VALUES (8882, 'golive_emp', 'emp@golive.local', ?, 'employee', '2026-09-05')", [empHash]);

            // Journey 1: Login
            console.log('  1. Testing Login Endpoint (/api/auth/login)...');
            const loginRes = await request(server)
                .post('/api/auth/login')
                .send({ login: 'golive_admin', password: 'AdminGoLive123!' })
                .expect(200);

            const adminCookie = loginRes.headers['set-cookie'][0];
            assert.ok(adminCookie);
            console.log('     ✅ Login Successful!');

            // Journey 2: Product Control List
            console.log('  2. Testing Product Control List (/api/product-control/products)...');
            const listRes = await request(server)
                .get('/api/product-control/products?page=1&limit=10')
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(listRes.body.success, true);
            assert.ok(Array.isArray(listRes.body.data));
            console.log(`     ✅ Product List Retrieved (${listRes.body.data.length} products)!`);

            // Find a product ID
            const targetProd = listRes.body.data[0];
            const prodId = targetProd ? targetProd.id : 1;

            // Journey 3: Product Details
            console.log(`  3. Testing Product Details (/api/product-control/products/${prodId})...`);
            const detailRes = await request(server)
                .get(`/api/product-control/products/${prodId}`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(detailRes.body.success, true);
            assert.ok(detailRes.body.data.metrics);
            console.log('     ✅ Product Details Dashboard Loaded!');

            // Journey 4: Inventory Count History
            console.log(`  4. Testing Inventory History (/api/product-control/products/${prodId}/inventory-counts)...`);
            const invRes = await request(server)
                .get(`/api/product-control/products/${prodId}/inventory-counts`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(invRes.body.success, true);
            console.log('     ✅ Inventory History Retrieved!');

            // Journey 5: Purchase History
            console.log(`  5. Testing Purchases Endpoint (/api/product-control/products/${prodId}/purchases)...`);
            const purRes = await request(server)
                .get(`/api/product-control/products/${prodId}/purchases`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(purRes.body.success, true);
            console.log('     ✅ Purchases Log Retrieved!');

            // Journey 6: Pre-Purchase Check
            console.log(`  6. Testing Pre-Purchase Check (/api/product-control/products/${prodId}/pre-purchase-check)...`);
            const gateRes = await request(server)
                .get(`/api/product-control/products/${prodId}/pre-purchase-check`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.ok(typeof gateRes.body.allowed === 'boolean');
            console.log(`     ✅ Pre-Purchase Check Evaluated (Allowed: ${gateRes.body.allowed})!`);

            // Journey 7: Expense Allocation Endpoint
            console.log(`  7. Testing Expenses Endpoint (/api/product-control/products/${prodId}/expense-allocations)...`);
            const expRes = await request(server)
                .get(`/api/product-control/products/${prodId}/expense-allocations`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(expRes.body.success, true);
            console.log('     ✅ Expenses Allocations Endpoint Functional!');

            // Journey 8: Timeline & Audit Trail
            console.log(`  8. Testing Timeline Endpoint (/api/product-control/products/${prodId}/timeline)...`);
            const auditRes = await request(server)
                .get(`/api/product-control/products/${prodId}/timeline`)
                .set('Cookie', adminCookie)
                .expect(200);

            assert.strictEqual(auditRes.body.success, true);
            console.log('     ✅ Timeline & Audit Trail Functional!');

            // Journey 9: Permissions Enforcement (Employee Write 403)
            console.log('  9. Testing Employee Permissions (Write Attempt)...');
            const empLoginRes = await request(server)
                .post('/api/auth/login')
                .send({ login: 'golive_emp', password: 'EmpGoLive123!' });

            const empCookie = empLoginRes.headers['set-cookie'][0];
            await request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', empCookie)
                .send({ items: [] })
                .expect(403);

            console.log('     ✅ Permissions Enforcement Verified (403 Forbidden)!');

            console.log('\n🎉 ALL 9 POST-DEPLOYMENT SMOKE TESTS PASSED 100%!');
            server.close();
            process.exit(0);

        } catch (err) {
            console.error('❌ Post-Deployment Smoke Test Failed:', err);
            server.close();
            process.exit(1);
        }
    });
}

runPostDeploymentSmokeTest();
