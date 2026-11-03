'use strict';

const { isAccountRef } = require('../account/public-account-ref');

// Late writer evidence may fill an empty attribution, never move an existing
// bill or change its tokens. Event + native session + timestamp must all match.
function reconcileZcodeUsageOwners(db, records) {
  const statement = db.prepare(`
    UPDATE model_usage_records SET account_ref = ?
    WHERE event_key = ? AND provider = 'zcode' AND source_kind = 'session_db'
      AND account_ref = '' AND session_id = ? AND timestamp_ms = ?
  `);
  let changed = 0;
  for (const record of records) {
    if (!isAccountRef(record.accountRef) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(record.usageId)
      || !record.sessionId || !(record.timestampMs > 0)) throw new Error('zcode_usage_owner_scope_invalid');
    changed += Number(statement.run(record.accountRef, `zcode:model_usage:${record.usageId}`,
      record.sessionId, record.timestampMs).changes) || 0;
  }
  return changed;
}

module.exports = { reconcileZcodeUsageOwners };
