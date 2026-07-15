'use strict';

// Persistent-launch wrapper: decides whether an interactive provider launch
// should live inside the per-account tmux/psmux server, plans WHICH session it
// lands in (never stealing a live one), wraps the inner {command,args}, keeps
// the on-disk session registry in sync, and reconciles that registry when the
// foreground client exits. Extracted from pty/runtime.js so the PTY runtime
// only orchestrates; all tmux addressing/probing policy lives here.

const persistentSession = require('../../../runtime/persistent-session');
const persistentSessionRegistry = require('../../../runtime/persistent-session-registry');
const { resolveAihRunPath } = require('../../../runtime/aih-storage-layout');

function applyClaudeTmuxRenderCompat(envOverrides = {}, processEnv = {}) {
  if (String(processEnv.AIH_CLAUDE_TMUX_RENDER_COMPAT || '1') === '0') return envOverrides;
  if (!String(envOverrides.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT || '').trim()) {
    envOverrides.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT = '1';
  }
  if (!String(envOverrides.CLAUDE_CODE_FORCE_SYNC_OUTPUT || '').trim()) {
    envOverrides.CLAUDE_CODE_FORCE_SYNC_OUTPUT = '1';
  }
  if (!String(envOverrides.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL || '').trim()) {
    envOverrides.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL = '1';
  }
  envOverrides[persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY] =
    persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE;
  return envOverrides;
}

