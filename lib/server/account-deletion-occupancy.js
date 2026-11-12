'use strict';

// 删除账号前的「运行态占用」探测与强制释放（Node 进程内事实）。
//
// 账号删除必须 fail-closed：只要有东西还攥着这个账号的凭据，就拒绝删除，否则会
// 留下用已删凭据继续发请求的进程。但「拒绝」必须**说得出原因**：调用方要能把
// 「谁在占用」如实告诉用户，并在用户确认后按占用者逐个终止，然后重试删除。
//
// 本模块只剩**只有 Node 进程能看见**的两类占用者：
//   - native_session：Node 内存里的原生聊天轮次（Go 看不到这张表）；
//   - desktop_app：本机桌面端进程（zcode / kimi 的窗口由 Node 的启动器拉起）。
//
// tmux 持久会话（persistent_session）已迁到 Go：Go 的 accountremoval 按登记 +
// 账号 socket 两份事实探测并能直接 kill-session，删除事务不再需要回调 Node 做
// 宿主清理。两份实现只会让「探测说有人、上报说没人」这类偏差长期存在。
//
// 不算占用者的是 aih 自己管理、删号时本来就要拆掉的资源（agy 暖机 LS 池）：
// 那不是「谁占着账号」，而是删除流程自己负责清理的对象，由删除路径直接回收，
// 回收不掉才 fail-closed（见 webui-account-routes-delete.js）。
//
// 各类占用者的终止手段不同，因此这里是**描述符表**而不是 if/else 链：每类占用者
// 声明「怎么探测」与「怎么终止」，新增占用者只加一条描述符。探测与终止都返回
// 结构化结果，绝不吞掉失败——终止不掉就是终止不掉，调用方据此继续 fail-closed。

const nodePath = require('node:path');

const { listRunningDesktopInstances } = require('./account-app-launcher');
const { resolveDesktopInstanceName } = require('./desktop-launch');
const { normalizeClientPlatform } = require('../runtime/client-platform');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

// ── 桌面应用占用（zcode / kimi）─────────────────────────────────────────────
// 桌面端进程本身就是「用户的工作」：它攥着账号凭据跑着窗口，删号后必须一并关掉，
// 但关闭会丢失用户正在做的事，因此和会话一样属于需要用户确认的占用者。
//
// 归属只看本账号：扫描结果是全机器所有账号的桌面实例，他账号的同名进程（例如另一个
// ZCode-<hash> 窗口）不是本账号的占用，绝不能 blocked，更不能在 release 时被误杀。
// 扫描失败则相反——状态未知必须 fail-closed，不能沿用运行态展示那条「失败降级为空」的路径。
const ZCODE_HOST_ROW_MAX_AGE_MS = 15000;
const DESKTOP_TERM_GRACE_MS = 1200;
const DESKTOP_KILL_GRACE_MS = 600;

function resolveProcessObj(ctx) {
  return (ctx && ctx.processObj)
    || (ctx && ctx.deps && ctx.deps.processObj)
    || process;
}

function resolvePlatformKey(ctx) {
  return normalizeClientPlatform(resolveProcessObj(ctx).platform)
    || normalizeClientPlatform(process.platform);
}

function normalizePathForPlatform(value, platformKey) {
  const text = normalizeText(value);
  if (!text) return '';
  return platformKey === 'windows' ? text.toLowerCase() : text;
}

// 与启动器、WebUI 运行态映射共用同一条账号目录规则：<profileDir>/electron-user-data。
function resolveTargetProfileDir(ctx, target) {
  if (typeof ctx.getProfileDir === 'function') {
    return normalizeText(ctx.getProfileDir(target.provider, target.accountRef));
  }
  return normalizeText(resolveAccountRuntimeDir(target.aiHomeDir, target.provider, target.accountRef));
}

// 扫描全机器桌面主进程。测试可注入整张扫描表；生产复用启动器的 listRunningDesktopInstances。
// 该函数为运行态展示设计，内部会吞掉扫描异常并返回 []——删除场景必须把异常原样带出去，
// 因此在 execFileSync 外层记录失败，待其返回后重新抛出（即使它已经降级出了部分结果）。
function scanDesktopInstances(ctx) {
  if (typeof ctx.listDesktopInstances === 'function') {
    const rows = ctx.listDesktopInstances();
    if (!Array.isArray(rows)) throw new Error('desktop_instance_scan_invalid');
    return rows;
  }
  const execFileSync = typeof ctx.execFileSync === 'function'
    ? ctx.execFileSync
    : require('node:child_process').execFileSync;
  let failure = null;
  const strictExecFileSync = (...args) => {
    try {
      return execFileSync(...args);
    } catch (error) {
      failure = failure || error;
      throw error;
    }
  };
  const rows = listRunningDesktopInstances(resolvePlatformKey(ctx), {
    execFileSync: strictExecFileSync
  });
  if (failure) throw failure;
  return Array.isArray(rows) ? rows : [];
}

