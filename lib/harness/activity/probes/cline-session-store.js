'use strict';

// Cline 原生会话清单探测（开源 harness 的生命周期事实，而不是猜 pane 输出）。
//
// 事实来源（cline-cli / @cline/core 的 session manifest，2026-10 真机核对）：
//   ~/.cline/data/sessions/<sessionId>/<sessionId>.json
//     { session_id, pid, started_at, ended_at?, status, cwd, messages_path, ... }
//   ~/.cline/data/sessions/<sessionId>/<sessionId>.messages.json
//     { updated_at, messages: [...] } —— assistant/tool 消息持续重写，mtime 是回合活性。
//
// 语义：
//   * status 是**会话级**状态（running/completed/failed/cancelled），不是「回合正在跑」；
//     ended_at / 终态 / 进程消失才是权威的「会话已结束」→ decisive 熄灯。
//   * running 会话里 messages mtime 很新 → 模型正在产出（positive 点亮）；
//     静默则只能说明「没看到输出」，是否空闲交给 pane 探测兜底（不能单凭文件不写判死，
//     长时间工具调用期间消息文件可能不动）。
//
// 归属：会话库是宿主共享的（~/.cline 被链回宿主），文件里没有 aih 账号。用与用量采集
// 相同的注册表作用域规则（cwd + 会话开始时刻唯一命中）把会话映射到 accountRef。
//
// 新增同类 harness：复制本文件改数据布局即可；注册表按目录自动装载，入口不改。

const { createClineUsageOwnership } = require('../../../usage/cline-usage-ownership');

const PROBE_ID = 'cline-session-store';
const INDEX_CACHE_KEY = 'cline-session-index';
// 目录名以毫秒时间戳开头：只读最近的会话，避免历史堆积把一次 tick 拖垮。
const MAX_SESSION_DIRS = 400;
const TERMINAL_STATUSES = new Set(['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled']);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isProcessAlive(pid) {
  const number = Number(pid);
  if (!Number.isFinite(number) || number <= 0) return null; // 未知
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true;
    if (error && error.code === 'ESRCH') return false;
    return null;
  }
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(normalizeText(status).toLowerCase());
}

function readSessionIndex(context) {
  if (context.cache) {
    const cached = context.cache.get(INDEX_CACHE_KEY);
    if (cached) return cached;
  }
  const { fs, path, hostHomeDir } = context;
  const root = hostHomeDir ? path.join(hostHomeDir, '.cline', 'data', 'sessions') : '';
  const records = [];
  if (root) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_error) {
      entries = [];
    }
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, MAX_SESSION_DIRS);
    for (const name of names) {
      const manifestPath = path.join(root, name, `${name}.json`);
      const messagesPath = path.join(root, name, `${name}.messages.json`);
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (_error) {
        manifest = null;
      }
      if (!manifest || typeof manifest !== 'object') continue;
      let messagesMtimeMs = 0;
      try {
        messagesMtimeMs = Number(fs.statSync(messagesPath).mtimeMs) || 0;
      } catch (_error) {
        messagesMtimeMs = 0;
      }
      const startedAtMs = toTimestampMs(manifest.started_at)
        || Number.parseInt(name.split('_')[0], 10)
        || Number(fs.statSync(manifestPath).mtimeMs)
        || 0;
      records.push({
        sessionId: normalizeText(manifest.session_id) || name,
        cwd: normalizeText(manifest.cwd),
        pid: manifest.pid,
        status: normalizeText(manifest.status),
        startedAtMs,
        endedAtMs: toTimestampMs(manifest.ended_at),
        messagesMtimeMs
      });
    }
  }
  if (context.cache) context.cache.set(INDEX_CACHE_KEY, records);
  return records;
}

function resolveOwnership(context) {
  if (context.cache) {
    const cached = context.cache.get('cline-ownership');
    if (cached) return cached;
  }
  const ownership = createClineUsageOwnership({
    fs: context.fs,
    aiHomeDir: context.aiHomeDir
  });
  if (context.cache) context.cache.set('cline-ownership', ownership);
  return ownership;
}

module.exports = {
  id: PROBE_ID,
  label: 'Cline 会话清单（started_at / ended_at / status）',
  priority: 20,
  claims: (harnessId) => harnessId === 'cline',
  probe(context) {
    if (!context.hostHomeDir || !context.accountRef) return null;
    const ownership = resolveOwnership(context);
    const owned = readSessionIndex(context)
      .filter((record) => {
        const resolved = ownership.resolve({
          cwd: record.cwd,
          startedAtMs: record.startedAtMs
        });
        return normalizeText(resolved && resolved.accountRef) === context.accountRef;
      })
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
    const record = owned[0];
    if (!record) return null;

    const alive = record.status.toLowerCase() === 'running' ? isProcessAlive(record.pid) : null;
    const ended = record.endedAtMs > 0
      || isTerminalStatus(record.status)
      || alive === false;
    if (ended) {
      return {
        turn: false,
        authority: 'turn',
        // 会话明确结束：即使 pane 上还有一次退出重绘，也以会话生命周期为准。
        decisive: true,
        lastActivityAt: record.endedAtMs || record.messagesMtimeMs || record.startedAtMs,
        source: PROBE_ID,
        detail: { sessionId: record.sessionId, status: record.status }
      };
    }

    const observedAt = record.messagesMtimeMs || record.startedAtMs;
    const active = observedAt > 0 && context.nowMs - observedAt <= context.turnActiveWindowMs;
    return {
      turn: active,
      // 只承认「看到产出 → 在跑」；文件静默不判空闲（长工具调用期间也可能不写）。
      authority: active ? 'positive' : 'none',
      decisive: false,
      lastActivityAt: observedAt,
      source: PROBE_ID,
      detail: { sessionId: record.sessionId, status: record.status }
    };
  }
};
