const request = require('supertest');
const expect = require('chai').expect;
const app = require('../server');
const db = require('../database');
const { runMigration } = require('../src/migrations/migration_v2_product_families');

describe('📦 Product Family & Duration Variants Test Suite', function () {
    this.timeout(10000);

    let authCookie = null;

    before(async function () {
        const ProductControlRepository = require('../src/repositories/product_control.repository');

        // Seed products into test db
        const seedProducts = [
            { id: 25, name: 'كود سناب max (يومي)', sku: 'SNAP-MAX-DAY', qty: 10, cost: 2.5, price: 5, category: 'سناب' },
            { id: 26, name: 'كود سناب max (اسبوعي)', sku: 'SNAP-MAX-WK', qty: 15, cost: 5, price: 15, category: 'سناب' },
            { id: 27, name: 'كود سناب max (شهري)', sku: 'SNAP-MAX-MTH', qty: 20, cost: 15, price: 25, category: 'سناب' },
            { id: 28, name: 'سناب بلس (شهري)', sku: 'SNAP-PLUS-MTH', qty: 8, cost: 15, price: 25, category: 'سناب' },
            { id: 29, name: 'اشتراك تطبيق مجتمع زيرة', sku: 'ZEERA-SUB', qty: 5, cost: 50, price: 100, category: 'اشتراكات' },
            { id: 30, name: 'بلايستيشن بلس أساسي PS5 (شهري)', sku: 'PS5-BAS-1M', qty: 12, cost: 23, price: 34, category: 'بلايستيشن' },
            { id: 31, name: 'بلايستيشن بلس أساسي PS5 (3 أشهر)', sku: 'PS5-BAS-3M', qty: 8, cost: 50, price: 87, category: 'بلايستيشن' },
            { id: 32, name: 'بلايستيشن بلس أساسي PS5 (سنة)', sku: 'PS5-BAS-1Y', qty: 5, cost: 135, price: 245, category: 'بلايستيشن' },
            { id: 33, name: 'بلايستيشن بلس إضافي PS5 (شهري)', sku: 'PS5-EXT-1M', qty: 14, cost: 37, price: 52, category: 'بلايستيشن' },
            { id: 34, name: 'بلايستيشن بلس إضافي PS5 (3 أشهر)', sku: 'PS5-EXT-3M', qty: 10, cost: 85, price: 143, category: 'بلايستيشن' },
            { id: 35, name: 'بلايستيشن بلس إضافي PS5 (سنة)', sku: 'PS5-EXT-1Y', qty: 6, cost: 195, price: 406, category: 'بلايستيشن' },
            { id: 36, name: 'بلايستيشن بلس فاخر PS5 (شهري)', sku: 'PS5-PRM-1M', qty: 9, cost: 48, price: 61, category: 'بلايستيشن' },
            { id: 37, name: 'بلايستيشن بلس فاخر PS5 (3 أشهر)', sku: 'PS5-PRM-3M', qty: 7, cost: 115, price: 166, category: 'بلايستيشن' },
            { id: 38, name: 'بلايستيشن بلس فاخر PS5 (سنة)', sku: 'PS5-PRM-1Y', qty: 4, cost: 265, price: 469, category: 'بلايستيشن' },
            { id: 39, name: 'بلايستيشن بلس أساسي PS4 (شهري)', sku: 'PS4-BAS-1M', qty: 11, cost: 20, price: 30, category: 'بلايستيشن' },
            { id: 40, name: 'بلايستيشن بلس أساسي PS4 (3 أشهر)', sku: 'PS4-BAS-3M', qty: 7, cost: 45, price: 75, category: 'بلايستيشن' },
            { id: 41, name: 'بلايستيشن بلس أساسي PS4 (سنة)', sku: 'PS4-BAS-1Y', qty: 3, cost: 120, price: 210, category: 'بلايستيشن' },
            { id: 42, name: 'بلايستيشن بلس إضافي PS4 (شهري)', sku: 'PS4-EXT-1M', qty: 13, cost: 32, price: 45, category: 'بلايستيشن' },
            { id: 43, name: 'بلايستيشن بلس إضافي PS4 (3 أشهر)', sku: 'PS4-EXT-3M', qty: 9, cost: 75, price: 125, category: 'بلايستيشن' },
            { id: 44, name: 'بلايستيشن بلس إضافي PS4 (سنة)', sku: 'PS4-EXT-1Y', qty: 5, cost: 175, price: 350, category: 'بلايستيشن' },
            { id: 45, name: 'بلايستيشن بلس فاخر PS4 (شهري)', sku: 'PS4-PRM-1M', qty: 8, cost: 42, price: 55, category: 'بلايستيشن' },
            { id: 46, name: 'بلايستيشن بلس فاخر PS4 (3 أشهر)', sku: 'PS4-PRM-3M', qty: 6, cost: 105, price: 150, category: 'بلايستيشن' },
            { id: 47, name: 'بلايستيشن بلس فاخر PS4 (سنة)', sku: 'PS4-PRM-1Y', qty: 3, cost: 240, price: 420, category: 'بلايستيشن' }
        ];

        for (const p of seedProducts) {
            await ProductControlRepository.runSql(
                `INSERT OR IGNORE INTO inventory_products (id, product_name, sku, quantity, cost, price, category, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01')`,
                [p.id, p.name, p.sku, p.qty, p.cost, p.price, p.category]
            );
        }

        // Run migration v2 on test db
        await runMigration(true);

        // Seed test admin user
        const { hashPassword } = require('../database');
        
        try {
            const adminHash = hashPassword('FamAdmin123!');
            await ProductControlRepository.runSql(
                "INSERT OR IGNORE INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)",
                ['fam_admin', 'fam_admin@test.local', adminHash, 'admin', '2026-09-01']
            );

            const res = await request(app)
                .post('/api/auth/login')
                .send({ login: 'fam_admin', password: 'FamAdmin123!' });
            
            if (res.headers['set-cookie']) {
                authCookie = res.headers['set-cookie'][0];
            }
        } catch (e) {
            console.error('Auth seed error:', e.message);
        }
    });

    describe('1. Unified Catalog API (GET /api/product-control/catalog)', function () {
        it('should return both FAMILY items and STANDALONE items', async function () {
            const res = await request(app)
                .get('/api/product-control/catalog')
                .set('Cookie', authCookie || []);

            expect(res.status).to.equal(200);
            expect(res.body.success).to.be.true;
            expect(res.body.data).to.be.an('array');

            const families = res.body.data.filter(item => item.type === 'FAMILY');
            const standalones = res.body.data.filter(item => item.type === 'STANDALONE');

            expect(families.length).to.be.at.least(6);
            expect(standalones.length).to.be.at.least(5);
        });

        it('should allow searching catalog by product name', async function () {
            const res = await request(app)
                .get('/api/product-control/catalog?search=PS5')
                .set('Cookie', authCookie || []);

            expect(res.status).to.equal(200);
            expect(res.body.success).to.be.true;
            const ps5Items = res.body.data.filter(item => item.product_name.includes('PS5') || (item.variants && item.variants.some(v => v.product_name.includes('PS5'))));
            expect(ps5Items.length).to.be.at.least(3);
        });
    });

    describe('2. Families Overview API (GET /api/product-control/families)', function () {
        it('should return 6 PlayStation Plus product families', async function () {
            const res = await request(app)
                .get('/api/product-control/families')
                .set('Cookie', authCookie || []);

            expect(res.status).to.equal(200);
            expect(res.body.success).to.be.true;
            expect(res.body.data).to.be.an('array');
            expect(res.body.data.length).to.be.at.least(6);

            const familyCodes = res.body.data.map(f => f.family_code);
            expect(familyCodes).to.include('PS5_BASIC');
            expect(familyCodes).to.include('PS5_EXTRA');
            expect(familyCodes).to.include('PS5_PREMIUM');
            expect(familyCodes).to.include('PS4_BASIC');
            expect(familyCodes).to.include('PS4_EXTRA');
            expect(familyCodes).to.include('PS4_PREMIUM');
        });
    });

    describe('3. Family Details & Duration Aggregations (GET /api/product-control/families/:id/details)', function () {
        let sampleFamilyId = null;

        before(async function () {
            const res = await request(app)
                .get('/api/product-control/families')
                .set('Cookie', authCookie || []);
            sampleFamilyId = res.body.data[0].id;
        });

        it('should return family details for duration=all with aggregated metrics and breakdown', async function () {
            const res = await request(app)
                .get(`/api/product-control/families/${sampleFamilyId}/details?duration=all`)
                .set('Cookie', authCookie || []);

            expect(res.status).to.equal(200);
            expect(res.body.success).to.be.true;
            expect(res.body.data).to.have.property('family');
            expect(res.body.data).to.have.property('summary_metrics');
            expect(res.body.data).to.have.property('breakdown');
            expect(res.body.data.breakdown.length).to.be.at.least(3);
        });

        it('should return single duration details when duration=monthly is requested', async function () {
            const res = await request(app)
                .get(`/api/product-control/families/${sampleFamilyId}/details?duration=monthly`)
                .set('Cookie', authCookie || []);

            expect(res.status).to.equal(200);
            expect(res.body.success).to.be.true;
            expect(res.body.data.selected_duration).to.equal('MONTHLY');
            expect(res.body.data.selected_variant.duration_code).to.equal('MONTHLY');
        });
    });

    describe('4. Backwards Compatibility for Legacy APIs', function () {
        it('should still support GET /api/product-control/products for flat legacy views', async function () {
            const res = await request(app)
                .get('/api/product-control/products')
                .set('Cookie', authCookie || []);

            expect(res.status).to.equal(200);
            expect(res.body.success).to.be.true;
            expect(res.body.data).to.be.an('array');
            expect(res.body.data.length).to.be.at.least(23);
        });
    });
});
