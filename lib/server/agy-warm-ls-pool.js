'use strict';

// agy(antigravity CLI)暖机语言服务（LS）进程池。
//
// 背景：agy 是个 ~140MB 的 Go 单体，内嵌 gRPC 语言服务（LanguageServerService）。
// 冷启动一次要 ~100s——这正是 WebUI 里 agy 原生会话「非常非常慢」的根因：每一轮都
// `agy --prompt-interactive` 重新拉起整个 LS。
//
// 破解：把启动出来的 agy 进程「留活」，后续轮次改用 `agy agentapi send-message <conv> <prompt>`
// 打到这个已暖机的 LS 端口上——实测 ~3-4s（含模型生成），且因为 brain/conversations 是
// 账号级共享存储，【同一账号的任意会话】都能由同一个暖机 LS 服务（已实测 cross-conv 3.1s）。
//
// 因此池以【账号(profileDir)】为键：每个 agy 账号至多 1 个常驻暖机 LS。
//   - 新建会话 / 无暖机 LS 的 resume：仍走 `--prompt-interactive` 冷启动（new-conversation
//     这条 RPC 会 panic，必须用交互式启动来建会话），完成后把该进程 adopt 进池。
//   - 已有暖机 LS 的任意轮次：走 send-message 快路径。
//
// 端口发现跨平台：darwin/linux 用 lsof，win32 用 netstat。agy 会绑 2 个相邻端口，
// 较高的那个是明文 HTTP gRPC（agentapi 用的就是它）。

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createWriterLifecycleCoordinator } = require('./agy-writer-lifecycle');

const IDLE_TTL_MS = Number(process.env.AIH_AGY_WARM_TTL_MS) || 10 * 60 * 1000; // 空闲 10min 回收
const MAX_POOL = Number(process.env.AIH_AGY_WARM_MAX) || 4; // 并发暖机 LS 上限（每个 ~185MB）
const SEND_TIMEOUT_MS = 20_000;
const RESPONSE_POLL_INTERVAL_MS = 800;
const RESPONSE_TIMEOUT_MS = Number(process.env.AIH_AGY_WARM_RESP_TIMEOUT_MS) || 180_000;
const PORT_DISCOVER_RETRIES = 8;
const PORT_DISCOVER_INTERVAL_MS = 500;

// accountRef -> entry
//   entry: { child, pid, port, accountRef, agyBin, baseEnv, projectId, lastUsed }
const pool = new Map();
let evictTimer = null;

function log(...args) {
  if (process.env.AIH_AGY_WARM_DEBUG) {
    // eslint-disable-next-line no-console
    console.error('[agy-warm-ls]', ...args);
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

// 进程 pid 监听的端口，从高到低排序。agy 绑两个相邻端口，高位=明文 gRPC（agentapi 用）。
function discoverListenPorts(pid) {
  if (!pid) return [];
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000 });
      const ports = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (String(cols[cols.length - 1]) !== String(pid)) continue;
        const local = cols[1] || '';
        const m = local.match(/:(\d+)$/);
        if (m) ports.add(Number(m[1]));
      }
      return [...ports].sort((a, b) => b - a);
    }
    // darwin / linux
    const out = execFileSync(
      'lsof',
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 5000 }
    );
    const ports = new Set();
    for (const m of out.matchAll(/:(\d+) \(LISTEN\)/g)) {
      ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => b - a);
  } catch (_error) {
    return [];
  }
}

async function discoverPortWithRetry(pid) {
  for (let i = 0; i < PORT_DISCOVER_RETRIES; i += 1) {
    const ports = discoverListenPorts(pid);
    if (ports.length) return ports[0];
    await sleep(PORT_DISCOVER_INTERVAL_MS);
  }
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function ensureEvictTimer() {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pool) {
      if (!pidAlive(entry.pid)) {
        pool.delete(key);
        continue;
      }
      if (now - entry.lastUsed > IDLE_TTL_MS) {
        log('evict idle', key, entry.pid);
        startEntryQuiescence(key, entry, 'idle');
      }
    }
    if (pool.size === 0 && evictTimer) {
      clearInterval(evictTimer);
      evictTimer = null;
    }
  }, 60_000);
  if (typeof evictTimer.unref === 'function') evictTimer.unref();
}

function killEntry(entry) {
  if (!entry) return;
  try {
    if (entry.child && typeof entry.child.kill === 'function') {
      entry.child.kill();
    } else if (entry.pid) {
      process.kill(entry.pid);
    }
  } catch (_error) { /* ignore */ }
}

const writerLifecycle = createWriterLifecycleCoordinator({
  isWriterAlive: (writer) => pidAlive(writer && writer.pid),
  terminateWriter: (writer) => killEntry(writer),
  waitForPoll: sleep
});

function reserveWriter(accountRef) {
  return writerLifecycle.reserve(accountRef);
}

function activateWriter(lease, child) {
  return writerLifecycle.activate(lease, child);
}

