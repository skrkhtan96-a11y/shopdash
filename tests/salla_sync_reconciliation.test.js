// Verifies the hourly polling/reconciliation job (SallaService.syncOrders) can catch a status
// change that happened in Salla on an order it already knows about — the fallback path for when
// a webhook is missed or arrives late. Salla's real API is monkey-patched (axios.get) since no
// mocking library is present in this project; this only overrides the single `.get` call the
// service makes and restores it immediately after each test.
process.env.NODE_ENV = 'test';

const assert = require('assert');
const axios = require('axios');
const { db } = require('../database');
require('../server'); // ensures db/tables are initialized the same way the app does
const SallaService = require('../src/services/salla.service');

function getOrderRow(refId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM salla_imported_orders WHERE reference_id = ?", [refId], (err, row) => {
            err ? reject(err) : resolve(row);
        });
    });
}

function insertLegacyRow(refId, { statusSlug, statusName, externalUpdatedAt }) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO salla_imported_orders
             (reference_id, date, status_slug, status_name, payment_method, amount, customer_name, product_name, quantity, customer_phone, external_updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [refId, '2026-09-10', statusSlug, statusName, 'mada', 40, 'عميل قديم', 'منتج قديم', 1, '0511111111', externalUpdatedAt || null],
            (err) => err ? reject(err) : resolve()
        );
    });
}

describe('🔁 SallaService.syncOrders - polling reconciliation fallback', () => {
    let originalGet;

    beforeEach(() => { originalGet = axios.get; });
    afterEach(() => { axios.get = originalGet; });

    it('[Test H] detects and applies a status change on an order that already exists locally, without creating a duplicate', async () => {
        const refId = '950001';
        // Simulate: this order was correctly created earlier (e.g. by the webhook), still shows the
        // OLD status locally, and has never had a fresh external_updated_at recorded (pre-fix state).
        await insertLegacyRow(refId, { statusSlug: 'under_review', statusName: 'بإنتظار المراجعة', externalUpdatedAt: null });

        // Fake Salla response: same order, but now "completed" with a newer updated_at.
        axios.get = async (url) => {
            if (String(url).includes('per_page')) {
                return {
                    data: {
                        data: [{
                            id: 800000001,
                            reference_id: Number(refId),
                            date: { date: '2026-09-10 09:00:00.000000' },
                            updated_at: { date: '2026-09-21 08:00:00.000000' },
                            status: { slug: 'completed', name: 'تم التنفيذ' },
                            payment_method: 'credit_card',
                            amounts: { total: { amount: 40, currency: 'SAR' } },
                            customer: { first_name: 'عميل', last_name: 'قديم', mobile: '0511111111' },
                            items: [{ name: 'منتج قديم', quantity: 1 }]
                        }],
                        pagination: { links: {} } // no next page -> loop ends after this page
                    }
                };
            }
            throw new Error('Unexpected axios.get call: ' + url);
        };

        const count = await SallaService.syncOrders(true, false);
        assert.ok(count >= 1, 'syncOrders should report at least 1 processed order');

        const row = await getOrderRow(refId);
        assert.ok(row, 'order row should still exist');
        assert.strictEqual(row.status_slug, 'completed', 'polling should have updated the stale status to what Salla now reports');
        assert.strictEqual(row.external_updated_at, '2026-09-21 08:00:00.000000');

        // Confirm no duplicate row was created for this order under any key form.
        const allRows = await new Promise((resolve, reject) => {
            db.all("SELECT reference_id FROM salla_imported_orders WHERE reference_id = ? OR reference_id LIKE ?", [refId, refId + '_%'], (err, rows) => err ? reject(err) : resolve(rows));
        });
        assert.strictEqual(allRows.length, 1, 'no duplicate row should be created when reconciling an existing order');
    });

    it('does not downgrade a status that is already newer locally than what a stale API response reports', async () => {
        const refId = '950002';
        // Local state is already fresher (e.g. a webhook for a later status already landed) than what
        // this particular (slow/out-of-date) API response describes.
        await insertLegacyRow(refId, { statusSlug: 'completed', statusName: 'تم التنفيذ', externalUpdatedAt: '2026-09-21 10:00:00.000000' });

        axios.get = async (url) => {
            if (String(url).includes('per_page')) {
                return {
                    data: {
                        data: [{
                            id: 800000002,
                            reference_id: Number(refId),
                            date: { date: '2026-09-10 09:00:00.000000' },
                            updated_at: { date: '2026-09-21 09:00:00.000000' }, // older than local
                            status: { slug: 'under_review', name: 'بإنتظار المراجعة' },
                            payment_method: 'mada',
                            amounts: { total: { amount: 40, currency: 'SAR' } },
                            customer: { first_name: 'عميل', last_name: 'قديم', mobile: '0511111111' },
                            items: [{ name: 'منتج قديم', quantity: 1 }]
                        }],
                        pagination: { links: {} }
                    }
                };
            }
            throw new Error('Unexpected axios.get call: ' + url);
        };

        await SallaService.syncOrders(true, false);

        const row = await getOrderRow(refId);
        assert.strictEqual(row.status_slug, 'completed', 'a stale API snapshot must not downgrade an already-newer local status');
    });
});
