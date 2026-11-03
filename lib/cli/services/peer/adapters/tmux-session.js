'use strict';

// aih peer 的 **注入通道**：没有本机跨会话协议的 harness，由 aih 代打一行字。
//
// 这些 harness（codebuddy 家族、codex、gemini、…）在 aih 下都跑在 tmux 的持久会话里，
// 所以「发消息」等价于往那个 pane 的输入框里输入正文 + Enter——效果与用户手打一致：
// 收件方把它当成一条普通用户轮次。代价是它属于「注入」而不是协议：没有消息 id、没有
// 已读/挂起语义，也绕不过对方的权限确认（这点和多 agent 协作的规矩一致）。
//
// codebuddy 家族其实另有服务端 teammate/channel，但那是账号侧的服务端接口，本机没有
// 可复用的 socket，所以这里统一走注入。

const nodeFs = require('node:fs');
const persistentSession = require('../../../../runtime/persistent-session');
const { normalizeUtf8LocaleEnv } = require('../../ai-cli/provider-runtime-env');
const { waitForQuiet } = require('../idle');

// 单次 tmux 探测的上限：peer 的补投 tick 跑在 server 主进程里，卡住一次就是卡住整个
// server。tmux display-message 正常是几毫秒，1.5s 已经是异常上限。
const ACTIVITY_PROBE_TIMEOUT_MS = 1_500;

function defaultCollectRows(options) {
  // 只在真要列会话时才加载 persistent-session-list（它连带 tmux/账号扫描，比较重）。
  const { collectGlobalPersistentSessionRows } = require('../../ai-cli/persistent-session-list');
  return collectGlobalPersistentSessionRows(options);
}

