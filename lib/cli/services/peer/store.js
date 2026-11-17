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

const RECORD_VERSION = 1;
const MESSAGE_PREFIX = 'pm-';
// 前缀匹配的最短长度：太短会同时命中一堆消息，替用户猜反而更糟。
const MIN_PREFIX_LENGTH = 6;
// inflight 的孤儿判定：投递本身最长也就几秒（tmux send-keys / 一次 HTTP），
// 超过这个时间还挂在 inflight，说明投递进程已经死了。
const DEFAULT_INFLIGHT_STALE_MS = 60_000;
// `attempts` 只留最近这么多条。一条 24h 都投不出去的消息会试上千次（60s 封顶退避），
// 全留会把单条记录撑到 100KB+，而且每次重试都要整份重写。完整次数记在 `attemptCount`，
// 退避和展示都读它，所以截断不影响重试节奏。
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
  const explicit = Number(record && record.attemptCount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Array.isArray(record && record.attempts) ? record.attempts.length : 0;
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

  /** 追加一条尝试：完整次数进 `attemptCount`，明细只留最近 maxAttemptLog 条。 */
  function appendAttempt(record, entry) {
    const previous = Array.isArray(record && record.attempts) ? record.attempts : [];
    return {
      attemptCount: attemptCountOf(record) + 1,
      attempts: [...previous, entry].slice(-maxAttemptLog)
    };
  }

  const root = aiHomeDir ? resolveAihRunPath(aiHomeDir, 'peer') : '';

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
      for (const name of ['pending', 'inflight', 'archive', 'receipts']) {
        ensurePrivateDirectory(fs, nodePath.join(root, name));
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  function fileIn(dirName, id) {
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
    if (!record || typeof record !== 'object') return null;
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
    records.sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0));
    return records;
  }

  /** 写完立即返回；失败返回 null（调用方按「没落盘就不能说发出去了」处理）。 */
  function createMessage(input = {}) {
    if (!ensureLayout()) return null;
    const at = now();
    const record = {
      v: RECORD_VERSION,
      id: newMessageId(),
      from: describeAddress(input.from),
      to: describeAddress(input.to),
      replyTo: normalizeId(input.replyTo),
      body: String(input.body == null ? '' : input.body),
      createdAt: at,
      state: 'pending',
      attempts: [],
      attemptCount: 0,
      nextAttemptAt: 0,
      deliveredAt: 0,
      readAt: 0,
      channelMessageId: ''
    };
    try {
      writeFileAtomic(fs, fileIn('pending', record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (_error) {
      return null;
    }
    return record;
  }

  function writeRecord(dirName, record) {
    writeFileAtomic(fs, fileIn(dirName, record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  /** Claim and settle are fenced by the same cross-process lock/generation. */
  function claim(id) {
    const key = normalizeId(id);
    if (!key) return { record: null };
    try {
      return withRecordLock(() => {
        const stored = readStoredRecord('pending', key);
        if (!stored) return { record: null };
        const record = projectReadReceipt(fs, root, stored);
        if (record.receiptError) return { record: null, error: record.receiptError };
        if (record.state === 'read') {
          archiveReadLocked('pending', record);
          return { record: null };
        }
        if (exists('inflight', key)) return { record: null };
        const generation = Math.max(0, Number(record.claim && record.claim.generation) || 0) + 1;
        record.claim = { token: newMessageId(), generation, claimedAt: now() };
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

  function settle(record, state, error, patch, retryAfterMs) {
    if (!record || !record.id) return null;
    try {
      return withRecordLock(() => {
        const current = readStoredRecord('inflight', record.id);
        if (!current || !sameClaim(record.claim, current.claim)) return null;
        const acknowledged = applyReadReceipt(fs, root, current);
        const at = now();
        let next = { ...current, state,
          ...appendAttempt(current, { at, channel: String(current.to && current.to.channel || ''),
            ok: state === 'delivered', error: String(error || '') }) };
        if (state === 'delivered') {
          next.deliveredAt = at;
          next.nextAttemptAt = 0;
          next.channelMessageId = String(patch && patch.channelMessageId || '');
        } else if (state === 'pending') {
          next.nextAttemptAt = at + Math.max(0, Number(retryAfterMs) || 0);
        } else next.error = String(error || '');
        if (acknowledged.state === 'read') {
          next.state = 'read';
          next.readAt = writeReadReceipt(fs, root, next.id, Number(acknowledged.readAt) || now());
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
    return settle(record, 'pending', error, null, options2.retryAfterMs);
  }

  function settleFailed(record, error) {
    return settle(record, 'failed', error, null, 0);
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
    if (!key) return { record: null, ambiguous: [] };
    if (key.length >= MESSAGE_PREFIX.length + 32) {
      for (const dirName of ['pending', 'inflight', 'archive']) {
        const record = readRecord(dirName, key);
        if (record) return { record, directory: dirName, ambiguous: [] };
      }
      return { record: null, ambiguous: [] };
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
    filtered.sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0));
    const limit = Number.isFinite(Number(query.limit)) && Number(query.limit) > 0
      ? Math.floor(Number(query.limit))
      : filtered.length;
    return filtered.slice(0, limit);
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
          return true;
        });
        if (changed) recovered += 1;
      } catch (_error) { /* In particular, do not retry a damaged receipt as unread. */ }
    }
    return recovered;
  }

  /** 超时未投出的消息转 failed，避免收件箱无限堆积。 */
  function expireStale(maxAgeMs) {
    const age = Number(maxAgeMs);
    if (!Number.isFinite(age) || age <= 0) return 0;
    const at = now();
    let expired = 0;
    for (const record of listDirectory('pending')) {
      if (at - (Number(record.createdAt) || 0) < age) continue;
      const claimed = claim(record.id);
      if (!claimed.record) continue;
      if (settleFailed(claimed.record, 'expired')) expired += 1;
    }
    return expired;
  }

  return {
    root,
    aiHomeDir,
    ensureLayout,
    createMessage,
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
