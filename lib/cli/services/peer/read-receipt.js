'use strict';

const nodePath = require('node:path');
const { writeFileAtomic } = require('../../../runtime/atomic-file-write');
const { ensurePrivateDirectory } = require('../../../runtime/durable-directory');

// An ACK outlives delivery snapshots. Invalid sidecars are never absent ACKs:
// callers expose the error for this message and must not deliver it.
function readReceiptAt(fs, root, id) {
  const file = nodePath.join(root, 'receipts', `${id}.json`);
  let item;
  try { item = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw receiptError(id, file, error);
  }
  try {
    if (!item.isFile() || item.isSymbolicLink()) throw new Error('receipt is not a regular file');
    const raw = fs.readFileSync(file, 'utf8');
    const receipt = JSON.parse(raw);
    if (!receipt || receipt.v !== 1 || receipt.id !== id
      || !Number.isSafeInteger(receipt.readAt) || receipt.readAt <= 0) {
      throw new Error('expected v=1, matching id and positive readAt');
    }
    return receipt.readAt;
  } catch (error) { throw receiptError(id, file, error); }
}

function receiptError(id, file, cause) {
  const error = new Error(`peer_read_receipt_invalid: id=${id} path=${file}: ${cause.message}`);
  error.code = 'peer_read_receipt_invalid';
  return error;
}

function applyReadReceipt(fs, root, record) {
  const receiptAt = readReceiptAt(fs, root, record.id);
  const next = { ...record };
  delete next.receiptError;
  const readAt = Number(record.readAt) > 0 ? Number(record.readAt) : receiptAt;
  if (readAt <= 0 && record.state !== 'read') return next;
  Object.assign(next, { state: 'read', readAt, nextAttemptAt: 0 });
  delete next.error;
  return next;
}

function projectReadReceipt(fs, root, record) {
  try { return applyReadReceipt(fs, root, record); }
  catch (error) {
    return { ...record, receiptError: error.message,
      error: [record.error, error.message].filter(Boolean).join('; ') };
  }
}

// All ACK/message writers hold claim-lease.js's cross-process mutation lock.
function writeReadReceipt(fs, root, id, readAt) {
  ensurePrivateDirectory(fs, nodePath.join(root, 'receipts'));
  const existing = readReceiptAt(fs, root, id);
  if (existing) return existing;
  if (!Number.isSafeInteger(readAt) || readAt <= 0) throw new Error(`peer_read_at_invalid: id=${id}`);
  writeFileAtomic(fs, nodePath.join(root, 'receipts', `${id}.json`),
    `${JSON.stringify({ v: 1, id, readAt })}\n`, { encoding: 'utf8', mode: 0o600 });
  return readAt;
}

module.exports = { applyReadReceipt, projectReadReceipt, writeReadReceipt };