function isPidAlive(ctx, pid) {
  if (typeof ctx.isProcessAlive === 'function') return Boolean(ctx.isProcessAlive(pid));
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    resolveProcessObj(ctx).kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

// zcode 的桌面协议桥在 hosts/<pid>.json 里登记该主进程当前服务的 accountRef，可做
// 精确归属。但进程崩溃后文件会残留，row 仍写着 ready——必须同时满足 ready、at 在
// 15s 内、pid 仍然存活，才承认它是证据。
function readZcodeHostRows(ctx, target) {
  if (normalizeText(target.provider).toLowerCase() !== 'zcode') return [];
  let mailboxDir = normalizeText(ctx.zcodeMailboxDir);
  if (!mailboxDir) {
    try {
      const { resolveZcodeDesktopBridgeBinding } = require('../runtime/zcode-desktop-bridge-binding');
      mailboxDir = normalizeText(resolveZcodeDesktopBridgeBinding({
        accountRef: target.accountRef,
        aiHomeDir: target.aiHomeDir
      }).mailboxDir);
    } catch (_error) {
      // 非 OAuth 账号（API Key）没有桥接目录；application name 仍可完成归属。
      return [];
    }
  }
  const fsImpl = ctx.fs || require('node:fs');
  const hostsDir = nodePath.join(mailboxDir, 'hosts');
  let names = [];
  try {
    names = fsImpl.readdirSync(hostsDir);
  } catch (_error) {
    return [];
  }
  const rows = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (!/^\d+\.json$/.test(String(name))) continue;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(nodePath.join(hostsDir, String(name)), 'utf8'));
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch (_error) { /* 半写/残留文件不能当作占用证据 */ }
  }
  return rows;
}

function findLiveZcodeHostRow(ctx, hostRows, pid) {
  const row = (Array.isArray(hostRows) ? hostRows : [])
    .find((entry) => Number(entry && entry.pid) === pid);
  if (!row || row.ready !== true || !normalizeText(row.accountRef)) return null;
  const at = Number(row.at);
  if (!Number.isFinite(at) || Date.now() - at >= ZCODE_HOST_ROW_MAX_AGE_MS) return null;
  return isPidAlive(ctx, pid) ? row : null;
}

function isOwnDesktopInstance(ctx, instance, context) {
  const pid = Number(instance && instance.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const { target, expectedUserDataDir, expectedApplicationName, hostRows, platformKey } = context;
  // kimi 及默认 Electron 形态：--user-data-dir=<profileDir>/electron-user-data 按目录归账号。
  const userDataDir = normalizePathForPlatform(instance && instance.userDataDir, platformKey);
  if (expectedUserDataDir && userDataDir && userDataDir === expectedUserDataDir) return true;
  // zcode 在 macOS 会把 argv 改写成 ZCode-<sha8>，只能按 application name 归属。
  const applicationName = normalizeText(instance && instance.applicationName).toLowerCase();
  if (!applicationName) return false;
  if (normalizeText(target.provider).toLowerCase() === 'zcode') {
    const hostRow = findLiveZcodeHostRow(ctx, hostRows, pid);
    // 新鲜 row 是精确证据：它说属于谁就属于谁（含「属于别的账号」）。
    if (hostRow) return normalizeText(hostRow.accountRef) === target.accountRef;
  }
  return Boolean(expectedApplicationName)
    && applicationName === expectedApplicationName.toLowerCase();
}

function signalPid(ctx, pid, signal) {
  try {
    resolveProcessObj(ctx).kill(pid, signal);
    return true;
  } catch (error) {
    // ESRCH：进程恰好已经自己退出，目标已达成。
    return Boolean(error && error.code === 'ESRCH');
  }
}

async function waitForPidExit(ctx, pid, timeoutMs) {
  const sleep = typeof ctx.sleep === 'function'
    ? ctx.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isPidAlive(ctx, pid)) return true;
    if (attempt < attempts - 1) await sleep(100);
  }
  return !isPidAlive(ctx, pid);
}

// ── 占用者描述符 ────────────────────────────────────────────────────────────
// detect(ctx, target) -> { items[] } | null
// release(ctx, item) -> { released: boolean, reason?: string }

const NATIVE_SESSION = {
  kind: 'native_session',
  label: '运行中的会话',
  async detect(ctx, target) {
    const listRuns = typeof ctx.listNativeChatRuns === 'function' ? ctx.listNativeChatRuns : () => [];
    const runs = listRuns().filter((run) => (
      normalizeText(run && run.provider) === target.provider
      && normalizeText(run && run.accountRef) === target.accountRef
    ));
    if (runs.length === 0) return null;
    return {
      items: runs.map((run) => ({
        kind: this.kind,
        label: this.label,
        runId: normalizeText(run.runId),
        sessionId: normalizeText(run.sessionId),
        projectPath: normalizeText(run.projectPath || run.projectDirName)
      }))
    };
  },
  async release(ctx, item) {
    const getRun = typeof ctx.getNativeChatRun === 'function' ? ctx.getNativeChatRun : () => null;
    const unregister = typeof ctx.unregisterNativeChatRun === 'function'
      ? ctx.unregisterNativeChatRun
      : () => {};
    const run = getRun(item.runId);
    // 已经不在了 = 目标达成，幂等成功。
    if (!run) return { released: true };
    try {
      if (typeof run.abort === 'function') run.abort();
      unregister(item.runId);
      return { released: true };
    } catch (error) {
      return {
        released: false,
        reason: normalizeText(error && error.message) || 'native_session_abort_failed'
      };
    }
  }
};

