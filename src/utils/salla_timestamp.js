// Extracts Salla's own "order last updated" timestamp as a comparable string.
// Salla sends it as {date: "YYYY-MM-DD HH:MM:SS.ffffff", timezone, timezone_type} — that "date" string
// is already zero-padded/lexicographically sortable, so we keep it as-is rather than reparsing it (avoids
// timezone-conversion ambiguity; we only ever compare timestamps from the same store/timezone to each other).
// Used to detect out-of-order webhook delivery and to drive incremental reconciliation in the polling sync,
// instead of relying on our own local receipt time (which says nothing about the order's actual state on Salla's side).
function extractSallaTimestamp(val) {
    if (!val) return null;
    if (typeof val === 'object' && typeof val.date === 'string') return val.date;
    if (typeof val === 'string') return val;
    if (typeof val === 'number') return new Date(val * 1000).toISOString();
    return null;
}

module.exports = { extractSallaTimestamp };