/** 读单个 pane 的 `#{window_activity}`（秒 → 毫秒）。读不到返回 0（未知，不猜忙）。 */
function readWindowActivity(options = {}) {
  let command = null;
  try {
    command = persistentSession.buildWindowActivityCommand({
      tmuxCommand: options.tmuxCommand,
      cliName: options.cliName,
      runtimeScope: options.runtimeScope,
      sessionName: options.sessionName
    });
  } catch (_error) {
    return 0;
  }
  if (!command) return 0;
  let result;
  try {
    result = options.spawnSyncImpl(command.command, command.args, {
      encoding: 'utf8',
      env: options.env,
      timeout: ACTIVITY_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (_error) {
    return 0;
  }
  if (!result || result.status !== 0) return 0;
  const seconds = Number(String(result.stdout || '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function createTmuxSessionAdapter(deps = {}) {
  const spawnSyncImpl = deps.spawnSync || require('node:child_process').spawnSync;
  const resolveCommandPath = deps.resolveCommandPath || deps.resolveCliPath
    || require('../../../../runtime/platform-runtime').resolveCliPath;
  const fsImpl = deps.fs || nodeFs;
  const collectRows = deps.collectRows || defaultCollectRows;

  return {
    id: 'session',
    channel: 'inject',

    /** aih 管的所有持久会话（跨 provider、跨账号），失败返回空数组。 */
    listSessions(options = {}) {
      let summary;
      try {
        summary = collectRows({
          aiHomeDir: options.aiHomeDir,
          hostHomeDir: options.hostHomeDir,
          providers: options.providers,
          skipAgentTitles: true,
          // 注册表快速路径只覆盖「已经进过注册表」的账号。peer 是要发消息的：
          // 刚起的会话（还没写注册表）和冷门账号都得能看见，所以这里全量扫。
          forceFullSessionScan: true,
          processImpl: options.processImpl || process,
          fs: fsImpl
        });
      } catch (_error) {
        return [];
      }
      const rows = Array.isArray(summary && summary.rows) ? summary.rows : [];
      // 顺手把结果写进 TAB 用的缓存：注册表是「起过会话」才写的，刚起的会话
      // 在补全里只能靠这份缓存认出来（见 complete/persistent-candidates.js）。
      if (rows.length && options.aiHomeDir) {
        try {
          require('../../../../runtime/persistent-session-cache').write(options.aiHomeDir, rows, { fs: fsImpl });
        } catch (_error) { /* 缓存写失败不影响本次结果 */ }
      }
      return rows;
    },

    /**
     * 把 text 打进 row 对应的 pane。返回 { ok, channel, commands }；
     * 失败时带 error + message，调用方直接展示。
     *
     * 投递前先等一小段安静期（`options.quietMs` / `options.timeoutMs`）：
     * TUI 正在重绘时打字会被吞或和半截输出粘在一起。等不到就返回 target_busy，
     * 由上层留在收件箱里交给补投 tick——宁可晚一点，也不在忙碌中打扰。
     */
    async send(row, text, options = {}) {
      const cliName = String(row && row.cliName || '').trim();
      const runtimeScope = String(row && row.runtimeScope || '').trim();
      const sessionName = String(row && (row.targetSession || row.name) || '').trim();
      if (!cliName || !runtimeScope || !sessionName) {
        return { ok: false, error: 'missing_session_target', message: '缺少可注入的会话目标。' };
      }
      if (row.completed) {
        return {
          ok: false,
          error: 'session_completed',
          message: `会话 ${sessionName} 已经结束，注入没有意义；用 aih ss 进入一个活着的会话。`
        };
      }

      const env = normalizeUtf8LocaleEnv(options.env || process.env, {
        platform: (options.processImpl && options.processImpl.platform) || process.platform
      });
      const tmux = persistentSession.detectTmux({
        platform: (options.processImpl && options.processImpl.platform) || process.platform,
        env,
        resolveCommandPath,
        existsSync: fsImpl.existsSync
      });
      if (!tmux.available) {
        return {
          ok: false,
          error: 'tmux_unavailable',
          message: `注入需要 tmux：${tmux.remediation || 'tmux not found on PATH.'}`
        };
      }

      // **不能**拿列表里的 lastActivityAt 判「已经安静」：那是扫描时的快照，而全量
      // 扫描本身可能耗时数秒——快照到投递之间 pane 可能一直在输出。按快照算会把
      // 正在跑回合的会话误判成空闲，正文直接打进 TUI（真机踩过：目标在跑 while 循环
      // 仍被判 idle，消息被塞进忙碌的 pane）。判安静只能现场探测；只有 dryRun /
      // 明确不等安静期时才跳过。
      const quiet = options.dryRun === true || options.waitForQuiet === false
        ? { quiet: true, lastActivityAt: Number(row && row.lastActivityAt) || 0, waitedMs: 0 }
        : await waitForQuiet({
          quietMs: options.quietMs,
          timeoutMs: options.timeoutMs,
          pollMs: options.pollMs,
          sleep: options.sleep,
          now: options.now,
          readActivityAt: options.readActivityAt || (() => readWindowActivity({
            tmuxCommand: tmux.command,
            cliName,
            runtimeScope,
            sessionName,
            env,
            spawnSyncImpl
          }))
        });
      if (!quiet.quiet) {
        return {
          ok: false,
          error: 'target_busy',
          retryAfterMs: 0,
          lastActivityAt: quiet.lastActivityAt,
          message: `会话 ${sessionName} 正在跑回合（pane 持续有输出），消息先留在收件箱，空闲后自动投递。`
        };
      }

      let commands = [];
      try {
        commands = persistentSession.buildSendKeysCommands({
          cliName,
          runtimeScope,
          sessionName,
          text,
          tmuxCommand: tmux.command,
          appendNewline: options.appendNewline !== false
        });
      } catch (_error) {
        // runtimeScope 不合法（旧消息里存了个坏值）时 deriveSocket 会抛，不能让它
        // 把整条补投链路带崩——当成「目标不安全」处理。
        return { ok: false, error: 'unsafe_session_target', message: '会话目标参数不合法，已拒绝注入。' };
      }
      if (!commands.length) {
        return { ok: false, error: 'unsafe_session_target', message: '会话目标名称不安全，已拒绝注入。' };
      }
      if (options.dryRun) {
        return {
          ok: true,
          channel: 'inject',
          dryRun: true,
          commands: commands.map((cmd) => [cmd.command, ...cmd.args].join(' '))
        };
      }

      for (const cmd of commands) {
        let result;
        try {
          result = spawnSyncImpl(cmd.command, cmd.args, {
            stdio: 'ignore',
            env,
            timeout: ACTIVITY_PROBE_TIMEOUT_MS
          });
        } catch (error) {
          return {
            ok: false,
            error: 'send_keys_failed',
            message: `注入 ${sessionName} 失败：${String(error && error.message || error)}`
          };
        }
        const status = result && Number.isInteger(result.status) ? result.status : 0;
        if (status !== 0) {
          return {
            ok: false,
            error: 'send_keys_failed',
            status,
            message: `注入 ${sessionName} 失败（exit ${status}）。`
          };
        }
      }
      return { ok: true, channel: 'inject', session: sessionName, socket: commands[0].socket };
    },

    /**
     * 单目标探测：只问这一个 pane 的最后输出时刻，**不做全量会话扫描**。
     *
     * 补投 tick 每 3s 跑一次，用 `listSessions` 会把账号目录和所有 tmux socket
     * 全扫一遍——那是「扫描卡死事件循环」事故的同款形状。这里只发一条
     * `tmux display-message`，带 1.5s 超时。
     */
    probe(target, options = {}) {
      const cliName = String(target && target.cliName || '').trim();
      const runtimeScope = String(target && target.runtimeScope || '').trim();
      const sessionName = String(target && (target.sessionName || target.session || target.name) || '').trim();
      if (!cliName || !runtimeScope || !sessionName) return { ok: false, error: 'missing_session_target' };
      const env = normalizeUtf8LocaleEnv(options.env || process.env, {
        platform: (options.processImpl && options.processImpl.platform) || process.platform
      });
      const tmux = persistentSession.detectTmux({
        platform: (options.processImpl && options.processImpl.platform) || process.platform,
        env,
        resolveCommandPath,
        existsSync: fsImpl.existsSync
      });
      if (!tmux.available) return { ok: false, error: 'tmux_unavailable' };
      const lastActivityAt = readWindowActivity({
        tmuxCommand: tmux.command,
        cliName,
        runtimeScope,
        sessionName,
        env,
        spawnSyncImpl
      });
      // 0 = 查不到活动时间（会话没了 / 旧版 tmux）。交给调用方按「未知」处理，
      // 真投不进去时 send-keys 会给出权威失败。
      return { ok: true, alive: true, lastActivityAt };
    }
  };
}

module.exports = { createTmuxSessionAdapter, readWindowActivity, ACTIVITY_PROBE_TIMEOUT_MS };
