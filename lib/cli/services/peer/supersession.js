'use strict';

const { sameSender, sameParty } = require('./target-gate');

// Supersedes is durable intent; AppliedAt follows the old record's cancel write.
// The store calls this only inside the shared records lock, before dispatch.
function createSupersessionReconciler({ findMessage, listPending, writeRecord, now }) {
  function reconcile(record, directory = 'pending') {
    if (!record.supersedes || Number(record.supersedesAppliedAt) > 0) return { changed: false };
    if (record.notificationState === 'manual' && String(record.waitingReason || '').startsWith('supersedes_')) return { changed: false };
    if (record.receiptError) return { reason: 'read_receipt_unavailable' };
    if (record.state === 'read' || Number(record.readAt) > 0 || Number(record.deliveredAt) > 0) return { changed: false };
    const id = String(record.supersedes);
    const found = findMessage(id);
    const previous = found.record;
    // Cannot unsend an active original. The target's sibling claim fence remains.
    if (previous && found.directory === 'inflight') return { reason: 'supersedes_inflight' };
    let reason = '';
    if (!previous || previous.id !== id) reason = 'supersedes_unavailable';
    else if (id === record.id) reason = 'supersedes_identity_mismatch';
    else if (previous.receiptError) return { reason: 'read_receipt_unavailable' };
    else if (!sameSender(previous.from, record.from) || !sameParty(previous.to, record.to)
      || previous.state === 'delivered' || previous.state === 'read' || Number(previous.readAt) > 0 || Number(previous.deliveredAt) > 0) {
      reason = 'supersedes_identity_or_history_conflict';
    }
    if (reason) {
      writeRecord(directory, { ...record, notificationState: 'manual', waitingReason: reason, nextAttemptAt: 0 });
      return { reason };
    }
    if (!(Number(previous.canceledAt) > 0)) {
      writeRecord(found.directory, { ...previous, canceledAt: now(), notificationState: 'canceled',
        waitingReason: 'superseded', supersededBy: record.id });
    }
    writeRecord(directory, { ...record, supersedesAppliedAt: now() });
    return { changed: true };
  }

  function reconcilePending(to) {
    const summary = { reconciled: 0, blocked: [] };
    for (const candidate of listPending()) {
      const current = findMessage(candidate.id);
      if (!current.record || current.directory !== 'pending') continue;
      const record = current.record;
      if (!record.supersedes || to && !sameParty(record.to, to)) continue;
      const result = reconcile(record);
      if (result.changed) summary.reconciled += 1;
      if (result.reason) summary.blocked.push({ id: record.id, reason: result.reason });
    }
    return summary;
  }

  return { reconcile, reconcilePending };
}

module.exports = { createSupersessionReconciler };
