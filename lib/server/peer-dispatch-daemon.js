'use strict';

// aih peer 的**空闲推送**：把收件箱里待投递的消息在目标空闲后补投出去。
//
// 为什么要有它：`aih peer send` 只立刻试一次，目标在跑回合就留在 pending。没有后台
// tick 的话，「排队」等于「永远不发」——用户得再敲一次 `aih peer flush` 才动。
//
// 三条硬约束（都是踩过的坑）：
//
//   1. **绝不在这里做全量会话扫描**。`collectGlobalPersistentSessionRows` 会遍历账号
//      目录和所有 tmux socket，3s 一轮会把 server 主进程拖死（见用量扫描卡死事件循环
//      那次事故）。所以补投只按消息里存的目标做单点探测。
//   2. **每次 tick 只处理少量消息**（默认 5 条）。`spawnSync` 是同步的，一条卡住
//      就是整个 server 卡住；用小批量把最坏情况压到几百毫秒。
//   3. **不等安静期**（timeoutMs: 0）：这一轮不安静就下一轮再来，不在 tick 里睡 3s。
//
// 与 CLI 的 `aih peer flush` 共用 `flushPending`，并发由 store 的 rename 抢锁兜底。

const { flushPending } = require('../cli/services/peer');
const { createPeerStore } = require('../cli/services/peer/store');
const { resolvePeerAiHomeDir } = require('../cli/services/peer/scope');
const { resolveUnprojectedHostHomeDir } = require('../runtime/host-home');

const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_BATCH = 5;

/**
 * 收件箱的根目录必须和 `aih peer` **完全同源**：`aih peer` 用
 * `resolvePeerAiHomeDir(env, 非投影的宿主 home)`，因为会话/收件箱属于整台机器，
 * 不属于某个账号投影。
 *
 * 为什么不能直接用 server 的 `aiHomeDir`：server 常常是从**投影 HOME** 的会话里
 * 启动的，那时 `aiHomeDir` 会落到 `<projection>/.ai_home`——守护进程盯着一份空的
 * `run/peer`，而 CLI 写的是宿主那份，消息永远补投不出去。
 */
function resolvePeerStoreRoot(options = {}) {
  const explicit = String(options.aiHomeDir || '').trim();
  if (explicit) return explicit;
  const env = options.env || process.env;
  return resolvePeerAiHomeDir(env, resolveUnprojectedHostHomeDir({ env }));
}

function startPeerDispatchDaemon(state, options = {}) {
  const intervalMs = Math.max(1_000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const aiHomeDir = resolvePeerStoreRoot(options);
  const empty = { attempted: 0, delivered: 0, pending: 0, failed: 0 };

  if (!aiHomeDir) {
    return {
      tick: async () => empty,
      stop() {},
      intervalMs
    };
  }

  const store = createPeerStore({ fs: options.fs, aiHomeDir });
  const batch = Math.max(1, Number(options.batch) || DEFAULT_BATCH);
  let running = false;
  let lastSummary = { ...empty };

  const tick = async () => {
    // 上一轮还没跑完就跳过：宁可漏一拍，也不让两轮在同一个进程里叠起来。
    if (running) return lastSummary;
    running = true;
    try {
      lastSummary = await flushPending({
        aiHomeDir,
        store,
        fs: options.fs,
        env: options.env || process.env,
        processImpl: options.processImpl || process,
        // 只投「现在就已经安静」的：忙的下个 tick 再看。
        timeoutMs: 0,
        limit: batch,
        expireMs: options.expireMs,
        // 测试/复用：允许注入适配器，生产走默认实现。
        sessionAdapter: options.sessionAdapter,
        createTmuxSessionAdapter: options.createTmuxSessionAdapter,
        createWebuiChatAdapter: options.createWebuiChatAdapter,
        adapterDeps: options.adapterDeps,
        serverBaseUrl: options.serverBaseUrl,
        managementKey: options.managementKey,
        readServerConfig: options.readServerConfig,
        fetchImpl: options.fetchImpl
      });
      if (lastSummary.delivered > 0 || lastSummary.failed > 0) {
        options.log?.(lastSummary);
      }
    } catch (_error) {
      // 补投失败绝不影响 server 主流程：消息留在收件箱，下个 tick 再来。
    } finally {
      running = false;
    }
    return lastSummary;
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    tick,
    stop() {
      clearInterval(timer);
    },
    intervalMs,
    batch
  };
}

module.exports = {
  startPeerDispatchDaemon,
  resolvePeerStoreRoot,
  DEFAULT_INTERVAL_MS,
  DEFAULT_BATCH
};
