// Normalized Plus-account/slot inventory (plus_accounts / plus_account_slots — Gap 1, Option C).
// Entirely separate from ps_plus_accounts and game_accounts/game_slots: nothing here reads or writes
// either of those tables, so existing delivery behavior cannot regress.
//
// Modeling note (documented, not hidden): one Plus account serves BOTH platforms at once (matching how
// the live ps_plus_accounts table already works today — one row, ps5_1/ps5_2/ps4 columns together).
// plus_accounts.family_id therefore references the PS5-platform family row as the commercial tier's
// canonical representative (e.g. family_code=PS5_BASIC stands in for "بلس أساسي" as a whole); the
// account's actual multi-platform slot composition is governed by account_composition_config, not by
// family_id alone. Sales/revenue reporting (salla_family_integration.service.js) still uses the exact
// platform-specific family_id (PS5_BASIC vs PS4_BASIC) for accurate per-platform revenue — this module
// only concerns itself with delivery-eligible account inventory.
const db = require('../config/db');

const SLOT_STATES = ['AVAILABLE', 'RESERVED', 'DELIVERED', 'BLOCKED', 'EXPIRED'];
const DEFAULT_COMPOSITION = { PS5: 2, PS4: 2 }; // the frozen business contract's standard, used only when account_composition_config has no explicit row for this family+duration

function dbAllAsync(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []))); }
function dbGetAsync(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))); }
function dbRunAsync(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })); }

// Gap 1: composition is read from account_composition_config (data-driven), never hard-coded into a
// route/component. Falls back to the documented 2 PS5 + 2 PS4 default only when nothing is configured,
// and the fallback is reported explicitly (used_default: true) rather than silently blended with real config.
async function getAccountComposition(familyId, durationCode) {
    const rows = await dbAllAsync(
        `SELECT slot_type, slot_count FROM account_composition_config WHERE family_id = ? AND duration_code = ?`,
        [familyId, durationCode]
    );
    if (rows.length > 0) {
        const composition = {};
        rows.forEach(r => { composition[r.slot_type] = r.slot_count; });
        return { composition, used_default: false };
    }
    return { composition: { ...DEFAULT_COMPOSITION }, used_default: true };
}

// Gap 2: family_id + duration_code are required (NOT NULL at the schema level too) — no account can be
// created without an explicit commercial link, no inference from a display name.
async function createAccount({ email, password, familyId, durationCode, createdBy }) {
    if (!familyId || !durationCode) {
        const err = new Error('family_id و duration_code إلزاميان لإنشاء حساب بلس جديد.');
        err.status = 400;
        throw err;
    }
    const family = await dbGetAsync(`SELECT id FROM product_families WHERE id = ?`, [familyId]);
    if (!family) {
        const err = new Error('عائلة المنتج غير موجودة.');
        err.status = 404;
        throw err;
    }

    const result = await dbRunAsync(
        `INSERT INTO plus_accounts (email, password, family_id, duration_code, created_by, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [email, password, familyId, durationCode, createdBy || null]
    );
    const accountId = result.lastID;

    const { composition, used_default } = await getAccountComposition(familyId, durationCode);
    const slots = [];
    for (const slotType of Object.keys(composition)) {
        for (let i = 1; i <= composition[slotType]; i++) {
            await dbRunAsync(
                `INSERT INTO plus_account_slots (account_id, slot_type, slot_index, status, created_at, updated_at) VALUES (?, ?, ?, 'AVAILABLE', datetime('now'), datetime('now'))`,
                [accountId, slotType, i]
            );
            slots.push({ slot_type: slotType, slot_index: i });
        }
    }

    return { account_id: accountId, family_id: familyId, duration_code: durationCode, slots_created: slots, used_default_composition: used_default };
}

// Gap 5 (#4/#5): finds ONE compatible AVAILABLE slot for the given family+duration+platform — a
// customer can never receive a slot from the wrong family, duration, or platform pool, because the
// query itself filters on all three; there is no fallback that relaxes any of them.
async function findAvailableSlot(familyId, durationCode, slotType) {
    return dbGetAsync(`
        SELECT s.* FROM plus_account_slots s
        JOIN plus_accounts a ON a.id = s.account_id
        WHERE a.family_id = ? AND a.duration_code = ? AND s.slot_type = ? AND s.status = 'AVAILABLE' AND a.is_archived = 0
        ORDER BY s.id ASC LIMIT 1
    `, [familyId, durationCode, slotType]);
}

// Gap 4: DELIVERY is a separate event from SALE — this function only ever touches plus_account_slots,
// never salla_order_items/product_stock_movements, so assigning a slot can never inflate a sale count.
async function deliverSlot({ familyId, durationCode, slotType, orderReferenceId, customerPhone, deliveredBy }) {
    const slot = await findAvailableSlot(familyId, durationCode, slotType);
    if (!slot) {
        return { success: false, error: 'NO_COMPATIBLE_SLOT_AVAILABLE' };
    }
    const result = await dbRunAsync(
        `UPDATE plus_account_slots SET status = 'DELIVERED', order_reference_id = ?, customer_phone = ?, delivered_by = ?, delivered_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = 'AVAILABLE'`,
        [orderReferenceId, customerPhone || null, deliveredBy || null, slot.id]
    );
    if (result.changes === 0) {
        // Race: another request took it between the SELECT and UPDATE — never double-assign.
        return { success: false, error: 'SLOT_TAKEN_CONCURRENTLY' };
    }
    return { success: true, slot_id: slot.id, account_id: slot.account_id, slot_type: slot.slot_type, slot_index: slot.slot_index };
}

async function reserveSlot({ familyId, durationCode, slotType, orderReferenceId }) {
    const slot = await findAvailableSlot(familyId, durationCode, slotType);
    if (!slot) return { success: false, error: 'NO_COMPATIBLE_SLOT_AVAILABLE' };
    const result = await dbRunAsync(
        `UPDATE plus_account_slots SET status = 'RESERVED', order_reference_id = ?, reserved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'AVAILABLE'`,
        [orderReferenceId || null, slot.id]
    );
    if (result.changes === 0) return { success: false, error: 'SLOT_TAKEN_CONCURRENTLY' };
    return { success: true, slot_id: slot.id };
}

async function releaseSlot(slotId) {
    return dbRunAsync(
        `UPDATE plus_account_slots SET status = 'AVAILABLE', order_reference_id = NULL, customer_phone = NULL, reserved_at = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('RESERVED','BLOCKED')`,
        [slotId]
    );
}

async function blockSlot(slotId, reason) {
    return dbRunAsync(`UPDATE plus_account_slots SET status = 'BLOCKED', blocked_reason = ?, updated_at = datetime('now') WHERE id = ?`, [reason || null, slotId]);
}

async function expireSlot(slotId) {
    return dbRunAsync(`UPDATE plus_account_slots SET status = 'EXPIRED', expires_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [slotId]);
}