function releaseWriter(lease) {
  return writerLifecycle.release(lease);
}

function hasWriter(accountRef) {
  return writerLifecycle.hasWriter(accountRef);
}

function canReconcileBeforeSpawn(lease) {
  return writerLifecycle.canReconcileBeforeSpawn(lease);
}

function startEntryQuiescence(accountRef, entry, reason) {
  const normalizedRef = String(accountRef || '').trim();
  const quiescence = writerLifecycle.quiesce(normalizedRef, {
    lease: entry && entry.writerLease,
    writer: entry || null,
    reason
  });
  quiescence.then(() => {
    const current = pool.get(normalizedRef);
    if (current && (!entry || current === entry) && !pidAlive(current.pid)) {
      pool.delete(normalizedRef);
    }
  }).catch(() => {});
  return quiescence;
}

function waitForQuiescence(accountRef, options = {}) {
  const normalizedRef = String(accountRef || '').trim();
  return startEntryQuiescence(
    normalizedRef,
    pool.get(normalizedRef) || null,
    String(options.reason || 'cold-spawn')
  );
}

function enforceCap() {
  const candidates = [...pool.entries()]
    .filter(([key]) => !writerLifecycle.isQuiescing(key));
  while (candidates.length > MAX_POOL) {
    let oldestKey = null;
    let oldest = Infinity;
    let oldestIndex = -1;
    for (let index = 0; index < candidates.length; index += 1) {
      const [key, entry] = candidates[index];
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
        oldestIndex = index;
      }
    }
    if (!oldestKey) break;
    log('evict over-cap', oldestKey);
    const [[, entry]] = candidates.splice(oldestIndex, 1);
    startEntryQuiescence(oldestKey, entry, 'over-cap');
  }
}

// 把一个【刚跑完一轮、仍存活】的 agy pty 子进程收编为该账号的暖机 LS。
// 返回 true 表示已收编（端口发现成功）；否则不收编（让调用方照常 kill）。
async function adopt({ accountRef, child, agyBin, baseEnv, projectId, model, writerLease }) {
  const normalizedRef = String(accountRef || '').trim();
  if (!normalizedRef || !child || !pidAlive(child.pid)) return false;

  const port = await discoverPortWithRetry(child.pid);
  if (!port) {
    log('adopt failed: no port for pid', child.pid);
    return false;
  }

  let lease = writerLease || null;
  let ownsLease = false;
  if (!lease) {
    lease = reserveWriter(normalizedRef);
    ownsLease = activateWriter(lease, child);
  }

  // 同账号已有旧暖机 LS：只允许较新的 writer generation 替换旧进程。
  const prev = pool.get(normalizedRef);
  if (prev && prev.child !== child) {
    if (Number(prev.generation) >= Number(lease.generation)) {
      if (ownsLease) releaseWriter(lease);
      return false;
    }
    await startEntryQuiescence(normalizedRef, prev, 'replacement');
    if (!pidAlive(child.pid)) {
      if (ownsLease) releaseWriter(lease);
      return false;
    }
  }

  const entry = {
    child,
    pid: child.pid,
    port,
    accountRef: normalizedRef,
    agyBin: agyBin || 'agy',
    baseEnv: baseEnv || {},
    projectId: projectId || '',
    writerLease: lease,
    generation: lease.generation,
    // 本轮启动该 LS 时使用的模型。resume 快路径(send-message)无法换模型——LS 会话
    // 粘住启动模型,所以请求模型不同的轮次必须绕过暖机、冷启动换模型(见调用方 gate)。
    model: String(model || '').trim(),
    lastUsed: Date.now()
  };
  pool.set(normalizedRef, entry);

  if (typeof child.onExit === 'function') {
    child.onExit(() => {
      const cur = pool.get(normalizedRef);
      if (cur && cur.generation === lease.generation && cur.child === child) {
        pool.delete(normalizedRef);
      }
      if (ownsLease) releaseWriter(lease);
    });
  }

  enforceCap();
  ensureEvictTimer();
  log('adopted', normalizedRef, 'pid', child.pid, 'port', port);
  return true;
}

function getLive(accountRef) {
  const normalizedRef = String(accountRef || '').trim();
  const entry = pool.get(normalizedRef);
  if (!entry) return null;
  if (entry.unavailable) return null;
  if (writerLifecycle.isQuiescing(normalizedRef)) return null;
  if (!pidAlive(entry.pid)) {
    pool.delete(normalizedRef);
    return null;
  }
  return entry;
}

function hasWarm(accountRef) {
  return !!getLive(accountRef);
}

async function evict(accountRef, options = {}) {
  const normalizedRef = String(accountRef || '').trim();
  const quiescence = waitForQuiescence(normalizedRef, { reason: 'explicit-evict' });
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 2000);
  let timeout = null;
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();
  });
  const completed = await Promise.race([
    quiescence.then(() => true),
    timedOut
  ]);
  if (timeout) clearTimeout(timeout);
  return completed && !hasWriter(normalizedRef);
}

