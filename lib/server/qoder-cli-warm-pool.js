'use strict';

// Qoder CLI warm 会话池：`qodercli --print --input-format stream-json` 在 `result` 之后
// 不会退出，会继续等待下一条 user 消息（2026-10-19 真机 1.1.73 实测：首轮 init ~7.7s /
// result ~13.4s，同进程第二轮 ~3.3s）。本模块只负责进程生命周期与逐行路由，不解释
// stream-json 语义（由 qoder-cli-transport 处理），这样冷启动路径与 warm 路径共用同一套
// 事件解析，不会出现两套 usage/错误判定。
//
// 复用纪律：一个 CLI 进程 = 一段会话。调用方必须用 `historyHash` 证明「本次请求的前缀
// 与进程内已有历史一致」才可复用；不一致一律 discard 后重建，绝不把 A 会话的上下文
// 带进 B 会话。池满时不驱逐正在 busy 的进程，直接让调用方走冷启动。

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_KILL_GRACE_MS = 500;

function normalizeString(value) {
  return typeof value === 'string' ? value : '';
}

function createQoderCliWarmPool(options = {}) {
  const spawn = typeof options.spawn === 'function' ? options.spawn : null;
  if (!spawn) throw new Error('qoder_cli_warm_pool_spawn_required');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const idleTtlMs = Number.isFinite(options.idleTtlMs) && options.idleTtlMs > 0
    ? options.idleTtlMs
    : DEFAULT_IDLE_TTL_MS;
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
    ? Math.max(1, Math.floor(options.maxEntries))
    : DEFAULT_MAX_ENTRIES;
  const killGraceMs = Number.isFinite(options.killGraceMs) && options.killGraceMs >= 0
    ? options.killGraceMs
    : DEFAULT_KILL_GRACE_MS;
  const entries = new Map();

  const removeEntry = (entry) => {
    if (!entry) return;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  };

  const killEntry = (entry) => {
    if (!entry || entry.killed) return;
    entry.killed = true;
    const child = entry.child;
    if (!child || !child.kill) return;
    try { child.kill('SIGTERM'); } catch (_error) { /* best effort */ }
    if (killGraceMs <= 0) return;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_error) { /* best effort */ }
    }, killGraceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  const failPending = (entry, error) => {
    const pending = entry && entry.pending;
    if (!pending) return;
    entry.pending = null;
    entry.state = 'dead';
    try { pending.reject(error); } catch (_error) { /* best effort */ }
  };

  const discard = (entry, reason) => {
    if (!entry) return;
    removeEntry(entry);
    entry.state = 'dead';
    const error = reason instanceof Error
      ? reason
      : Object.assign(new Error(String(reason || 'qoder_cli_warm_discarded')), { code: 'qoder_cli_warm_discarded' });
    failPending(entry, error);
    killEntry(entry);
  };

  const prune = () => {
    const idle = [];
    for (const entry of entries.values()) {
      if (entry.state === 'idle' && now() - entry.lastUsedAt >= idleTtlMs) {
        discard(entry, 'qoder_cli_warm_idle_expired');
      } else if (entry.state === 'idle') {
        idle.push(entry);
      }
    }
    if (entries.size <= maxEntries) return;
    idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (entries.size > maxEntries && idle.length > 0) {
      discard(idle.shift(), 'qoder_cli_warm_lru_evicted');
    }
  };

  const handleLine = (entry, line) => {
    const pending = entry && entry.pending;
    if (!pending) return;
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_error) {
      return;
    }
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
      entry.sessionId = normalizeString(parsed.session_id) || entry.sessionId;
    }
    try {
      pending.onLine(parsed, line);
    } catch (error) {
      discard(entry, error);
      return;
    }
    if (parsed && parsed.type === 'result') {
      entry.pending = null;
      entry.state = 'idle';
      entry.lastUsedAt = now();
      try { pending.resolve({ sessionId: entry.sessionId }); } catch (_error) { /* best effort */ }
      prune();
    }
  };

  const attach = (entry) => {
    const child = entry.child;
    child.stdout.on('data', (chunk) => {
      entry.lineBuffer += chunk.toString('utf8');
      let index;
      while ((index = entry.lineBuffer.indexOf('\n')) !== -1) {
        const line = entry.lineBuffer.slice(0, index);
        entry.lineBuffer = entry.lineBuffer.slice(index + 1);
        handleLine(entry, line);
      }
    });
    child.stderr.on('data', (chunk) => {
      entry.stderrTail = (entry.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (error) => {
      discard(entry, Object.assign(new Error(`qoder_cli_warm_spawn_failed:${error && error.message || error}`), {
        code: 'qoder_cli_warm_spawn_failed'
      }));
    });
    child.on('close', (code) => {
      const exitError = Object.assign(
        new Error(`qoder_cli_warm_exit_${code}:${entry.stderrTail.trim().slice(-300) || 'no_stderr'}`),
        { code: 'qoder_cli_warm_exit' }
      );
      discard(entry, exitError);
    });
    return entry;
  };

  const createEntry = (key, spec) => {
    let child;
    try {
      child = spawn(spec.cliPath, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        windowsHide: true,
        shell: Boolean(spec.shell),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (_error) {
      // spawn 同步失败（参数非法 / Windows 直接 spawn .cmd 等）不进入池：返回 null
      // 让调用方走冷启动，由冷启动路径报出真实、可读的错误。
      return null;
    }
    const entry = {
      key,
      child,
      spec,
      state: 'idle',
      sessionId: '',
      historyHash: normalizeString(spec.historyHash),
      lastUsedAt: now(),
      pending: null,
      lineBuffer: '',
      stderrTail: '',
      killed: false
    };
    entries.set(key, entry);
    attach(entry);
    prune();
    return entry;
  };

  const get = (key) => entries.get(key) || null;

  const acquire = (key, spec) => {
    const existing = entries.get(key);
    if (existing && existing.state === 'busy') {
      // 同一会话已有在跑的一轮：绝不能为了复用杀掉它，交回调用方走冷启动。
      return null;
    }
    if (existing && existing.state === 'idle' && existing.historyHash === normalizeString(spec.historyHash)) {
      existing.lastUsedAt = now();
      return existing;
    }
    if (existing) discard(existing, 'qoder_cli_warm_history_mismatch');
    if (entries.size >= maxEntries) {
      prune();
      if (entries.size >= maxEntries) {
        // LRU：只驱逐 idle 的最久未用项；全是 busy 时交回调用方走冷启动。
        const idle = [...entries.values()]
          .filter((entry) => entry.state === 'idle')
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        if (idle.length > 0) discard(idle[0], 'qoder_cli_warm_lru_evicted');
      }
      if (entries.size >= maxEntries) return null;
    }
    return createEntry(key, spec);
  };

  const sendTurn = (entry, { input, onLine, signal } = {}) => {
    if (!entry) return Promise.reject(Object.assign(new Error('qoder_cli_warm_entry_missing'), { code: 'qoder_cli_warm_entry_missing' }));
    if (entry.state !== 'idle' || entry.pending) {
      return Promise.reject(Object.assign(new Error('qoder_cli_warm_busy'), { code: 'qoder_cli_warm_busy' }));
    }
    entry.state = 'busy';
    entry.lastUsedAt = now();
    return new Promise((resolve, reject) => {
      let settled = false;
      const detachAbort = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const onAbort = () => {
        if (settled) return;
        discard(entry, Object.assign(new Error('qoder_cli_aborted'), { code: 'qoder_cli_aborted' }));
      };
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        detachAbort();
        resolve(value);
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        detachAbort();
        reject(error);
      };
      entry.pending = { onLine, resolve: settleResolve, reject: settleReject };
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        entry.child.stdin.write(`${input}\n`);
      } catch (error) {
        discard(entry, Object.assign(new Error(`qoder_cli_warm_stdin_failed:${error && error.message || error}`), {
          code: 'qoder_cli_warm_stdin_failed'
        }));
      }
    });
  };

  const failTurn = (entry, error) => {
    discard(entry, error);
  };

  const closeAll = () => {
    for (const entry of [...entries.values()]) {
      discard(entry, 'qoder_cli_warm_closed');
      // 进程即将退出时 unref 的 SIGKILL 定时器不会有机会执行；直接补一刀，
      // 避免 CLI 残留并占住账号配置目录的锁（真机 smoke 已见首轮 120s 无输出）。
      try { entry.child.kill('SIGKILL'); } catch (_error) { /* best effort */ }
    }
  };

  const stats = () => {
    let idle = 0;
    let busy = 0;
    for (const entry of entries.values()) {
      if (entry.state === 'idle') idle += 1;
      else if (entry.state === 'busy') busy += 1;
    }
    return { size: entries.size, idle, busy };
  };

  return {
    acquire,
    createEntry,
    get,
    sendTurn,
    discard,
    failTurn,
    prune,
    closeAll,
    stats,
    __private: { entries, idleTtlMs, maxEntries, killGraceMs }
  };
}

module.exports = {
  createQoderCliWarmPool,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_MAX_ENTRIES
};
