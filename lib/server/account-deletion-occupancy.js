'use strict';

// 删除账号前的「运行态占用」探测与强制释放。
//
// 账号删除必须 fail-closed：只要有东西还攥着这个账号的凭据（跑着的会话、tmux 里
// 挂起的持久会话），就拒绝删除，否则会留下用已删凭据继续发请求的进程。但「拒绝」
// 必须**说得出原因**：调用方要能把「谁在占用」如实告诉用户，并在用户确认后按
// 占用者逐个终止，然后重试删除。
//
// 什么算「占用者」：**用户的工作**——正在跑的会话、tmux 里挂起等着被 attach 的
// 会话。终止它们会丢掉用户正在进行的事，所以必须让用户确认。
// 不算占用者的是 aih 自己管理、删号时本来就要拆掉的资源（agy 暖机 LS 池）：
// 那不是「谁占着账号」，而是删除流程自己负责清理的对象，由删除路径直接回收，
// 回收不掉才 fail-closed（见 webui-account-routes-delete.js）。
//
// 各类占用者的终止手段不同，因此这里是**描述符表**而不是 if/else 链：每类占用者
// 声明「怎么探测」与「怎么终止」，新增占用者只加一条描述符。探测与终止都返回
// 结构化结果，绝不吞掉失败——终止不掉就是终止不掉，调用方据此继续 fail-closed。

const persistentSessionRegistry = require('../runtime/persistent-session-registry');
const persistentSession = require('../runtime/persistent-session');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function isMissingTmuxServerProbe(probe) {
  if (!probe || probe.error || probe.status === 0) return false;
  const output = `${probe.stderr || ''}\n${probe.stdout || ''}`.toLowerCase();
  return output.includes('no server running');
}

// 探测某个 tmux socket 上活着的会话名。返回 { status, aliveNames }：
//   alive   —— 探到了服务器与会话列表（aliveNames 是事实）
//   absent  —— 服务器不存在（会话确定已经没了）
//   unknown —— 探针失败/不可用：**必须 fail-closed**，不能当成"没有占用"
function probeTmuxSessions(entry, options = {}) {
  const spawnSync = options.spawnSync || require('child_process').spawnSync;
  const tmux = options.tmux || persistentSession.detectTmux({ spawnSync });
  if (!tmux.available) return { status: 'unknown', aliveNames: new Set() };
  try {
    const listCmd = persistentSession.buildListSessionsCommand({
      cliName: entry.provider,
      runtimeScope: entry.runtimeScope,
      tmuxCommand: tmux.command
    });
    const probe = spawnSync(listCmd.command, listCmd.args, { encoding: 'utf8', timeout: 1500 });
    if (probe && !probe.error && probe.status === 0) {
      return {
        status: 'alive',
        aliveNames: new Set(
          persistentSession.parseSessionList(probe.stdout).map((session) => session.name)
        )
      };
    }
    if (isMissingTmuxServerProbe(probe)) return { status: 'absent', aliveNames: new Set() };
  } catch (_error) { /* 不确定的探针一律 fail-closed */ }
  return { status: 'unknown', aliveNames: new Set() };
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

const PERSISTENT_SESSION = {
  kind: 'persistent_session',
  label: '挂起的持久会话（tmux）',
  async detect(ctx, target) {
    const aiHomeDir = target.aiHomeDir;
    if (!aiHomeDir) return null;
    let entries = [];
    try {
      entries = persistentSessionRegistry.listEntries(aiHomeDir, { fs: ctx.fs, strict: true });
    } catch (_error) {
      // 注册表读不出来本身就是「状态未知」：如实报告并 fail-closed，
      // 不要因为读不到就当成「没有占用」放行删除。
      return {
        items: [{
          kind: this.kind,
          label: this.label,
          session: '',
          socket: '',
          uncertain: true,
          detail: '持久会话注册表不可读'
        }]
      };
    }
    const matching = entries.filter((entry) => (
      entry.provider === target.provider && entry.accountRef === target.accountRef
    ));
    if (matching.length === 0) return null;

    const spawnSync = ctx.spawnSync || require('child_process').spawnSync;
    const tmux = persistentSession.detectTmux({ spawnSync });
    const probeCache = new Map();
    const items = [];
    for (const entry of matching) {
      const socket = entry.socket;
      if (!probeCache.has(socket)) {
        probeCache.set(socket, probeTmuxSessions(entry, { spawnSync, tmux }));
      }
      const probe = probeCache.get(socket);
      const exactAlive = probe.status === 'alive' && probe.aliveNames.has(entry.session);
      // 悬空条目（会话已不在服务器上）不是占用：顺手清掉，别让它反复拦住删除。
      if (probe.status === 'absent' || (probe.status === 'alive' && !exactAlive)) {
        persistentSessionRegistry.removeEntry(aiHomeDir, socket, entry.session, { fs: ctx.fs });
        continue;
      }
      items.push({
        kind: this.kind,
        label: this.label,
        session: entry.session,
        socket,
        runtimeScope: entry.runtimeScope,
        provider: entry.provider,
        uncertain: probe.status === 'unknown',
        cwd: entry.cwd
      });
    }
    return items.length > 0 ? { items } : null;
  },
  async release(ctx, item) {
    // 探针不确定（tmux 不可用/查询失败）时不做破坏性动作：宁可让用户看到��因，
    // 也不要在一个状态未知的 socket 上乱 kill。
    if (item.uncertain) return { released: false, reason: 'persistent_session_state_unknown' };
    const spawnSync = ctx.spawnSync || require('child_process').spawnSync;
    const tmux = persistentSession.detectTmux({ spawnSync });
    if (!tmux.available) return { released: false, reason: 'tmux_unavailable' };
    const cmd = persistentSession.buildKillSessionCommand({
      cliName: item.provider,
      runtimeScope: item.runtimeScope,
      sessionName: item.session,
      tmuxCommand: tmux.command
    });
    if (!cmd) return { released: false, reason: 'unsafe_session_target' };
    try {
      spawnSync(cmd.command, cmd.args, { stdio: 'ignore' });
    } catch (error) {
      return {
        released: false,
        reason: normalizeText(error && error.message) || 'kill_session_spawn_failed'
      };
    }
    // 只认「再探一次确认没了」为成功：kill 命令返回 0 不等于会话真的走了。
    const after = probeTmuxSessions(
      { provider: item.provider, runtimeScope: item.runtimeScope },
      { spawnSync, tmux }
    );
    if (after.status === 'alive' && after.aliveNames.has(item.session)) {
      return { released: false, reason: 'persistent_session_still_alive' };
    }
    if (ctx.aiHomeDir) {
      persistentSessionRegistry.removeEntry(ctx.aiHomeDir, item.socket, item.session, { fs: ctx.fs });
    }
    return { released: true };
  }
};

const OCCUPANT_DESCRIPTORS = [NATIVE_SESSION, PERSISTENT_SESSION];

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
