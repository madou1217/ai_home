'use strict';

// aih peer 的**持久收件箱**。
//
// 为什么需要它：`aih peer send` 以前是「一次性发射」——native 的 msg_id 不落盘，
// inject 连 id 都没有。对方当时在跑回合、没起、或者 pane 正在重绘，消息就永久丢了，
// 而且收到消息的会话不知道「这条是谁发的、怎么回」。
//
// 存储形状（`<aiHome>/run/peer/`）：
//
//   pending/<id>.json    待投递
//   inflight/<id>.json   已被某个投递者抢到，正在投
//   archive/<id>.json    已投递 / 已读 / 失败
//
// Go / Node 共用短事务锁串行化 claim、recover、settle 和 ACK 的状态迁移。
// 每次 claim 写入新 token / generation / claimedAt；旧 owner 不能覆盖新代次。
// 崩溃留下的 inflight 以 claimedAt 判定过期，不使用 pending 的旧 mtime。
//
// 记录里 `to.delivery` 保存重投所需的全部信息（cliName/runtimeScope/sessionName），
// 这样补投时不必重新全量扫描会话列表。

const crypto = require('node:crypto');
const nodePath = require('node:path');

const { writeFileAtomic } = require('../../../runtime/atomic-file-write');
const { ensurePrivateDirectory } = require('../../../runtime/durable-directory');
const { resolveAihRunPath } = require('../../../runtime/aih-storage-layout');
const { applyReadReceipt, projectReadReceipt, writeReadReceipt } = require('./read-receipt');
const { acquireRecordLock, sameClaim } = require('./claim-lease');
const { createTargetGates, sameParty, sameSender } = require('./target-gate');
const { createSupersessionReconciler } = require('./supersession');
const { messageMetadata, notificationStatus, historicalAttempts, failureBudgetReason,
  WAIT_REASONS, backoffFor } = require('./delivery-policy');

const RECORD_VERSION = 1;
const MESSAGE_PREFIX = 'pm-';
// 前缀匹配的最短长度：太短会同时命中一堆消息，替用户猜反而更糟。
const MIN_PREFIX_LENGTH = 6;
// inflight 的孤儿判定：投递本身最长也就几秒（tmux send-keys / 一次 HTTP），
// 超过这个时间还挂在 inflight，说明投递进程已经死了。
const DEFAULT_INFLIGHT_STALE_MS = 60_000;
// `attempts` 只留最近的真实传输明细；历史旧记录也可能含忙碌探测。
// `attemptCount` 保留历史总数，v2 的真实失败预算由 delivery-policy 与共享 gate 单独计算。
const DEFAULT_MAX_ATTEMPT_LOG = 20;

const STATE_DIRECTORIES = Object.freeze({
  pending: 'pending',
  inflight: 'inflight',
  delivered: 'archive',
  read: 'archive',
  failed: 'archive'
});

