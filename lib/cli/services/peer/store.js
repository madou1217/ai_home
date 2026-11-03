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
// **状态迁移一律是 rename**（同 fs 内原子）：server 的补投 tick 和 CLI 的
// `aih peer flush` 同时跑时，只有 rename 成功的那一个会去投，不会重复注入。
// 进程在 inflight 阶段被杀会留下孤儿文件，由 `recoverStaleInflight` 按 mtime
// 退回 pending——这是这套目录协议唯一的失败面，所以它必须存在。
//
// 记录里 `to.delivery` 保存重投所需的全部信息（cliName/runtimeScope/sessionName），
// 这样补投时不必重新全量扫描会话列表。

const crypto = require('node:crypto');
const nodePath = require('node:path');

const { writeFileAtomic } = require('../../../runtime/atomic-file-write');
const { ensurePrivateDirectory } = require('../../../runtime/durable-directory');
const { resolveAihRunPath } = require('../../../runtime/aih-storage-layout');

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
      for (const name of ['pending', 'inflight', 'archive']) {
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

  function readRecord(dirName, id) {
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
    return { ...record, state: stateFromDirectory(dirName, record) };
  }

  function stateFromDirectory(dirName, record) {
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

  /**
   * 抢一条待投递消息。返回 { record } 表示抢到了；{ record: null } 表示别人先抢走。
   * 抢到之后必须走 settleDelivered / settlePending / settleFailed 之一把它放回去。
   */
  function claim(id) {
    const key = normalizeId(id);
    if (!key) return { record: null };
    if (!ensureLayout()) return { record: null };
    try {
      fs.renameSync(fileIn('pending', key), fileIn('inflight', key));
    } catch (_error) {
      return { record: null };
    }
    return { record: readRecord('inflight', key) };
  }

  function settleDelivered(record, patch = {}) {
    if (!record || !record.id) return null;
    const at = now();
    const next = {
      ...record,
      ...patch,
      state: 'delivered',
      deliveredAt: at,
      nextAttemptAt: 0,
      ...appendAttempt(record, {
        at,
        channel: String(record.to && record.to.channel || ''),
        ok: true,
        error: ''
      })
    };
    try {
      writeRecord('inflight', next);
      fs.renameSync(fileIn('inflight', next.id), fileIn('archive', next.id));
    } catch (_error) {
      return null;
    }
    return { ...next, state: 'delivered' };
  }

  /** 没投出去：退回 pending 并记一次失败尝试 + 退避时刻。 */
  function settlePending(record, error, options2 = {}) {
    if (!record || !record.id) return null;
    const at = now();
    const next = {
      ...record,
      state: 'pending',
      ...appendAttempt(record, {
        at,
        channel: String(record.to && record.to.channel || ''),
        ok: false,
        error: String(error || '')
      }),
      nextAttemptAt: at + Math.max(0, Number(options2.retryAfterMs) || 0)
    };
    try {
      writeRecord('inflight', next);
      fs.renameSync(fileIn('inflight', next.id), fileIn('pending', next.id));
    } catch (_error) {
      return null;
    }
    return { ...next, state: 'pending' };
  }

  function settleFailed(record, error) {
    if (!record || !record.id) return null;
    const at = now();
    const next = {
      ...record,
      state: 'failed',
      error: String(error || ''),
      ...appendAttempt(record, {
        at,
        channel: String(record.to && record.to.channel || ''),
        ok: false,
        error: String(error || '')
      })
    };
    try {
      writeRecord('inflight', next);
      fs.renameSync(fileIn('inflight', next.id), fileIn('archive', next.id));
    } catch (_error) {
      return null;
    }
    return { ...next, state: 'failed' };
  }

  function markRead(id) {
    const found = findMessage(id);
    if (!found.record) return null;
    const next = { ...found.record, state: 'read', readAt: now() };
    try {
      writeRecord(found.directory, next);
    } catch (_error) {
      return null;
    }
    return next;
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
    if (state === 'pending') records = [...listDirectory('pending'), ...listDirectory('inflight')];
    else if (state === 'all' || state === 'unread' || state === 'open') {
      records = [...listDirectory('pending'), ...listDirectory('inflight'), ...listDirectory('archive')];
    } else records = listDirectory('archive');

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

  /**
   * 把崩溃留下的 inflight 孤儿退回 pending。只动 mtime 超过阈值的文件：
   * 正在投递的那条一定比阈值新。
   */
  function recoverStaleInflight() {
    if (!root) return 0;
    let entries = [];
    try {
      entries = fs.readdirSync(directoryFor('inflight'));
    } catch (_error) {
      return 0;
    }
    const at = now();
    let recovered = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = nodePath.join(directoryFor('inflight'), entry);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (_error) {
        continue;
      }
      if (at - Number(stat.mtimeMs) < inflightStaleMs) continue;
      try {
        fs.renameSync(file, nodePath.join(directoryFor('pending'), entry));
        recovered += 1;
      } catch (_error) { /* 别人先搬走了 */ }
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