// 暖机 LS 能否服务请求的模型：无请求模型=沿用会话当前模型 ✓；模型一致 ✓；
// 暖机条目未记录模型(旧条目)或模型不同 → 需冷启动换模型。纯判定拆出便于单测。
function entrySupportsModel(entry, model) {
  if (!entry) return false;
  const wanted = String(model || '').trim();
  if (!wanted) return true;
  return String(entry.model || '').trim() === wanted;
}

function warmSupportsModel(accountRef, model) {
  return entrySupportsModel(getLive(accountRef), model);
}

// 对暖机 LS 发 send-message（快路径 ack，~0.1s）。失败抛错。
function sendMessage(entry, conversationId, prompt) {
  return new Promise((resolve, reject) => {
    const env = {
      ...entry.baseEnv,
      ANTIGRAVITY_LS_ADDRESS: `localhost:${entry.port}`
    };
    if (entry.projectId) env.ANTIGRAVITY_PROJECT_ID = entry.projectId;
    execFile(
      entry.agyBin,
      ['agentapi', 'send-message', conversationId, prompt],
      { env, timeout: SEND_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          error.stdout = stdout;
          reject(error);
          return;
        }
        // agentapi 在 LS 内部错误时仍 exit 0 但 stdout 带 {"response":{},"error":...}
        let parsed = null;
        try { parsed = JSON.parse(stdout); } catch (_e) { /* tolerate */ }
        if (parsed && parsed.error) {
          const e = new Error(String(parsed.error));
          e.code = 'agy_send_message_error';
          reject(e);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// 直接读 brain transcript 原始 JSONL 记录。
// 【关键】不能用 session-reader 的高层解析做「轮次完成」判定：agentapi send-message 把用户消息
// 记成 SYSTEM_MESSAGE（而非 USER_INPUT），高层解析只在 USER_INPUT 处切分 assistant 轮次，于是
// 把多轮 PLANNER_RESPONSE 合并成同一条 assistant 消息 → 消息计数不增 → 永远判不出本轮完成。
// 因此以原始 PLANNER_RESPONSE 记录的【新增】作为完成信号（与 PoC 一致）。
function readTranscriptRecords(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const records = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { records.push(JSON.parse(trimmed)); } catch (_e) { /* skip partial line */ }
    }
    return records;
  } catch (_error) {
    return [];
  }
}

// 快路径完整一轮：send-message + 轮询 brain transcript 等新增 PLANNER_RESPONSE。
// transcriptPath 由调用方解析（resolveAgySessionPath）。
// 返回 { warm:true, content, sessionId } / { warm:false }（无暖机 LS 或 LS 已失效）。
async function runWarmResume({ accountRef, conversationId, prompt, transcriptPath }) {
  const entry = getLive(accountRef);
  if (!entry) return { warm: false };

  const baselineCount = readTranscriptRecords(transcriptPath).length;

  try {
    await sendMessage(entry, conversationId, prompt);
  } catch (error) {
    // LS 可能已崩/端口失效：先标记不可复用，让调用方预留 successor generation；
    // 随后的 cold-spawn quiescence 再 kill，保证旧 child onExit 能看见 newer pending writer。
    log('send-message failed, dropping warm LS:', error && error.message);
    entry.unavailable = true;
    return { warm: false, error };
  }

  entry.lastUsed = Date.now();

  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(RESPONSE_POLL_INTERVAL_MS);
    const records = readTranscriptRecords(transcriptPath);
    if (records.length <= baselineCount) continue;
    const fresh = records.slice(baselineCount);
    const planner = fresh.filter((r) => r && r.type === 'PLANNER_RESPONSE');
    const content = planner
      .map((r) => String(r.content || '').trim())
      .filter(Boolean)
      .join('\n\n');
    if (content) {
      entry.lastUsed = Date.now();
      return { warm: true, content, sessionId: conversationId, records };
    }
  }
  // 超时：仍算暖路径已派发，但没等到回复（交给调用方按失败处理）。
  return { warm: true, content: '', sessionId: conversationId, timedOut: true };
}

function shutdownAll() {
  for (const [key, entry] of pool) {
    startEntryQuiescence(key, entry, 'shutdown');
  }
  if (evictTimer) {
    clearInterval(evictTimer);
    evictTimer = null;
  }
}

function stats() {
  return [...pool.entries()].map(([key, e]) => ({
    accountRef: key,
    pid: e.pid,
    port: e.port,
    idleMs: Date.now() - e.lastUsed
  }));
}

module.exports = {
  createWriterLifecycleCoordinator,
  adopt,
  reserveWriter,
  activateWriter,
  releaseWriter,
  hasWriter,
  canReconcileBeforeSpawn,
  waitForQuiescence,
  getLive,
  hasWarm,
  evict,
  entrySupportsModel,
  warmSupportsModel,
  runWarmResume,
  discoverListenPorts,
  shutdownAll,
  stats
};
