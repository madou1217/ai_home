'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { isDeepStrictEqual } = require('node:util');
const { ChatRuntimeError } = require('./contracts');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ROLLOUT = /^rollout-.*-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/;
const HEADER_LIMIT = 1024 * 1024;

function codexForkSource({ sessionId, commandId }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof commandId !== 'string' || !commandId) {
    throw new ChatRuntimeError('codex_fork_identity_required', 422);
  }
  return `aih-fork-${hash(JSON.stringify([sessionId, commandId]))}`;
}

// The legacy read API drops threadSource, and list may omit a fork that has
// not received a user turn yet. Its session_meta is persisted at creation.
// This is a read-only receipt adapter, not another conversation store. Never
// use a missing receipt as proof that an unacknowledged fork did not execute.
async function findCodexForkReceipt(options) {
  const receipt = await locateReceipt(options);
  if (!receipt) return null;
  const { rolloutPath: _privatePath, ...identity } = receipt;
  return identity;
}

async function locateReceipt({ codexHome, runtimeHomeHash, sourceThreadId, threadSource }) {
  if (!UUID.test(sourceThreadId) || !/^aih-fork-[a-f0-9]{64}$/.test(threadSource)) {
    throw new ChatRuntimeError('codex_fork_identity_required', 422);
  }
  const home = await fs.promises.realpath(codexHome);
  const identityPath = process.platform === 'win32' ? home.toLowerCase() : home;
  if (hash(identityPath) !== runtimeHomeHash) {
    throw new ChatRuntimeError('codex_fork_runtime_home_mismatch', 409);
  }
  const receipts = new Map();
  for (const root of ['sessions', 'archived_sessions']) {
    await visit(path.join(home, root), 0);
  }
  if (receipts.size > 1) throw new ChatRuntimeError('codex_fork_receipt_ambiguous', 409);
  return receipts.values().next().value || null;

  async function visit(directory, depth) {
    let stat;
    try { stat = await fs.promises.lstat(directory); }
    catch (error) { if (error.code === 'ENOENT' && depth === 0) return; throw receiptUnavailable(); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw receiptUnavailable();
    const real = await fs.promises.realpath(directory);
    if (!isWithin(home, real)) throw receiptUnavailable();
    for await (const entry of await fs.promises.opendir(directory)) {
      const file = path.join(directory, entry.name);
      const match = ROLLOUT.exec(entry.name);
      if (match) {
        if (!entry.isFile()) throw receiptUnavailable();
        const meta = await readMetadata(file);
        if (meta.thread_source !== threadSource) continue;
        if (meta.id !== match[1] || !UUID.test(meta.id) || meta.id === sourceThreadId
          || meta.forked_from_id !== sourceThreadId) {
          throw new ChatRuntimeError('codex_fork_receipt_identity_conflict', 409);
        }
        // Even two paths for the same native id can contain different suffixes.
        // An archive move observed twice must be rescanned, never chosen by order.
        if (receipts.has(meta.id)) throw new ChatRuntimeError('codex_fork_receipt_ambiguous', 409);
        receipts.set(meta.id, { threadId: meta.id, sourceThreadId, threadSource, rolloutPath: file });
      } else if (depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        await visit(file, depth + 1);
      }
    }
  }
}

// Positive evidence only: a contiguous, exact raw suffix confirms an injection.
// Absence or a partial write cannot authorize retrying an unacknowledged RPC.
async function readCodexInjectionReceipt(options) {
  const { threadId, items } = options;
  if (!Array.isArray(items) || !items.length || items.some((item) => !item || typeof item !== 'object')) {
    throw new ChatRuntimeError('codex_injection_identity_required', 422);
  }
  const expected = new Map(items.map((item) => [item.id, item]));
  if (expected.size !== items.length
    || [...expected.keys()].some((id) => typeof id !== 'string' || !id)) {
    throw new ChatRuntimeError('codex_injection_identity_required', 422);
  }
  const receipt = await locateReceipt(options);
  if (!receipt || receipt.threadId !== threadId) throw receiptUnavailable();
  let handle;
  let lines;
  let matched = 0;
  let first = true;
  let interrupted = false;
  try {
    handle = await fs.promises.open(receipt.rolloutPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) throw receiptUnavailable();
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, stat.size - 1);
    if (tail[0] !== 10) throw receiptUnavailable();
    lines = readline.createInterface({ input: handle.createReadStream({ autoClose: false, end: stat.size - 1 }), crlfDelay: Infinity });
    for await (const line of lines) {
      const record = JSON.parse(line);
      if (first) {
        first = false;
        if (record.type !== 'session_meta' || record.payload.id !== threadId
          || record.payload.thread_source !== options.threadSource
          || record.payload.forked_from_id !== options.sourceThreadId) throw receiptUnavailable();
        continue;
      }
      if (record.type === 'response_item') {
        if (!expected.has(record.payload.id)) {
          if (matched) interrupted = true;
          continue;
        }
        if (interrupted || !isDeepStrictEqual(record.payload, items[matched])) {
          throw new ChatRuntimeError('codex_injection_receipt_conflict', 409);
        }
        matched += 1;
      } else if (matched && (record.type === 'compacted'
        || (record.type === 'event_msg' && ['task_started', 'thread_rolled_back'].includes(record.payload?.type)))) {
        interrupted = true;
      }
    }
    if (interrupted) throw new ChatRuntimeError('codex_injection_receipt_conflict', 409);
    return matched === items.length ? 'complete' : matched ? 'incomplete' : 'absent';
  } catch (error) {
    if (error.code === 'codex_injection_receipt_conflict') throw error;
    throw receiptUnavailable();
  } finally {
    lines?.close();
    await handle?.close();
  }
}

async function readMetadata(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!(await handle.stat()).isFile()) throw receiptUnavailable();
    const chunks = [];
    let offset = 0;
    while (offset < HEADER_LIMIT) {
      const chunk = Buffer.alloc(Math.min(8192, HEADER_LIMIT - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      const end = chunk.subarray(0, bytesRead).indexOf(10);
      chunks.push(chunk.subarray(0, end < 0 ? bytesRead : end));
      if (end >= 0) {
        const header = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (header.type !== 'session_meta' || !header.payload || typeof header.payload !== 'object') {
          throw receiptUnavailable();
        }
        return header.payload;
      }
      offset += bytesRead;
    }
    throw receiptUnavailable();
  } catch (_error) {
    // Native metadata can contain private instructions. Keep it out of errors.
    throw receiptUnavailable();
  } finally {
    await handle?.close();
  }
}

function isWithin(root, child) {
  const relative = path.relative(root, child);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function receiptUnavailable() { return new ChatRuntimeError('codex_fork_receipt_unavailable', 409); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

module.exports = { codexForkSource, findCodexForkReceipt, readCodexInjectionReceipt };
