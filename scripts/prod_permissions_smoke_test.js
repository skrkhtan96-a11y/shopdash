process.env.NODE_ENV = 'test';

const request = require('supertest');
const assert = require('assert');
const app = require('../server');
const { db, hashPassword } = require('../database');
const { runMigration } = require('../src/migrations/migration_v1_product_control');

async function runPermissionsSmokeTest() {
    console.log('--- 6. Permissions Smoke Test ---');

    const server = app.listen(0, async () => {
        try {
            await runMigration(false);
            // 1. Unauthenticated -> 401
            console.log('  Testing Unauthenticated request to /api/product-control/products...');
            const unauthRes = await request(server).get('/api/product-control/products');
            console.log(`    Status: ${unauthRes.status} (Expected 401)`);
            assert.strictEqual(unauthRes.status, 401);

            // 2. Employee login (Read-only user)
            const empHash = hashPassword('EmpPass123!');
            db.run("INSERT OR REPLACE INTO users (id, username, email, password, role, created_at) VALUES (9991, 'smoke_emp', 'smoke_emp@test.local', ?, 'employee', '2026-09-05')", [empHash]);

            const loginEmpRes = await request(server)
                .post('/api/auth/login')
                .send({ login: 'smoke_emp', password: 'EmpPass123!' });

            const empCookie = loginEmpRes.headers['set-cookie'][0];

            // Employee GET -> 200 OK
            console.log('  Testing Employee GET /api/product-control/products...');
            const empReadRes = await request(server)
                .get('/api/product-control/products')
                .set('Cookie', empCookie);
            console.log(`    Status: ${empReadRes.status} (Expected 200)`);
            assert.strictEqual(empReadRes.status, 200);

            // Employee POST write -> 403 Forbidden
            console.log('  Testing Employee POST /api/product-control/purchases (Unauthorized Write)...');
            const empWriteRes = await request(server)
                .post('/api/product-control/purchases')
                .set('Cookie', empCookie)
                .send({ items: [] });
            console.log(`    Status: ${empWriteRes.status} (Expected 403)`);
            assert.strictEqual(empWriteRes.status, 403);

            // 3. Admin login (Read/Write user)
            const adminHash = hashPassword('AdminPass123!');
            db.run("INSERT OR REPLACE INTO users (id, username, email, password, role, created_at) VALUES (9992, 'smoke_admin', 'smoke_admin@test.local', ?, 'admin', '2026-09-05')", [adminHash]);

            const loginAdminRes = await request(server)
                .post('/api/auth/login')
                .send({ login: 'smoke_admin', password: 'AdminPass123!' });

            const adminCookie = loginAdminRes.headers['set-cookie'][0];

            console.log('  Testing Admin GET /api/product-control/products...');
            const adminReadRes = await request(server)
                .get('/api/product-control/products')
                .set('Cookie', adminCookie);
            console.log(`    Status: ${adminReadRes.status} (Expected 200)`);
            assert.strictEqual(adminReadRes.status, 200);

            console.log('  ✅ Permissions Smoke Test Passed Successfully!');
            server.close();
            process.exit(0);
        } catch (err) {
            console.error('❌ Permissions Smoke Test Failed:', err);
            server.close();
            process.exit(1);
        }
    });
}

runPermissionsSmokeTest();