function createPersistentLaunchWrapper(deps = {}) {
  const {
    fs,
    path,
    processObj,
    spawnSync,
    aiHomeDir,
    resolveCliPath,
    askYesNo,
    resolveWindowsNodeShimLaunch
  } = deps;

  // Tell the user, in one line, what the persistent-session launch is about to do
  // so it is never a silent surprise (especially "second window in the same
  // project opened a parallel session instead of stealing the first").
  function announceSessionPlan(cliName, id, plan, opts = {}) {
    const hasLabel = !!(opts && opts.hasLabel);
    const cyan = (text) => `\x1b[36m[aih]\x1b[0m ${text}`;
    const yellow = (text) => `\x1b[33m[aih]\x1b[0m ${text}`;
    if (plan.action === 'new') {
      console.log(cyan('✦ 新建持久会话（本项目）。Ctrl-b d 挂后台、关终端不丢；翻历史 Ctrl-b [ 、q 退出。'));
    } else if (plan.action === 'reattach') {
      console.log(cyan('↻ 续接到本项目已有的会话。'));
    } else if (plan.action === 'new-parallel') {
      console.log(yellow('⚠ 本项目已有一个会话正在另一个窗口使用 → 已为你新开一个并发会话（原会话不受影响）。'));
      console.log(yellow(`  想接管那个会话改用 -R；查看全部：aih ${cliName} ${id} sessions 。`));
    } else if (plan.action === 'server-cycled') {
      console.log(cyan('♻ 旧的 tmux 服务器（UTF-8 配置不完整）已自动重启，中文显示已修复。'));
    } else if (plan.action === 'new-compatible') {
      console.log(yellow('⚠ 本项目已有会话来自不兼容的旧持久会话运行时 → 已为你新开一个兼容会话（旧会话不受影响）。'));
      console.log(yellow(`  查看或关闭旧会话后重启以彻底使用新运行时：aih ${cliName} ${id} sessions 。`));
    } else if (plan.action === 'new-completed') {
      console.log(yellow('⚠ 本项目已有会话已经结束，无法继续输入 → 已为你新开一个会话。'));
      console.log(yellow(`  查看或关闭旧会话：aih ${cliName} ${id} sessions 。`));
    } else if (plan.action === 'fallback-parallel') {
      console.log(yellow('⚠ 无法确认本项目持久会话状态 → 已为你新开一个并发会话，避免抢占正在运行的会话。'));
      console.log(yellow(`  想接管已有会话改用 -R；查看全部：aih ${cliName} ${id} sessions 。`));
    } else if (plan.action === 'takeover') {
      const where = hasLabel
        ? `命名会话 “${String(plan.session || '').replace(/^s-/, '')}”`
        : '本项目的会话';
      console.log(yellow(`↻ 接管${where}（它正被另一处的窗口 / SSH 客户端占用，那个会被挤下线）。`));
    } else if (plan.action === 'mirror') {
      console.log(cyan('⇄ 镜像并排到本项目的会话：与另一处的窗口同屏，双方都能看、都能操作，谁都不会被挤下线（按 Ctrl-b d 仅离开你这一侧）。'));
    }
  }

  // Optionally run the provider CLI inside a per-account tmux server so the
  // session survives the foreground client and can be re-attached later (e.g.
  // over SSH). Best-effort: on Windows / without tmux this returns `launch`
  // unchanged so behaviour is identical to a plain direct spawn.
  function detectPersistentTmux() {
    return persistentSession.detectTmux({
      platform: processObj.platform,
      env: processObj.env,
      resolveCommandPath: resolveCliPath,
      existsSync: fs.existsSync
    });
  }

  function shouldOfferWindowsPsmuxInstall(tmux, ctx, isTTY) {
    if (!tmux || tmux.available || tmux.reason !== 'windows-no-tmux') return false;
    if (processObj.platform !== 'win32') return false;
    if (ctx.isLogin) return false;
    if (!isTTY) return false;
    if (String(processObj.env[persistentSession.DISABLE_ENV] || '') === '1') return false;
    if (String(processObj.env[persistentSession.MARKER_ENV] || '') === '1') return false;
    if (String(processObj.env.AIH_PSMUX_INSTALL_PROMPT || '1') === '0') return false;
    return typeof askYesNo === 'function';
  }

  function maybeInstallWindowsPsmux(tmux, ctx, isTTY) {
    if (!shouldOfferWindowsPsmuxInstall(tmux, ctx, isTTY)) return tmux;
    const install = persistentSession.buildWindowsPsmuxInstallCommand();
    console.log(`\x1b[33m[aih]\x1b[0m Windows persistent sessions need psmux: ${persistentSession.PSMUX_INSTALL_URL}`);
    console.log(`\x1b[90m[aih]\x1b[0m Install command: ${install.display}`);
    const accepted = askYesNo('未检测到 psmux，是否通过 winget 安装以启用 Windows 持久会话？', false);
    if (!accepted) {
      console.log('\x1b[33m[aih]\x1b[0m 已跳过 psmux 安装，本次使用普通 PTY 启动（会话不会由 psmux 持久化）。');
      return tmux;
    }
    console.log(`\x1b[36m[aih]\x1b[0m Installing psmux via winget...`);
    const result = persistentSession.installWindowsPsmux({ spawnSync, stdio: 'inherit' });
    if (!result.ok) {
      const status = result.status == null ? '' : ` (exit ${result.status})`;
      console.error(`\x1b[33m[aih]\x1b[0m psmux install failed: ${result.reason}${status}.`);
      console.error(`\x1b[90m[aih]\x1b[0m Manual install: ${install.display}  or see ${persistentSession.PSMUX_INSTALL_URL}`);
      return tmux;
    }
    const refreshed = detectPersistentTmux();
    if (refreshed.available) {
      console.log(`\x1b[36m[aih]\x1b[0m psmux installed and detected: ${refreshed.command}`);
      return refreshed;
    }
    console.error('\x1b[33m[aih]\x1b[0m winget finished, but psmux is still not visible to this process.');
    console.error('\x1b[90m[aih]\x1b[0m Open a new terminal or ensure WinGet Links is in PATH, then retry.');
    return refreshed;
  }

  function isNoServerSessionProbe(probe) {
    const stderr = String((probe && probe.stderr) || '');
    return /no server running|No such file or directory|error connecting to|failed to connect/i.test(stderr);
  }

  function isTrustedSessionProbe(probe) {
    if (!probe || probe.error) return false;
    if (probe.status === 0) return true;
    return isNoServerSessionProbe(probe);
  }

  function fallbackParallelPlan(baseSession) {
    return {
      session: persistentSession.deriveFallbackParallelSessionName(baseSession, {
        now: Date.now(),
        pid: processObj.pid
      }),
      action: 'fallback-parallel'
    };
  }

  function runTmuxEnvironmentSync(tmux, ctx, sessionName = '') {
    const commands = persistentSession.buildSetEnvironmentCommands({
      cliName: ctx.cliName,
      runtimeScope: ctx.runtimeScope,
      tmuxCommand: tmux.command,
      env: ctx.envOverrides,
      sessionName
    });
    for (const cmd of commands) {
      try {
        spawnSync(cmd.command, cmd.args, {
          stdio: 'ignore',
          env: ctx.envOverrides
        });
      } catch (_error) {}
    }
  }

  function enrichNativeWindowsPsmuxSessions(tmux, ctx, sessions) {
    if (!persistentSession.isNativeWindowsPsmuxCommand(tmux && tmux.command, processObj.platform)) {
      return sessions;
    }
    return (Array.isArray(sessions) ? sessions : []).map((session) => {
      if (!session || !persistentSession.isSafeSessionName(session.name)) return session;
      if (session.paneDeadChecked && session.paneDead) return session;
      const cmd = persistentSession.buildCapturePaneCommand({
        cliName: ctx.cliName,
        runtimeScope: ctx.runtimeScope,
        tmuxCommand: tmux.command,
        sessionName: session.name,
        start: -80
      });
      if (!cmd) return session;
      try {
        const res = spawnSync(cmd.command, cmd.args, {
          encoding: 'utf8',
          env: ctx.envOverrides
        });
        if (!res || res.error || res.status !== 0) return session;
        return {
          ...session,
          screenCompletedChecked: true,
          screenCompleted: persistentSession.isCompletedSessionScreen(res.stdout)
        };
      } catch (_error) {
        return session;
      }
    });
  }

  function isWindowsCmdWrapperLaunch(launch) {
    if (processObj.platform !== 'win32') return false;
    const command = String(launch && launch.command || '').trim();
    const baseName = path.win32.basename(command).toLowerCase();
    return baseName === 'cmd.exe' || baseName === 'cmd';
  }

  function prepareNativeWindowsPsmuxCodexLaunch(launch, ctx) {
    if (ctx.cliName !== 'codex' || ctx.isLogin) {
      return { ok: true, launch, marker: false };
    }
    if (!isWindowsCmdWrapperLaunch(launch)) {
      return { ok: true, launch, marker: true };
    }
    if (typeof resolveWindowsNodeShimLaunch !== 'function') {
      console.error('\x1b[33m[aih]\x1b[0m Windows psmux Codex 持久会话无法解析 npm/pnpm .cmd shim，本次退回普通 PTY，避免创建不可输入的 psmux pane。');
      return { ok: false, launch };
    }
    const directLaunch = resolveWindowsNodeShimLaunch(ctx.cliBin || ctx.cliName, ctx.argsToRun || [], {
      platform: processObj.platform,
      fsImpl: fs,
      env: ctx.envOverrides,
      nodeExecPath: processObj.execPath
    });
    if (!directLaunch || !directLaunch.command) {
      console.error('\x1b[33m[aih]\x1b[0m Windows psmux Codex 持久会话无法绕过 .cmd shim，本次退回普通 PTY，避免创建不可输入的 psmux pane。');
      return { ok: false, launch };
    }
    Object.assign(ctx.envOverrides, directLaunch.envPatch || {});
    return {
      ok: true,
      marker: true,
      launch: {
        command: directLaunch.command,
        args: directLaunch.args
      }
    };
  }

  // Last persistent wrap of this process — used for best-effort registry
  // hygiene when the foreground client exits (see reconcileRegistryAfterExit).
  let lastPersistentWrap = null;

  // When the tmux client exits, reconcile the registry against the live server
  // so entries for sessions the user actually CLOSED are dropped immediately.
  // Detach (Ctrl-b d) keeps the session alive → entry stays. If the whole
  // server is gone (last session ended), every entry on that socket is stale.
  function reconcileRegistryAfterExit() {
    const wrap = lastPersistentWrap;
    if (!wrap) return;
    try {
      const listCmd = persistentSession.buildListSessionsCommand({
        cliName: wrap.cliName,
        runtimeScope: wrap.runtimeScope,
        tmuxCommand: wrap.tmuxCommand
      });
      const probe = spawnSync(listCmd.command, listCmd.args, { encoding: 'utf8' });
      if (!isTrustedSessionProbe(probe)) return;
      if (isNoServerSessionProbe(probe)) {
        persistentSessionRegistry.removeEntriesForSocket(aiHomeDir, wrap.socket, { fs });
        return;
      }
      const aliveNames = new Set(
        persistentSession.parseSessionList(probe && probe.stdout).map((s) => s.name)
      );
      for (const entry of persistentSessionRegistry.listEntries(aiHomeDir, { fs })) {
        if (entry.socket !== wrap.socket) continue;
        if (!aliveNames.has(entry.session)) {
          persistentSessionRegistry.removeEntry(aiHomeDir, entry.socket, entry.session, { fs });
        }
      }
    } catch (_error) {}
  }

  function maybeWrapPersistentLaunch(launch, ctx) {
    try {
      const isTTY = !!(processObj.stdout && processObj.stdout.isTTY);
      // Restore children run headless (no TTY) but MUST still wrap into tmux —
      // creating the detached session is their whole purpose.
      const detachedRestore = String(processObj.env[persistentSession.DETACHED_ENV] || '') === '1';
      const tmux = maybeInstallWindowsPsmux(detectPersistentTmux(), ctx, isTTY);
      const enabled = persistentSession.shouldPersist({
        tmux,
        isLogin: ctx.isLogin,
        isTTY: isTTY || detachedRestore,
        env: processObj.env
      });
      if (String(processObj.env.AIH_DEBUG_PERSIST || '') === '1') {
        console.error(`[persist-debug] ${JSON.stringify({ enabled, tmuxAvailable: tmux.available, tmuxReason: tmux.reason, isTTY, detachedRestore, isLogin: ctx.isLogin, marker: processObj.env[persistentSession.MARKER_ENV] || '' })}`);
      }
      if (!enabled) return launch;
      if (ctx.cliName === 'claude' && !ctx.isLogin) {
        applyClaudeTmuxRenderCompat(ctx.envOverrides, processObj.env);
      }

      const confPath = resolveAihRunPath(aiHomeDir, 'tmux', 'tmux.conf');
      const resolvedConf = persistentSession.ensureTmuxConf(confPath, fs, {
        tmuxCommand: tmux.command,
        platform: processObj.platform
      });
      runTmuxEnvironmentSync(tmux, ctx);
      const sourceConfigCmd = persistentSession.buildSourceConfigCommand({
        cliName: ctx.cliName,
        runtimeScope: ctx.runtimeScope,
        tmuxCommand: tmux.command,
        confPath: resolvedConf
      });
      if (sourceConfigCmd) {
        try {
          spawnSync(sourceConfigCmd.command, sourceConfigCmd.args, {
            stdio: 'ignore',
            env: ctx.envOverrides
          });
        } catch (_error) {}
      }

      // Decide which session to land in — and tell the user, so it's never a
      // silent surprise (a second window in the same project must not steal the
      // first window's live session). Probe the account's live sessions, then
      // pick: reattach a detached one, or open a parallel session if one is live.
      const cwd = processObj.cwd();
      const label = processObj.env[persistentSession.SESSION_ENV];
      // -R/--aih-resume: take over THIS project's session even if a client is still
      // attached elsewhere (the cross-machine "grab my session back" case). It
      // targets the exact base session like a named one, so attached → takeover.
      const resume = String(processObj.env[persistentSession.RESUME_ENV] || '') === '1';
      // -M/--aih-mirror: attach to THIS project's session SHARED — both windows
      // mirror the same session, neither is kicked (cross-machine screen share).
      const mirror = String(processObj.env[persistentSession.MIRROR_ENV] || '') === '1';
      const rawTargetSession = String(processObj.env[persistentSession.TARGET_ENV] || '').trim();
      const targetSession = persistentSession.isSafeSessionName(rawTargetSession) ? rawTargetSession : '';
      const nativeWindowsPsmux = persistentSession.isNativeWindowsPsmuxCommand(tmux.command, processObj.platform);
      let persistentInnerLaunch = launch;
      let requirePsmuxCodexLaunchRuntime = false;
      if (nativeWindowsPsmux) {
        const prepared = prepareNativeWindowsPsmuxCodexLaunch(launch, ctx);
        if (!prepared.ok) return launch;
        persistentInnerLaunch = prepared.launch;
        if (prepared.marker) {
          ctx.envOverrides[persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_KEY] =
            persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE;
          requirePsmuxCodexLaunchRuntime = ctx.cliName === 'codex';
        }
      }
      const shareTarget = (mirror || !!targetSession) && !nativeWindowsPsmux;
      const exactTarget = !!targetSession || !!label || resume || mirror;
      const baseSession = targetSession || persistentSession.deriveSessionName({ cwd, label });
      let plannedSession = baseSession;
      let plannedAction = 'new';
      let trustedPlan = false;
      let probedSessions = [];
      try {
        const listCmd = persistentSession.buildListSessionsCommand({
          cliName: ctx.cliName,
          runtimeScope: ctx.runtimeScope,
          tmuxCommand: tmux.command
        });
        const probe = spawnSync(listCmd.command, listCmd.args, {
          encoding: 'utf8',
          env: ctx.envOverrides
        });
        if (!isTrustedSessionProbe(probe)) throw new Error('persistent session probe failed');
        const sessions = enrichNativeWindowsPsmuxSessions(
          tmux,
          ctx,
          persistentSession.parseSessionList(probe && probe.stdout)
        );
        probedSessions = sessions;
        let plan = persistentSession.planPersistentSession(sessions, baseSession, {
          hasLabel: exactTarget,
          share: shareTarget,
          requireUtf8Runtime: true,
          requireClaudeRenderRuntime: ctx.cliName === 'claude' && !ctx.isLogin,
          requirePsmuxCodexLaunchRuntime
        });
        // Server-locale fix: when every probed session predates the UTF-8 runtime
        // marker AND none of them are currently attached, the tmux server was most
        // likely started before the locale fix landed. On tmux < 3.0, the server
        // process owns the setlocale() call used by wcwidth(), so stale-locale
        // servers render CJK characters at wrong column widths even when the
        // session env carries LANG=zh_CN.UTF-8. Cycling (kill-server) forces a
        // fresh server that inherits the correct locale from our envOverrides.
        if (plan.action === 'new-compatible' && sessions.length > 0) {
          const hasAttachedSessions = sessions.some((s) => s.attached);
          if (!hasAttachedSessions) {
            const killCmd = persistentSession.buildKillServerCommand({
              cliName: ctx.cliName,
              runtimeScope: ctx.runtimeScope,
              tmuxCommand: tmux.command
            });
            try {
              spawnSync(killCmd.command, killCmd.args, {
                stdio: 'ignore',
                env: ctx.envOverrides
              });
              plan = { session: baseSession, action: 'server-cycled' };
            } catch (_killError) {}
          }
        }
        plannedSession = plan.session;
        plannedAction = plan.action;
        trustedPlan = true;
        announceSessionPlan(ctx.cliName, ctx.cliAccountId, plan, { hasLabel: !!label || !!targetSession, resume, mirror: shareTarget });
      } catch (_probeError) {
        if (!exactTarget) {
          const plan = fallbackParallelPlan(baseSession);
          plannedSession = plan.session;
          plannedAction = plan.action;
          announceSessionPlan(ctx.cliName, ctx.cliAccountId, plan);
        }
      }
      runTmuxEnvironmentSync(tmux, ctx, plannedSession);
      if (nativeWindowsPsmux && ['takeover', 'mirror'].includes(plannedAction)) {
        const detachCmd = persistentSession.buildDetachClientCommand({
          cliName: ctx.cliName,
          runtimeScope: ctx.runtimeScope,
          tmuxCommand: tmux.command,
          sessionName: plannedSession
        });
        if (detachCmd) {
          try {
            spawnSync(detachCmd.command, detachCmd.args, {
              stdio: 'ignore',
              env: ctx.envOverrides
            });
          } catch (_error) {}
        }
      }

      const wrapped = persistentSession.buildTmuxLaunch(persistentInnerLaunch, {
        cliName: ctx.cliName,
        runtimeScope: ctx.runtimeScope,
        cwd,
        label,
        sessionName: plannedSession,
        share: shareTarget,
        detached: detachedRestore,
        explicitAttach: !detachedRestore && nativeWindowsPsmux && (trustedPlan || plannedAction === 'fallback-parallel'),
        attachExisting: !detachedRestore && ['reattach', 'takeover', 'mirror'].includes(plannedAction),
        detachOnAttach: !nativeWindowsPsmux,
        tmuxCommand: tmux.command,
        confPath: resolvedConf,
        env: ctx.envOverrides
      });
      // Registry ("RDB"): record every persistent session on disk so a reboot
      // can rebuild it. Written on every launch — new sessions get an entry,
      // reattach/takeover/mirror refresh updatedAt (= last confirmed alive).
      // When attaching to an EXISTING session, keep its original project dir
      // (from the probe) — a mirror opened from another directory must not
      // repoint where a future restore would recreate the session.
      try {
        const attachingExisting = ['reattach', 'takeover', 'mirror'].includes(plannedAction);
        const probedSession = attachingExisting
          ? probedSessions.find((s) => s.name === wrapped.session)
          : null;
        // Prefer the session's LAUNCH directory over the pane's current cwd:
        // a restore must land in the project root even if the user cd'd away.
        const probedPath = probedSession
          ? String(probedSession.startPath || probedSession.path || '').trim()
          : '';
        persistentSessionRegistry.writeEntry(aiHomeDir, {
          provider: ctx.cliName,
          runtimeScope: ctx.runtimeScope,
          gateway: ctx.gateway === true,
          accountRef: ctx.accountRef,
          socket: wrapped.socket,
          session: wrapped.session,
          cwd: probedPath || cwd,
          label: String(label || '').trim(),
          forwardArgs: Array.isArray(ctx.argsToRun) ? ctx.argsToRun : []
        }, { fs });
      } catch (_registryError) {}
      lastPersistentWrap = {
        socket: wrapped.socket,
        session: wrapped.session,
        cliName: ctx.cliName,
        runtimeScope: ctx.runtimeScope,
        tmuxCommand: tmux.command
      };
      // Mark the inner environment so the CLI (or any nested aih) does not try
      // to wrap a second time.
      ctx.envOverrides[persistentSession.MARKER_ENV] = '1';
      return wrapped;
    } catch (_error) {
      return launch;
    }
  }

  return {
    maybeWrapPersistentLaunch,
    reconcileRegistryAfterExit
  };
}

module.exports = {
  applyClaudeTmuxRenderCompat,
  createPersistentLaunchWrapper
};
