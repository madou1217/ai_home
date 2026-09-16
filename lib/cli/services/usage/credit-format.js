'use strict';

const { USAGE_SNAPSHOT_KINDS } = require('../../../account/usage-remaining');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? Number(value.toFixed(4)).toString() : 'unknown';
const label = value => String(value || '').replace(/[\x00-\x1f\x7f\x1b]/g, '').slice(0, 80);

function formatCreditUsageLines(snapshot) {
  if (!snapshot || snapshot.kind !== USAGE_SNAPSHOT_KINDS.codebuddy || !Array.isArray(snapshot.entries)) return null;
  return snapshot.entries.map(entry => {
    const percent = finite(entry.remainingPct) ? `${entry.remainingPct.toFixed(2)}%` : 'unknown';
    return `${entry.category === 'detail' ? '  ' : ''}${label(entry.bucket) || 'credits'}: ${number(entry.remainingUnits)}/${number(entry.totalUnits)} ${label(entry.unitType) || 'credits'} remaining (${percent})`;
  });
}
module.exports = { formatCreditUsageLines };