// Gap 13: real counts only, from plus_accounts/plus_account_slots — nothing estimated.
async function getInventoryDashboard(familyId, durationCode) {
    const accountRows = await dbAllAsync(
        `SELECT status, COUNT(*) as c FROM plus_accounts WHERE family_id = ? AND duration_code = ? AND is_archived = 0 GROUP BY status`,
        [familyId, durationCode]
    );
    const totalAccounts = await dbGetAsync(
        `SELECT COUNT(*) as c FROM plus_accounts WHERE family_id = ? AND duration_code = ? AND is_archived = 0`, [familyId, durationCode]
    );

    const slotRows = await dbAllAsync(`
        SELECT s.slot_type, s.status, COUNT(*) as c
        FROM plus_account_slots s JOIN plus_accounts a ON a.id = s.account_id
        WHERE a.family_id = ? AND a.duration_code = ? AND a.is_archived = 0
        GROUP BY s.slot_type, s.status
    `, [familyId, durationCode]);

    const slots = { PS5: { total: 0, available: 0, reserved: 0, delivered: 0, blocked: 0, expired: 0 }, PS4: { total: 0, available: 0, reserved: 0, delivered: 0, blocked: 0, expired: 0 } };
    slotRows.forEach(r => {
        if (!slots[r.slot_type]) return;
        slots[r.slot_type].total += r.c;
        slots[r.slot_type][r.status.toLowerCase()] = r.c;
    });

    return {
        accounts: { total: totalAccounts.c || 0 },
        slots
    };
}

// Gap 11: classifies EXISTING legacy ps_plus_accounts rows for a future backfill decision — read-only,
// never writes, never guesses a family/duration link without a real text match against product_families.
async function classifyLegacyAccountBackfillCandidates() {
    const legacyAccounts = await dbAllAsync(`SELECT id, email, plus_type, plus_duration FROM ps_plus_accounts WHERE family_id IS NULL`);
    const families = await dbAllAsync(`SELECT id, family_name, family_code, tier FROM product_families`);

    const safelyMatchable = [];
    const needsReview = [];
    const notRecoverable = [];

    for (const acc of legacyAccounts) {
        const typeText = (acc.plus_type || '').trim();
        if (!typeText) {
            notRecoverable.push({ id: acc.id, reason: 'NO_PLUS_TYPE_TEXT' });
            continue;
        }
        const matches = families.filter(f => typeText.includes(f.tier) || f.family_name.includes(typeText) || typeText.includes(f.family_name));
        if (matches.length === 1) {
            safelyMatchable.push({ id: acc.id, plus_type: typeText, plus_duration: acc.plus_duration, matched_family_id: matches[0].id, matched_family_name: matches[0].family_name });
        } else if (matches.length > 1) {
            needsReview.push({ id: acc.id, plus_type: typeText, candidate_family_ids: matches.map(m => m.id), reason: 'AMBIGUOUS_TEXT_MATCH' });
        } else {
            needsReview.push({ id: acc.id, plus_type: typeText, reason: 'NO_TEXT_MATCH' });
        }
    }

    return {
        total_legacy_unlinked: legacyAccounts.length,
        safely_matchable: safelyMatchable,
        needs_review: needsReview,
        not_recoverable: notRecoverable
    };
}

module.exports = {
    SLOT_STATES,
    DEFAULT_COMPOSITION,
    getAccountComposition,
    createAccount,
    findAvailableSlot,
    deliverSlot,
    reserveSlot,
    releaseSlot,
    blockSlot,
    expireSlot,
    getInventoryDashboard,
    classifyLegacyAccountBackfillCandidates
};