const DESKTOP_APP = {
  kind: 'desktop_app',
  label: '运行中的桌面应用',
  async detect(ctx, target) {
    const platformKey = resolvePlatformKey(ctx);
    const profileDir = resolveTargetProfileDir(ctx, target);
    const expectedApplicationName = normalizeText(
      resolveDesktopInstanceName(target.provider, target.accountRef)
    );
    const expectedUserDataDir = profileDir
      ? normalizePathForPlatform(nodePath.join(profileDir, 'electron-user-data'), platformKey)
      : '';
    // 扫描失败在这里直接抛出，由 detectDeletionBlockers 统一转成 uncertain 并 fail-closed。
    const instances = scanDesktopInstances(ctx);
    if (instances.length === 0) return null;
    const hostRows = readZcodeHostRows(ctx, target);
    const context = { target, expectedUserDataDir, expectedApplicationName, hostRows, platformKey };
    const mine = instances.filter((instance) => isOwnDesktopInstance(ctx, instance, context));
    if (mine.length === 0) return null;
    return {
      items: mine.map((instance) => ({
        kind: this.kind,
        label: this.label,
        provider: target.provider,
        accountRef: target.accountRef,
        aiHomeDir: target.aiHomeDir,
        pid: Number(instance.pid),
        applicationName: normalizeText(instance.applicationName),
        userDataDir: normalizeText(instance.userDataDir),
        detail: `pid ${Number(instance.pid)}`
      }))
    };
  },
  async release(ctx, item) {
    // 探针不确定时不做破坏性动作：宁可如实报原因，也不要猜一个 pid 去杀。
    if (!item || item.uncertain) return { released: false, reason: 'desktop_app_state_unknown' };
    // item 只来自 detect 的「本账号」过滤结果，因此这里结束的就是本账号的主进程。
    const pid = Number(item.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      return { released: false, reason: 'desktop_app_invalid_pid' };
    }
    if (isPidAlive(ctx, pid)) {
      if (!signalPid(ctx, pid, 'SIGTERM')) {
        return { released: false, reason: 'desktop_app_terminate_failed' };
      }
      await waitForPidExit(ctx, pid, DESKTOP_TERM_GRACE_MS);
      if (isPidAlive(ctx, pid)) {
        signalPid(ctx, pid, 'SIGKILL');
        await waitForPidExit(ctx, pid, DESKTOP_KILL_GRACE_MS);
      }
    }
    // 只认「复探后本账号不再有桌面进程」为成功：kill 没抛异常不等于进程真的走了。
    const target = {
      provider: item.provider,
      accountRef: item.accountRef,
      aiHomeDir: item.aiHomeDir
    };
    let reprobe = null;
    try {
      reprobe = await this.detect(ctx, target);
    } catch (_error) {
      return { released: false, reason: 'desktop_app_state_unknown' };
    }
    if (reprobe && Array.isArray(reprobe.items) && reprobe.items.length > 0) {
      return { released: false, reason: 'desktop_app_still_running' };
    }
    return { released: true };
  }
};

const OCCUPANT_DESCRIPTORS = [NATIVE_SESSION, DESKTOP_APP];

/** 汇总该账号当前所有占用者。返回 { blocked, items[] }，items 为空表示无占用。 */
async function detectDeletionBlockers(ctx, target) {
  const items = [];
  for (const descriptor of OCCUPANT_DESCRIPTORS) {
    let result = null;
    try {
      result = await descriptor.detect(ctx, target);
    } catch (error) {
      // 探测本身失败 = 状态未知，必须 fail-closed，并把原因如实带出去。
      items.push({
        kind: descriptor.kind,
        label: descriptor.label,
        uncertain: true,
        detail: normalizeText(error && error.message) || 'detect_failed'
      });
      continue;
    }
    if (result && Array.isArray(result.items)) items.push(...result.items);
  }
  return { blocked: items.length > 0, items };
}

/**
 * 终止给定占用者。逐项尝试，返回 { released, failed[] }：
 * released 只有在**全部**成功时才为 true——调用方据此决定能否继续删除。
 */
async function releaseDeletionBlockers(ctx, items = []) {
  const failed = [];
  for (const item of Array.isArray(items) ? items : []) {
    const descriptor = OCCUPANT_DESCRIPTORS.find((entry) => entry.kind === item.kind);
    if (!descriptor) {
      failed.push({ ...item, reason: 'unknown_occupant_kind' });
      continue;
    }
    let result = null;
    try {
      result = await descriptor.release(ctx, item);
    } catch (error) {
      result = { released: false, reason: normalizeText(error && error.message) || 'release_failed' };
    }
    if (!result || !result.released) {
      failed.push({ ...item, reason: normalizeText(result && result.reason) || 'release_failed' });
    }
  }
  return { released: failed.length === 0, failed };
}

module.exports = {
  detectDeletionBlockers,
  releaseDeletionBlockers
};