function normalizeId(value) {
  return String(value == null ? '' : value).trim().replace(/^#/, '');
}

function newMessageId() {
  return `${MESSAGE_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

function shortMessageId(id) {
  return String(id || '').slice(0, MESSAGE_PREFIX.length + 8);
}

/**
 * 这条消息总共试过几次。
 *
 * 老记录没有 `attemptCount`（截断上线前写的），退回 `attempts.length`——那时候两者相等。
 * **不要**直接读 `attempts.length` 来算退避：数组被截断过，读长度会让退避从 3s 重新开始。
 */
function attemptCountOf(record) {
  return historicalAttempts(record);
}

function describeAddress(value) {
  const source = value && typeof value === 'object' ? value : {};
  const delivery = source.delivery && typeof source.delivery === 'object'
    ? Object.fromEntries(Object.entries(source.delivery)
      .map(([key, item]) => [key, String(item == null ? '' : item).trim()])
      .filter(([, item]) => item))
    : null;
  return {
    channel: String(source.channel || '').trim(),
    provider: String(source.provider || '').trim(),
    name: String(source.name || '').trim(),
    address: String(source.address || '').trim(),
    sessionId: String(source.sessionId || '').trim(),
    ...(delivery && Object.keys(delivery).length > 0 ? { delivery } : {})
  };
}

function createPeerStore(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const inflightStaleMs = Number.isFinite(Number(options.inflightStaleMs))
    ? Math.max(1_000, Number(options.inflightStaleMs))
    : DEFAULT_INFLIGHT_STALE_MS;
  const maxAttemptLog = Number.isFinite(Number(options.maxAttemptLog))
    ? Math.max(1, Math.floor(Number(options.maxAttemptLog)))
    : DEFAULT_MAX_ATTEMPT_LOG;

  /** 仅追加真实传输；保留历史总数，忙碌/草稿/UNKNOWN 不进入此函数。 */
  function appendAttempt(record, entry) {
    const previous = Array.isArray(record && record.attempts) ? record.attempts : [];
    return {
      attemptCount: attemptCountOf(record) + 1,
      attempts: [...previous, entry].slice(-maxAttemptLog)
    };
  }

  const root = aiHomeDir ? resolveAihRunPath(aiHomeDir, 'peer') : '';
  const gates = createTargetGates(fs, root);
  const supersession = createSupersessionReconciler({ findMessage,
    listPending: () => listDirectory('pending'), writeRecord, now });

  function directoryFor(name) {
    return nodePath.join(root, name);
  }

  function ensureLayout() {
    if (!root) return false;
    try {
      // `run/` 在正常安装里一定存在，但测试/首次运行可能没有：先递归建出父级，
      // 再由 ensurePrivateDirectory 校验「是目录且不是符号链接」。
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      ensurePrivateDirectory(fs, root);
      for (const name of ['pending', 'inflight', 'archive', 'receipts', 'targets']) {
        ensurePrivateDirectory(fs, nodePath.join(root, name));
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  function fileIn(dirName, id) {
    if (!/^pm-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(id))) throw new Error('invalid_message_id');
    return nodePath.join(directoryFor(dirName), `${id}.json`);
  }

  function readStoredRecord(dirName, id) {
    let raw;
    try {
      raw = fs.readFileSync(fileIn(dirName, id), 'utf8');
    } catch (_error) {
      return null;
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch (_error) {
      return null;
    }
    if (!record || typeof record !== 'object' || record.id && record.id !== id) return null;
    // 目录才是状态的真相：文件里的 state 可能是迁移前写下的。
    return { ...record, id: record.id || id, state: stateFromDirectory(dirName, record) };
  }

  function readRecord(dirName, id) {
    const record = readStoredRecord(dirName, id);
    return record ? projectReadReceipt(fs, root, record) : null;
  }

  function withRecordLock(operation) {
    if (!ensureLayout()) return null;
    const release = acquireRecordLock(fs, aiHomeDir);
    try { return operation(); }
    finally { release(); }
  }

  function exists(dirName, id) {
    try { fs.lstatSync(fileIn(dirName, id)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  function stateFromDirectory(dirName, record) {
    if (record.state === 'read') return 'read';
    if (dirName === 'pending' || dirName === 'inflight') return 'pending';
    const state = String(record && record.state || '').trim();
    return state === 'read' || state === 'failed' ? state : 'delivered';
  }

  function listDirectory(dirName) {
    let entries = [];
    try {
      entries = fs.readdirSync(directoryFor(dirName));
    } catch (_error) {
      return [];
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record = readRecord(dirName, entry.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    records.sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      || String(left.id).localeCompare(String(right.id)));
    return records;
  }

  /** Lock-atomic create; durable Supersedes intent is reconciled after a crash. */
  function createMessageResult(input = {}) {
    try {
      return withRecordLock(() => {
        const at = now();
        const metadata = messageMetadata(input, at);
        const from = describeAddress(input.from);
        const to = describeAddress(input.to);
        let superseded;
        if (metadata.supersedes) {
          const found = findMessage(metadata.supersedes);
          if (!found.record) return { error: found.ambiguous.length ? 'ambiguous_message' : 'message_not_found' };
          if (!sameSender(found.record.from, from) || !sameParty(found.record.to, to)) return { error: 'supersedes_identity_mismatch' };
          const invalid = mutationError(found, { from, to });
          if (invalid) return { error: invalid };
          superseded = found;
          metadata.supersedes = found.record.id;
        }
        const record = {
          v: RECORD_VERSION, id: newMessageId(), from, to,
          replyTo: normalizeId(input.replyTo), body: String(input.body == null ? '' : input.body),
          createdAt: at, state: 'pending', attempts: [], attemptCount: 0,
          nextAttemptAt: 0, deliveredAt: 0, readAt: 0, channelMessageId: '',
          ...metadata, canceledAt: 0, busySince: 0, probeCount: 0
        };
        Object.assign(record, notificationStatus(record, at));
        // Write the replacement first; lock prevents dispatch between these writes.
        writeRecord('pending', record);
        if (superseded) {
          try {
            writeRecord(superseded.directory, { ...superseded.record, canceledAt: at,
              notificationState: 'canceled', waitingReason: 'superseded', supersededBy: record.id });
            record.supersedesAppliedAt = at;
            writeRecord('pending', record);
          } catch (_error) {
            // Retain durable intent/body; every future dispatcher reconciles it.
            return { record, error: 'supersedes_reconciliation_pending' };
          }
        }
        return { record };
      }) || { error: 'store_unavailable' };
    } catch (error) { return { error: error.message || 'store_unavailable' }; }
  }

  function createMessage(input = {}) {
    return createMessageResult(input).record || null;
  }

  function writeRecord(dirName, record) {
    writeFileAtomic(fs, fileIn(dirName, record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  function targetInflight(to) {
    for (const entry of fs.readdirSync(directoryFor('inflight'))) {
      if (!entry.endsWith('.json')) continue;
      const other = readStoredRecord('inflight', entry.slice(0, -5));
      if (!other) throw new Error('inflight_record_unavailable');
      if (sameParty(to, other.to)) return true;
    }
    return false;
  }

  /** Claim and settle are fenced by the same cross-process lock/generation. */
  function claim(id) {
    const key = normalizeId(id);
    if (!key) return { record: null };
    try {
      return withRecordLock(() => {
        const stored = readStoredRecord('pending', key);
        if (!stored) return { record: null };
        let record = projectReadReceipt(fs, root, stored);
        if (record.receiptError) return { record: null, error: record.receiptError };
        if (record.state === 'read') {
          archiveReadLocked('pending', record);
          return { record: null };
        }
        const at = now();
        const gate = gates.read(record.to);
        const status = notificationStatus(record, at, gate);
        if (status.notificationState !== 'ready') {
          return { record: null, reason: status.waitingReason, notificationState: status.notificationState };
        }
        // A crash may have left a replacement before the old mail's cancel write.
        const reconciliation = supersession.reconcilePending(record.to);
        const blocked = reconciliation.blocked.find((item) => item.id === record.id);
        if (blocked) return { record: null, reason: blocked.reason };
        record = projectReadReceipt(fs, root, readStoredRecord('pending', key));
        const afterReconcile = notificationStatus(record, at, gate);
        if (afterReconcile.notificationState !== 'ready') return { record: null, reason: afterReconcile.waitingReason,
          notificationState: afterReconcile.notificationState };
        if (exists('inflight', key) || targetInflight(record.to)) {
          return { record: null, reason: 'target_inflight' };
        }
        gates.reserve(record.to, at, record.id);
        const generation = Math.max(0, Number(record.claim && record.claim.generation) || 0) + 1;
        record.claim = { token: newMessageId(), generation, claimedAt: at };
        // Stamp before rename, under the same lock recovery/settle acquire.
        writeRecord('pending', record);
        fs.renameSync(fileIn('pending', key), fileIn('inflight', key));
        return { record };
      }) || { record: null };
    } catch (error) { return { record: null, error: error.message }; }
  }

  function archiveReadLocked(directory, record) {
    const readAt = writeReadReceipt(fs, root, record.id, Number(record.readAt) || now());
    const next = applyReadReceipt(fs, root, { ...record, readAt });
    writeRecord(directory, next);
    if (directory !== 'archive') fs.renameSync(fileIn(directory, next.id), fileIn('archive', next.id));
    return next;
  }

  function settle(record, state, error, patch = {}, retryAfterMs) {
    if (!record || !record.id) return null;
    try {
      return withRecordLock(() => {
        const current = readStoredRecord('inflight', record.id);
        if (!current || !sameClaim(record.claim, current.claim)) return null;
        const acknowledged = applyReadReceipt(fs, root, current);
        const at = now();
        const waiting = state === 'pending' && patch.countAttempt !== false && WAIT_REASONS.has(String(error || ''));
        const skipped = patch.countAttempt === false || waiting;
        let next = { ...current, state,
          ...(skipped ? {} : appendAttempt(current, { at, channel: String(current.to && current.to.channel || ''),
            ok: state === 'delivered', error: String(error || '') })) };
        if (state === 'delivered') {
          next.deliveredAt = at;
          next.nextAttemptAt = 0;
          next.channelMessageId = String(patch.channelMessageId || '');
          next.notificationState = 'delivered';
          next.waitingReason = '';
          next.busySince = 0;
          next.probeCount = 0;
          gates.delivered(next.to, at, next.id);
        } else if (waiting) {
          const gate = gates.waiting(next.to, at, next.id, String(error));
          Object.assign(next, { nextAttemptAt: gate.nextProbeAt, notificationState: 'waiting',
            waitingReason: String(error), busySince: gate.busySince, probeCount: gate.probeCount });
        } else if (state === 'pending') {
          const gate = gates.read(next.to);
          const failureCount = gate.failureCount + (skipped ? 0 : 1);
          const delay = skipped ? 0 : Math.max(backoffFor(failureCount), Math.max(0, Number(retryAfterMs) || 0));
          next.nextAttemptAt = at + delay;
          next.waitingReason = String(error || 'retry_backoff');
          next.error = String(error || '');
          const budget = failureBudgetReason(next, { failureCount });
          next.notificationState = budget ? 'manual' : 'waiting';
          if (budget) next.waitingReason = budget;
          gates.write(next.to, { failureCount, nextProbeAt: next.nextAttemptAt, lastProbeAt: at,
            lastReason: next.waitingReason, lastMessageId: next.id });
        } else {
          next.error = String(error || '');
          next.notificationState = 'manual';
          next.waitingReason = String(error || 'manual');
          const gate = gates.read(next.to);
          gates.write(next.to, { failureCount: gate.failureCount + (skipped ? 0 : 1),
            lastReason: next.waitingReason, lastProbeAt: at, lastMessageId: next.id,
            nextProbeAt: at + backoffFor(gate.failureCount + 1) });
        }
        if (next.state === 'pending') Object.assign(next, notificationStatus(next, at, gates.read(next.to)));
        if (acknowledged.state === 'read') {
          next.state = 'read';
          next.notificationState = 'delivered';
          next.waitingReason = '';
          next.readAt = writeReadReceipt(fs, root, next.id, Number(acknowledged.readAt) || at);
        }
        next = applyReadReceipt(fs, root, next);
        writeRecord('inflight', next);
        fs.renameSync(fileIn('inflight', next.id), fileIn(next.state === 'pending' ? 'pending' : 'archive', next.id));
        return next;
      });
    } catch (_error) { return null; }
  }

  function settleDelivered(record, patch = {}) {
    return settle(record, 'delivered', '', patch, 0);
  }

  function settlePending(record, error, options2 = {}) {
    return settle(record, 'pending', error, options2, options2.retryAfterMs);
  }

  function settleFailed(record, error, options2 = {}) {
    return settle(record, 'failed', error, options2, 0);
  }

  // A canceled/expired/manual claimed item is returned without inventing a transmit attempt.
  function settleSkipped(record, reason) {
    if (['target_probe_unavailable', 'read_receipt_unavailable', 'target_state_unknown'].includes(reason)) {
      return settlePending(record, reason);
    }
    return settle(record, 'pending', reason, { countAttempt: false }, 0);
  }

  function mutationError(found, expected = {}) {
    const record = found.record;
    if (!expected.from || !expected.to) return 'identity_required';
    if (record.receiptError) return 'read_receipt_unavailable';
    if (record.state === 'delivered' || record.state === 'read' || Number(record.deliveredAt) > 0) return 'already_delivered';
    if (found.directory === 'inflight') return 'message_inflight';
    if (expected.from && !sameSender(expected.from, record.from)) return 'sender_mismatch';
    if (expected.to && !sameParty(expected.to, record.to)) return 'target_mismatch';
    return '';
  }

  function mutateMessage(id, action, expected = {}) {
    try {
      return withRecordLock(() => {
        const found = findMessage(id);
        if (!found.record) return { ok: false, error: found.ambiguous.length ? 'ambiguous_message' : 'message_not_found',
          candidates: found.ambiguous.map((record) => ({ id: record.id, shortId: shortMessageId(record.id) })) };
        const invalid = mutationError(found, expected);
        if (invalid) return { ok: false, error: invalid };
        const at = now();
        let record = { ...found.record };
        if (action === 'cancel') {
          record.canceledAt = record.canceledAt || at;
          record.notificationState = 'canceled';
          record.waitingReason = 'canceled';
        } else if (action === 'resume') {
          if (expected.expiresAt != null && expected.expiresAt !== '') {
            record.expiresAt = messageMetadata({ expiresAt: expected.expiresAt }, at).expiresAt;
          }
          if (Number(record.expiresAt) > 0 && Number(record.expiresAt) <= at) return { ok: false, error: 'message_expired' };
          const metadata = messageMetadata({ autoDeliverUntil: expected.autoDeliverUntil }, at);
          if (metadata.autoDeliverUntil <= at || metadata.autoDeliverUntil > at + 30 * 60 * 1000) return { ok: false, error: 'invalid_autoDeliverUntil' };
          record = { ...record, state: 'pending', canceledAt: 0, notificationState: 'ready', waitingReason: '',
            autoDeliverUntil: metadata.autoDeliverUntil, nextAttemptAt: 0, error: '' };
          const gate = gates.read(record.to);
          if (expected.resetAttempts === true) {
            // Keep the old audit log, but mark its failure budget as explicitly reset.
            record.failureResetAt = at;
            gates.write(record.to, { failureCount: 0 });
          }
          Object.assign(record, notificationStatus(record, at, { ...gate,
            ...(expected.resetAttempts === true ? { failureCount: 0 } : {}) }));
          // Resume is explicit message intent, not permission to bypass another target's gate.
        } else return { ok: false, error: 'invalid_mutation' };
        if (found.directory !== 'pending' && exists('pending', record.id)) return { ok: false, error: 'ambiguous_message' };
        writeRecord(found.directory, record);
        if (found.directory !== 'pending') fs.renameSync(fileIn(found.directory, record.id), fileIn('pending', record.id));
        return { ok: true, record };
      }) || { ok: false, error: 'store_unavailable' };
    } catch (error) { return { ok: false, error: error.message }; }
  }

  function checkDelivery(record) {
    try {
      const result = withRecordLock(() => {
        const found = findMessage(record.id);
        if (!found.record) return { ok: false, error: 'message_not_found' };
        if (found.record.receiptError) return { ok: false, error: 'read_receipt_unavailable' };
        if (found.record.state === 'read') return { ok: false, error: 'already_read', skipped: true };
        if (found.directory !== 'inflight' || !sameClaim(record.claim, found.record.claim)) return { ok: false, error: 'peer_claim_lost', skipped: true };
        const replacement = supersession.reconcile(found.record, 'inflight');
        if (replacement.reason) return { ok: false, error: replacement.reason, skipped: true };
        // Own claim reservation is not a block; semantic deadline and cancellation always are.
        const gate = gates.read(found.record.to);
        if (gate.lastMessageId !== record.id || gate.lastReason !== 'target_inflight') return { ok: false, error: 'target_inflight', skipped: true };
        const status = notificationStatus({ ...found.record, nextAttemptAt: 0 }, now(), { ...gate, nextProbeAt: 0 });
        return status.notificationState === 'ready' ? { allowed: true }
          : { ok: false, error: status.waitingReason, skipped: true };
      });
      return result && result.allowed ? null : result || { ok: false, error: 'store_unavailable', skipped: true };
    } catch (error) { return { ok: false, error: 'read_receipt_unavailable', message: error.message }; }
  }

  function markRead(id) {
    const found = findMessage(id);
    if (!found.record) return null;
    try {
      return withRecordLock(() => {
        // The directory may have changed while waiting: re-read current state
        // inside the lock instead of writing the earlier lookup snapshot.
        for (const directory of ['pending', 'inflight', 'archive']) {
          const current = readStoredRecord(directory, found.record.id);
          if (!current) continue;
          const readAt = writeReadReceipt(fs, root, current.id, Number(current.readAt) || now());
          const next = applyReadReceipt(fs, root, { ...current, readAt });
          if (directory !== 'inflight') return archiveReadLocked(directory, next);
          // The live owner alone settles inflight, merging this durable ACK.
          return next;
        }
        return null;
      });
    } catch (_error) { return null; }
  }

  function reconcileRead() {
    let count = 0;
    for (const directory of ['pending', 'archive']) {
      for (const record of listDirectory(directory)) {
        if (record.receiptError || record.state !== 'read') continue;
        try {
          const changed = withRecordLock(() => {
            const current = readStoredRecord(directory, record.id);
            if (!current) return false;
            const next = applyReadReceipt(fs, root, current);
            if (next.state !== 'read') return false;
            const readAt = writeReadReceipt(fs, root, next.id, Number(next.readAt) || now());
            if (directory === 'pending' || current.state !== 'read' || current.readAt !== readAt
              || current.nextAttemptAt || current.error) {
              archiveReadLocked(directory, { ...next, readAt });
              return true;
            }
            return false;
          });
          if (changed) count += 1;
        } catch (_error) { /* One unavailable receipt must not block other messages. */ }
      }
    }
    return count;
  }

  /**
   * 按完整 id 或 >=6 位前缀定位。多义时返回 { ambiguous }，不替用户猜。
   */
  function findMessage(idOrPrefix) {
    const key = normalizeId(idOrPrefix);
    if (!key || !/^pm-[A-Za-z0-9._-]+$/.test(key)) return { record: null, ambiguous: [] };
    if (key.length >= MESSAGE_PREFIX.length + 32) {
      const matches = [];
      for (const dirName of ['pending', 'inflight', 'archive']) {
        const record = readRecord(dirName, key);
        if (record) matches.push({ record, directory: dirName });
      }
      if (matches.length === 1) return { ...matches[0], ambiguous: [] };
      return { record: null, ambiguous: matches.map((item) => item.record) };
    }
    if (key.length < MIN_PREFIX_LENGTH) return { record: null, ambiguous: [], tooShort: true };
    const matches = [];
    for (const dirName of ['pending', 'inflight', 'archive']) {
      for (const record of listDirectory(dirName)) {
        if (String(record.id).startsWith(key)) matches.push({ record, directory: dirName });
      }
    }
    if (matches.length === 1) return { record: matches[0].record, directory: matches[0].directory, ambiguous: [] };
    if (matches.length > 1) return { record: null, ambiguous: matches.map((item) => item.record) };
    return { record: null, ambiguous: [] };
  }

  /**
   * 列表。`state` 取 pending | delivered | read | failed | open | unread | all。
   * `open` = 还没处理的（pending + 已送达未读）；`unread` 只看已送达未读。
   * `target` 按 to.sessionId / to.name / to.address / to.id 匹配（收件人视角）。
   */
  function listMessages(query = {}) {
    const state = String(query.state || 'pending').trim();
    let records;
    if (state === 'pending') records = [...listDirectory('pending'), ...listDirectory('inflight')].filter((record) => record.state === 'pending');
    else if (state === 'all' || state === 'unread' || state === 'open') {
      records = [...listDirectory('pending'), ...listDirectory('inflight'), ...listDirectory('archive')];
    } else records = [...listDirectory('pending'), ...listDirectory('inflight'), ...listDirectory('archive')];

    let filtered = records;
    if (state === 'unread') filtered = filtered.filter((record) => record.state === 'delivered');
    else if (state === 'open') {
      filtered = filtered.filter((record) => record.state === 'pending' || record.state === 'delivered');
    } else if (state !== 'all' && state !== 'pending') {
      filtered = filtered.filter((record) => record.state === state);
    }

    const wanted = String(query.target || '').trim();
    if (wanted) {
      filtered = filtered.filter((record) => {
        const to = record.to || {};
        return to.id === wanted || to.sessionId === wanted || to.name === wanted || to.address === wanted;
      });
    }
    filtered.sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      || String(left.id).localeCompare(String(right.id)));
    const limit = Number.isFinite(Number(query.limit)) && Number(query.limit) > 0
      ? Math.floor(Number(query.limit))
      : filtered.length;
    return filtered.slice(0, limit).map((record) => {
      try {
        const gate = gates.read(record.to);
        return { ...record, ...notificationStatus(record, now(), gate),
          busySince: gate.busySince, probeCount: gate.probeCount, targetKey: gate.targetKey,
          nextProbeAt: gate.nextProbeAt };
      } catch (_error) {
        return { ...record, notificationState: 'waiting', waitingReason: 'target_gate_unavailable' };
      }
    });
  }

  /** Recover expired generations; pending mtime is never a new lease's age. */
  function recoverStaleInflight() {
    if (!root) return 0;
    let entries;
    try { entries = fs.readdirSync(directoryFor('inflight')); }
    catch (_error) { return 0; }
    let recovered = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      try {
        const changed = withRecordLock(() => {
          const current = readStoredRecord('inflight', id);
          if (!current) return false;
          const record = applyReadReceipt(fs, root, current);
          const claimedAt = record.claim ? Number(record.claim.claimedAt)
            : Number(fs.statSync(fileIn('inflight', id)).mtimeMs);
          if (!(claimedAt > 0) || now() - claimedAt < inflightStaleMs) return false;
          if (record.state === 'read') {
            archiveReadLocked('inflight', record);
            return true;
          }
          if (exists('pending', id)) return false;
          fs.renameSync(fileIn('inflight', id), fileIn('pending', id));
          const gate = gates.read(record.to);
          if (gate.lastMessageId === id && gate.lastReason === 'target_inflight') {
            gates.write(record.to, { nextProbeAt: now(), lastReason: '' });
          }
          return true;
        });
        if (changed) recovered += 1;
      } catch (_error) { /* In particular, do not retry a damaged receipt as unread. */ }
    }
    return recovered;
  }

  function reconcileSupersedes() {
    try { return withRecordLock(() => supersession.reconcilePending()) || { reconciled: 0, error: 'store_unavailable' }; }
    catch (error) { return { reconciled: 0, error: error.message }; }
  }

  /** Semantic deadlines only. Retention/auto-notify horizon never deletes history. */
  function expireStale() {
    let expired = 0;
    for (const record of listDirectory('pending')) {
      if (!(Number(record.expiresAt) > 0 && Number(record.expiresAt) <= now())) continue;
      try {
        withRecordLock(() => {
          const current = readStoredRecord('pending', record.id);
          if (!current || current.notificationState === 'expired') return;
          writeRecord('pending', { ...current, notificationState: 'expired', waitingReason: 'expired' });
          expired += 1;
        });
      } catch (_error) { /* Keep visible and let the next locked claim recheck. */ }
    }
    return expired;
  }

  return {
    root,
    aiHomeDir,
    ensureLayout,
    createMessage,
    createMessageResult,
    readTargetGate: gates.read,
    cancelMessage: (id, expected) => mutateMessage(id, 'cancel', expected),
    resumeMessage: (id, expected) => mutateMessage(id, 'resume', expected),
    checkDelivery,
    settleSkipped,
    claim,
    settleDelivered,
    settlePending,
    settleFailed,
    markRead,
    findMessage,
    listMessages,
    recoverStaleInflight,
    expireStale,
    reconcileRead,
    reconcileSupersedes,
    shortMessageId
  };
}

module.exports = {
  createPeerStore,
  newMessageId,
  shortMessageId,
  normalizeId,
  attemptCountOf,
  MIN_PREFIX_LENGTH,
  MESSAGE_PREFIX,
  DEFAULT_MAX_ATTEMPT_LOG,
  STATE_DIRECTORIES
};
