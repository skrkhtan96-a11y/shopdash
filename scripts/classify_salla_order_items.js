/*
 * Read-only classification of salla_imported_orders rows into three categories, per Phase 4 of the
 * "Salla Product Sales & Date Filter Accuracy" audit:
 *
 *   A. Exact item-level recoverable  — the row's own value is already an exact per-item figure and
 *      needs no further work (a genuinely single-item order, whichever key format wrote it).
 *   B. Recoverable only by refetching from Salla — the row (or its sibling rows for the same base
 *      order) represents a real multi-item order whose exact per-item price/quantity split is not
 *      preserved locally, but Salla's own API still has it (SallaOrderItemsService.refetchOrderItemsBySallaId).
 *   C. Irrecoverable from local DB alone — cannot be determined statically; only emerges when a
 *      category-B refetch is actually attempted and Salla no longer has the order. This script does
 *      NOT attempt any refetch, so it reports 0 for C by construction and says so explicitly.
 *
 * This script only ever runs SELECT statements. It does not write to the database, does not call the
 * Salla API, and is safe to run against any environment's database.db to get a classification report
 * before deciding whether/how to run the (separate, not-yet-built) mass-reconciliation job.
 *
 * Usage:
 *   node scripts/classify_salla_order_items.js [path/to/database.db]
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = process.argv[2] || path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error(`Failed to open ${dbPath} read-only:`, err.message);
        process.exit(1);
    }
});

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function baseRefExpr(col = 'reference_id') {
    return `CASE WHEN ${col} LIKE '%\\_%' ESCAPE '\\' THEN substr(${col}, 1, instr(${col}, '_') - 1) ELSE ${col} END`;
}

async function main() {
    const totalRows = (await all(`SELECT COUNT(*) as c FROM salla_imported_orders`))[0].c;
    const distinctOrders = (await all(`SELECT COUNT(DISTINCT ${baseRefExpr()}) as c FROM salla_imported_orders`))[0].c;

    // Category A candidates: base orders with exactly one row (nothing merged, nothing split further).
    const singleRowOrders = await all(`
        SELECT ${baseRefExpr()} as base_ref, COUNT(*) as row_count
        FROM salla_imported_orders
        GROUP BY base_ref
        HAVING row_count = 1
    `);

    // Category B candidates: base orders with 2+ rows (a real multi-item split via webhook, where each
    // row's amount was an equal split, not an exact per-item price), OR a single plain-key row whose
    // product_name shows an explicit merge marker (" + ").
    const multiRowOrders = await all(`
        SELECT ${baseRefExpr()} as base_ref, COUNT(*) as row_count
        FROM salla_imported_orders
        GROUP BY base_ref
        HAVING row_count > 1
    `);
    const explicitMergedRows = await all(`
        SELECT reference_id, product_name, amount, quantity
        FROM salla_imported_orders
        WHERE product_name LIKE '% + %'
    `);

    const categoryA = singleRowOrders.length;
    const categoryBFromSplits = multiRowOrders.length;
    const categoryBExplicitMerge = explicitMergedRows.length;

    console.log('=== salla_order_items historical classification (READ-ONLY) ===');
    console.log(`Database: ${dbPath}`);
    console.log(`Total rows in salla_imported_orders: ${totalRows}`);
    console.log(`Distinct real orders (base reference_id): ${distinctOrders}`);
    console.log(`Row-level duplication factor: ${distinctOrders > 0 ? (totalRows / distinctOrders).toFixed(2) : 'n/a'}x`);
    console.log('');
    console.log(`Category A (exact, single-row orders): ${categoryA} base orders`);
    console.log(`Category B — multi-row orders needing refetch for exact per-item revenue: ${categoryBFromSplits} base orders`);
    console.log(`Category B — explicit "Product + Product" merged rows (identity AND revenue both lost): ${categoryBExplicitMerge} rows`);
    console.log('Category C (irrecoverable): 0 by construction — this script never attempts a refetch;');
    console.log('  category C can only be determined by actually running the refetch on category B and observing failures.');
    console.log('');
    console.log('This script performed 0 writes and made 0 network calls.');

    if (explicitMergedRows.length > 0) {
        console.log('');
        console.log('Sample of explicit merged rows (up to 5):');
        explicitMergedRows.slice(0, 5).forEach(r => {
            console.log(`  ${r.reference_id} | ${r.product_name} | amount=${r.amount} qty=${r.quantity}`);
        });
    }

    db.close();
}

main().catch((err) => {
    console.error('Classification failed:', err.message);
    db.close();
    process.exit(1);
});
