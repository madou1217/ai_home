'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveNativeCliPath } = require('../runtime/native-cli-resolver');
const {
  resolveProviderCliPath,
  installNativeCliWithProgress,
  buildCliNotFoundMessage
} = require('../cli/services/ai-cli/ensure-native-cli');
const { loadNodePty, withPlatformPtyOptions } = require('../runtime/node-pty-loader');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../runtime/pty-launch');
const {
  buildHostPathLookupVariants
} = require('../runtime/windows-path-encoding');
const { readAccountCredentials } = require('./account-credential-store');
const { captureProviderAuth } = require('../account/native-auth-projection');
const {
  buildClaudeAccountRelayEnv,
  shouldRelayClaudeAccount
} = require('../cli/services/ai-cli/claude-account-relay');
const { buildAihServerProfileEnv } = require('../account/self-relay-account');
const { readServerConfig } = require('./server-config-store');
const {
  resolveRuntimeTarget,
  serializeRuntimeTarget
} = require('../account/runtime-target');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime,
  resolveProviderRuntimeScope
} = require('../cli/services/ai-cli/provider-runtime-env');
const { reconcileProviderResources } = require('../runtime/provider-resource-reconciliation');
const {
  createTransientAuthProjectionLease
} = require('../runtime/transient-auth-projection');
const {
  buildCodexProviderArgs,
  injectCodexProviderArgs
} = require('../cli/services/ai-cli/codex-provider-args');
const {
  socketForRun,
  buildRunShellCommand,
  buildInnerCommandFromArgv,
  spawnDetachedTmuxRun,
  cleanupRunSocket
} = require('./native-run-tmux');
const { createTmuxRunChild } = require('./native-run-tmux-child');
const {
  runLogPath,
  writeRunManifest,
  updateRunManifest,
  removeRunManifest
} = require('./native-run-manifest');
const { createInteractivePromptDetector } = require('./native-interactive-prompts');
const {
  normalizeApprovalMode,
  approvalModeNeedsBridge,
  claudeApprovalArgs,
  grokApprovalArgs,
  buildClaudeApprovalMcpConfig
} = require('./native-approval-modes');
const { ACCOUNT_RUNTIME_CHANGED } = require('./account-runtime-event-types');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const {
  readSessionMessages,
  resolveSessionFilePath,
  getRealHome
} = require('../sessions/session-reader');
const { readGrokTurnState } = require('../sessions/grok-session-store');
const {
  buildAuthInvalidRuntimeState
} = require('../account/runtime-state-builders');
const { detectIdentityKind } = require('../account/account-identity');
const { isApiCredentialAuthMode } = require('../account/runtime-auth-mode');
const agyWarmPool = require('./agy-warm-ls-pool');
const {
  mapClaudeApiRetry,
  mapOpenCodeRetryPart
} = require('./native-retry-status');
const { createNativeRunWatchdog } = require('./native-run-watchdog');

const { DEFAULT_LOCAL_CLAUDE_PACKAGE_PATH, DEFAULT_NATIVE_STREAM_COLS, DEFAULT_NATIVE_STREAM_ROWS, PTY_SUBMIT_DELAY_MS, OFFICIAL_NATIVE_SESSION_PROVIDERS, IGNORED_NATIVE_STREAM_EVENT, OPENCODE_NON_TERMINAL_STEP_REASONS, normalizeString, CLAUDE_IMAGE_MEDIA_TYPES, TMUX_RUN_PROVIDERS, CODEX_HEADLESS_EXEC_ARGS } = require('./native-session-chat-utils');
const { buildPtyInputChunks, writePtyInput } = require('./native-session-chat-pty');
const { stripAnsi, sanitizeTerminalText, classifyNativeSessionFailure, classifyNativeAccountRuntimeBlocker, recordNativeAccountRuntimeBlocker, buildNativeAccountRuntimeBaseState, hasActiveNativeAccountRuntimeBlock, recordNativeAccountRuntimeSuccess, shouldScanNativeRuntimeBlockerOutput } = require('./native-session-chat-failure');
const { getSessionFileMtime, normalizeSearchText, readFilePreview, listClaudeProjectSessionFiles, walkFiles, listCodexSessionFiles, listCodexStateDbFiles, inferCodexSessionIdFromStateDb, inferClaudeCreatedSessionId, readGeminiSessionIdFromFile, listGeminiSessionFiles, listAgySessionFiles, listProviderSessionFiles, inferCreatedSessionId } = require('./native-session-chat-sessions');
const { loadAccountEnv, loadProviderAccountEnv, resolveNativeProviderRuntime, buildProviderEnv } = require('./native-session-chat-env');
const { isOfficialNativeSessionProvider, pushClaudeHeadlessStreamArgs, detectImageMediaType, buildClaudeStreamJsonUserMessage, claudeUsesStreamJsonInput, shellSingleQuote, resolveNativeRunMultiplexer, resolveRunsAiHomeDir, buildResumeCommand, buildStartCommand, applyProviderConfigDirArgs } = require('./native-session-chat-command');
const { resolveNativeCliLaunch, ensureNativeCliReadyForChat } = require('./native-session-chat-launch');
const { computeDelta, extractClaudeAssistantText, codexItemToTool, parseNativeStreamEvent } = require('./native-session-chat-stream');
const { waitForSessionUpdate, collectAssistantReply, hasAssistantAddition, buildSessionReaderOptions } = require('./native-session-chat-transcript');
const { startAgyWarmResume, startAgyColdAfterQuiesce, agySessionProjectIndexPath, readAgySessionProjectIndex, resolveAgyProjectId } = require('./native-session-chat-agy');
const { deriveCodexThreadName, ensureCodexSessionIndexEntry } = require('./native-session-chat-codex-index');
function spawnNativeSessionStream(options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const runtimeTarget = resolveRuntimeTarget(options);
  const accountRef = runtimeTarget ? runtimeTarget.accountRef : '';
  const gateway = Boolean(runtimeTarget && runtimeTarget.gateway);
  const prompt = String(options.prompt || '');
  const initialInput = String(options.initialInput || '');
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const projectPath = normalizeString(options.projectPath) || process.cwd();
  const requestedSessionId = normalizeString(options.sessionId);
  const generatedSessionId = !requestedSessionId && ['gemini', 'claude', 'grok', 'qoder', 'qodercn'].includes(provider)
    ? (typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `native-session-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    : '';
  const sessionParams = {
    sessionId: requestedSessionId || generatedSessionId,
    projectDirName: normalizeString(options.projectDirName)
  };
  const isResume = Boolean(requestedSessionId);
  const interactiveCli = !!options.interactiveCli;
  const getProfileDir = options.getProfileDir;
  // gemini 的 resume 走 `--session-file`，实际行为是 fork 出一个 import 了原会话历史的
  // 【新】会话（新 sessionId、同 projectHash），本轮回复落在新文件、而非被 resume 的旧文件
  // （gemini CLI 不会向 --session-file 指向的旧文件追加）。因此 gemini resume 要像 create
  // 一样处理：记录运行前的会话集合，运行后用 inferCreatedSessionId 推断并采纳这个新会话，
  // 否则 WebUI 一直盯着旧 sessionId 的 transcript → 永远等不到更新 → 120s 超时卡“正在连接”。
  const geminiSessionFileResume = provider === 'gemini' && isResume;

  if (!isOfficialNativeSessionProvider(provider)) {
    const error = new Error('native_session_start_unsupported');
    error.code = 'native_session_start_unsupported';
    throw error;
  }
  if (!provider || !runtimeTarget || typeof getProfileDir !== 'function') {
    const error = new Error('native_session_invalid_context');
    error.code = 'native_session_invalid_context';
    throw error;
  }

  const projectionDir = getProfileDir(provider, accountRef, { gateway });
  if (!projectionDir) {
    const error = new Error('native_session_runtime_unavailable');
    error.code = 'native_session_invalid_context';
    throw error;
  }
  let runtime = resolveNativeProviderRuntime(provider, projectionDir, options.env || process.env, {
    accountRef,
    aiHomeDir: options.aiHomeDir,
    gateway
  });
  let runtimeDir = runtime.runtimeDir;
  const transientAuthProjection = provider === 'codex'
    && runtime.projectionRequired
    && !gateway;
  const transientProjectionLease = transientAuthProjection
    ? createTransientAuthProjectionLease(fs, provider, accountRef, { path })
    : null;
  if (transientProjectionLease) {
    runtimeDir = transientProjectionLease.runtimeDir;
    runtime = { ...runtime, runtimeDir };
  }
  const cleanupTransientAuthProjection = () => transientProjectionLease?.release();
  const reconcileRuntimeResources = () => reconcileProviderResources(
    options.ensureSessionStoreLinks,
    provider,
    accountRef,
    { projectionRoot: runtimeDir }
  );
  const agyWriterLease = options.__agyWriterLease || null;
  let providerResourcesReconciled = options.__providerResourcesReconciled === true;
  const canReconcileImmediately = provider !== 'agy'
    || (!agyWriterLease && !agyWarmPool.hasWriter(accountRef));
  if (!gateway && runtime.projectionRequired && !providerResourcesReconciled && canReconcileImmediately) {
    try {
      reconcileRuntimeResources();
    } catch (error) {
      cleanupTransientAuthProjection();
      throw error;
    }
    providerResourcesReconciled = true;
  }
  const sessionReaderOptions = buildSessionReaderOptions({ ...options, accountRef });
  const sessionPath = sessionParams.sessionId
    ? resolveSessionFilePath(provider, sessionParams, sessionReaderOptions)
    : '';
  const beforeMessages = sessionParams.sessionId
    ? readSessionMessages(provider, sessionParams, sessionReaderOptions)
    : [];
  const beforeMtime = getSessionFileMtime(sessionPath);
  let env;
  try {
    env = buildProviderEnv(provider, runtimeDir, options.env, {
      accountRef,
      aiHomeDir: options.aiHomeDir,
      gateway,
      runtimeScope: runtime
    });
  } catch (error) {
    cleanupTransientAuthProjection();
    throw error;
  }
  let launch;
  try {
    launch = resolveNativeCliLaunch(provider, {
      claudeCliJsPath: options.claudeCliJsPath,
      env
    });
  } catch (error) {
    cleanupTransientAuthProjection();
    throw error;
  }
  const command = isResume ? buildResumeCommand : buildStartCommand;
  let { args } = command(provider, {
    sessionId: sessionParams.sessionId,
    prompt,
    imagePaths,
    model: options.model,
    interactiveCli,
    projectPath
  });
  args = applyProviderConfigDirArgs(provider, args, runtimeDir);
  if (provider === 'codex') {
    args = injectCodexProviderArgs(
      args,
      buildCodexProviderArgs(env, { force: gateway })
    );
  }

  // agy 快路径：该账号已有暖机 LS 时，resume 轮次直接走 agentapi send-message（~3-4s），
  // 跳过 ~100s 冷启动。冷启动只发生在新建会话、或暖机 LS 不存在/已失效的首轮。
  // 模型一致性 gate：send-message 无法携带模型,暖机 LS 粘住启动模型——请求换模型的
  // 轮次必须绕过暖机走冷启动(带 --model),否则 WebUI 切模型永远不生效。
  const hasAgyWarmWriter = provider === 'agy' && agyWarmPool.hasWarm(accountRef);
  const agyWarmModelMatches = hasAgyWarmWriter
    && agyWarmPool.warmSupportsModel(accountRef, options.model);
  if (
    provider === 'agy'
    && isResume
    && requestedSessionId
    && !options.__forceColdSpawn
    && hasAgyWarmWriter
    && agyWarmModelMatches
  ) {
    return startAgyWarmResume({
      accountRef,
      sessionId: requestedSessionId,
      prompt,
      onEvent: options.onEvent,
      // 暖机 LS 不可用（send-message 失败）时回退冷启动；强制跳过 warm 分支避免递归。
      coldSpawn: () => spawnNativeSessionStream({ ...options, __forceColdSpawn: true })
    });
  }

  if (provider === 'agy' && !agyWriterLease) {
    const quiesceReason = hasAgyWarmWriter && !agyWarmModelMatches
      ? 'model-switch'
      : (options.__forceColdSpawn ? 'send-failure-fallback' : 'cold-spawn');
    return startAgyColdAfterQuiesce({
      accountRef,
      reason: quiesceReason,
      coldSpawn: (writerLease) => spawnNativeSessionStream({
        ...options,
        __agyWriterLease: writerLease,
        __providerResourcesReconciled: providerResourcesReconciled,
        __forceColdSpawn: true
      }),
      onFinalPendingRelease: () => {
        if (!gateway && runtime.projectionRequired) {
          reconcileRuntimeResources();
        }
      }
    });
  }

  const canReconcileBeforeSpawn = provider !== 'agy'
    || agyWarmPool.canReconcileBeforeSpawn(agyWriterLease);
  if (!gateway && runtime.projectionRequired && !providerResourcesReconciled && canReconcileBeforeSpawn) {
    reconcileRuntimeResources();
    providerResourcesReconciled = true;
  }

  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `native-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // 会话级审批模式(P3):claude confirm/plan → 追加 --permission-mode + MCP 权限工具,
  // 权限请求经审批桥转发 webUI(runId 已知,回传端点带上下文)。bypass 零变化。
  const approvalMode = normalizeApprovalMode(options.approvalMode);
  if (provider === 'claude' && !interactiveCli && approvalModeNeedsBridge(approvalMode)) {
    args.push(...claudeApprovalArgs(approvalMode, buildClaudeApprovalMcpConfig({
      toolPath: path.join(__dirname, 'claude-permission-mcp-tool.js'),
      approvalUrl: normalizeString(options.approvalRequestUrl),
      runId
    })));
  }
  if (provider === 'grok' && !interactiveCli) {
    args.push(...grokApprovalArgs(approvalMode));
  }

  const claudeStreamJsonInput = claudeUsesStreamJsonInput(provider, { interactiveCli });
  // stream-json 下 mid-run steer 的挂账:每注入一条 user 消息 +1;result 事件时若 >0 则
  // 消账并【不 kill】,让 claude 继续处理注入的下一轮(S2 实证语义:同会话排队轮)。
  let pendingSteerTurns = 0;
  // result 后的主动 kill 是预期收尾,由此产生的非零退出码不作失败处理。
  let expectedResultKill = false;
  let claudeImageMsgFile = '';
  let claudeImageShellCommand = '';
  if (claudeStreamJsonInput) {
    // prompt(含图片 base64 block)经消息文件送入:大图直接写 PTY 会被规范模式 MAX_CANON(~4KB)
    // 截断。`cat <消息文件> - | claude ...`:claude 的 stdin 是【管道】(原样送达),`-` 续接 PTY
    // 保持 stdin 常开(stream-json 要求不 EOF,也正是 steer 注入通道),读到 result(且无挂账
    // steer)后 kill。仅 POSIX。tmux 分支复用该命令串。
    claudeImageMsgFile = path.join(os.tmpdir(), `aih-claude-img-${runId}.jsonl`);
    fs.writeFileSync(claudeImageMsgFile, buildClaudeStreamJsonUserMessage(prompt, imagePaths));
    const claudeCmd = [launch.command, ...launch.prefixArgs, ...args].map(shellSingleQuote).join(' ');
    claudeImageShellCommand = `cat ${shellSingleQuote(claudeImageMsgFile)} - | ${claudeCmd}`;
  }
  const claudeImageStreamInput = claudeStreamJsonInput; // 旧名兼容下方引用(spawn/kill 分支)

  // ── 首选：multiplexer run（进程生命周期与 server 脱钩:重启/崩溃都不腰斩;失败自动回退 nodePty）──
  const runsAiHomeDir = resolveRunsAiHomeDir(options);
  let tmuxRun = null;
  let child = null;
  try {
    const multiplexerBinding = resolveNativeRunMultiplexer(provider, {
      interactiveCli,
      spawnSyncImpl: options.spawnSyncImpl
    });
    if (multiplexerBinding) {
      const socket = socketForRun(runId);
      const logPath = runLogPath(runsAiHomeDir, runId);
      const inner = claudeImageShellCommand
        || buildInnerCommandFromArgv(launch.command, [...launch.prefixArgs, ...args]);
      const manifest = logPath ? writeRunManifest(runsAiHomeDir, {
        runId,
        provider,
        ...serializeRuntimeTarget(runtimeTarget),
        sessionId: sessionParams.sessionId,
        projectDirName: sessionParams.projectDirName,
        projectPath,
        model: normalizeString(options.model),
        interactionMode: 'default',
        multiplexer: multiplexerBinding.name,
        socket,
        logPath,
        startedAt: Date.now()
      }) : null;
      if (manifest) {
        const spawned = spawnDetachedTmuxRun({
          socket,
          shellCommand: buildRunShellCommand(inner, logPath),
          cwd: projectPath,
          env,
          multiplexerBinding
        });
        if (spawned.ok) {
          tmuxRun = { socket, logPath, aiHomeDir: runsAiHomeDir, multiplexerBinding };
          child = createTmuxRunChild({ socket, logPath, multiplexerBinding });
        } else {
          removeRunManifest(runsAiHomeDir, runId);
          console.warn(`[aih] tmux native run 启动失败(${spawned.error})，回退 nodePty:${provider} ${runId}`);
        }
      }
    }

    if (!child) {
      const nodePty = loadNodePty();
      if (claudeImageStreamInput) {
        child = nodePty.spawn('sh', ['-c', claudeImageShellCommand], withPlatformPtyOptions({
          name: 'xterm-color',
          cols: DEFAULT_NATIVE_STREAM_COLS,
          rows: DEFAULT_NATIVE_STREAM_ROWS,
          cwd: projectPath,
          env: { ...env }
        }));
      } else {
        const batchLaunch = resolveWindowsBatchLaunch(
          provider,
          launch.command,
          env,
          process.platform
        );
        const finalLaunch = buildPtyLaunch(
          batchLaunch.launchBin || launch.command,
          [...launch.prefixArgs, ...args],
          { platform: process.platform }
        );
        child = nodePty.spawn(finalLaunch.command, finalLaunch.args, withPlatformPtyOptions({
          name: 'xterm-color',
          cols: DEFAULT_NATIVE_STREAM_COLS,
          rows: DEFAULT_NATIVE_STREAM_ROWS,
          cwd: projectPath,
          env: {
            ...env,
            ...(batchLaunch.envPatch || {})
          }
        }));
      }
    }
  } catch (error) {
    cleanupTransientAuthProjection();
    throw error;
  }
  if (provider === 'agy' && agyWriterLease && !agyWarmPool.activateWriter(agyWriterLease, child)) {
    try { child.kill(); } catch (_error) {}
    const error = new Error('agy_writer_lease_invalid');
    error.code = 'agy_writer_lease_invalid';
    throw error;
  }
  const state = {
    content: '',
    stderr: '',
    stdout: '',
    sessionId: sessionParams.sessionId,
    failureMessage: '',
    seenToolUseIds: new Set()
  };
  const startedAt = Date.now();
  const beforeSessionIds = (!isResume && !sessionParams.sessionId) || geminiSessionFileResume
    ? listProviderSessionFiles(provider, {
      projectDirName: sessionParams.projectDirName
    }).map((item) => item.id)
    : [];
  let lineBuffer = '';
  let pendingTerminal = '';
  let flushTimer = null;
  let settled = false;
  let runtimeBlockRecorded = false;
  let watchdog = null;
  let watchdogGraceTimer = null;
  let ignoreChildOutput = false; // agy 收编为暖机 LS 后置 true：停止累积该 pty 的交互输出
  const interactivePromptDetector = createInteractivePromptDetector(provider);
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const cleanupClaudeImageMsgFile = () => {
    if (!claudeImageMsgFile) return;
    try { fs.unlinkSync(claudeImageMsgFile); } catch (_error) { /* 已删/不存在忽略 */ }
    claudeImageMsgFile = '';
  };
  // multiplexer run 收尾：清 manifest(收养依据) + 兜底清 backend 资源,异常退出保留日志便于排障。
  const cleanupTmuxRunManifest = (keepLog) => {
    if (!tmuxRun) return;
    removeRunManifest(tmuxRun.aiHomeDir, runId, { keepLog: Boolean(keepLog) });
    cleanupRunSocket(tmuxRun.socket, { multiplexerBinding: tmuxRun.multiplexerBinding });
    tmuxRun = null;
  };
  const stopWatchdog = () => {
    if (watchdogGraceTimer) {
      clearTimeout(watchdogGraceTimer);
      watchdogGraceTimer = null;
    }
    if (watchdog) watchdog.stop();
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    stopWatchdog();
    cleanupClaudeImageMsgFile();
    cleanupTmuxRunManifest(true);
    if (flushTimer) clearTimeout(flushTimer);
    rejectDone(error);
  };
  const finish = async (exitCode) => {
    if (settled) return;
    settled = true;
    stopWatchdog();
    // 我们在 result 后主动 kill 的收尾(stream-json 不自退)是成功路径,归零退出码,
    // 否则 tmux 死亡轮询上报的 1 会被当失败、done 被 reject 成一坨 stdout。
    if (expectedResultKill) exitCode = 0;
    cleanupClaudeImageMsgFile();
    cleanupTmuxRunManifest(Number(exitCode) !== 0);
    if (flushTimer) clearTimeout(flushTimer);
    if (shouldScanNativeRuntimeBlockerOutput({ exitCode }) && !runtimeBlockRecorded) {
      recordRuntimeBlockFromOutput(
        normalizeString(state.failureMessage)
        || normalizeString(state.stderr)
        || normalizeString(state.stdout)
      );
    }
    if (runtimeBlockRecorded) {
      const error = new Error(normalizeString(state.failureMessage) || 'native_runtime_blocked');
      error.code = 'native_runtime_blocked';
      error.retryAnotherAccount = false;
      error.exitCode = exitCode;
      rejectDone(error);
      return;
    }
    // 看门狗熔断：进程是我们杀的，退出码没有意义（tmux 死亡轮询恒报 1），
    // 必须用独立错误码上报，否则下次排障分不清「上游报错」和「我们主动掐断」。
    if (state.timeoutInfo) {
      const error = new Error(state.timeoutInfo.message);
      error.code = state.timeoutInfo.code;
      error.retryAnotherAccount = false;
      error.exitCode = exitCode;
      error.timeoutReason = state.timeoutInfo.reason;
      rejectDone(error);
      return;
    }
    if (Number(exitCode) !== 0) {
      const failureOutput = normalizeString(state.failureMessage)
        || normalizeString(state.stderr)
        || normalizeString(state.stdout);
      const classifiedFailure = classifyNativeSessionFailure(
        provider,
        failureOutput,
        { exitCode }
      );
      const error = new Error(classifiedFailure.message);
      error.code = classifiedFailure.code || 'native_session_failed';
      error.retryAnotherAccount = classifiedFailure.retryAnotherAccount === true;
      error.exitCode = exitCode;
      rejectDone(error);
      return;
    }

    // agy 新会话由 CLI 生成 conversation id。禁用“首条 transcript 即完成”后，必须在
    // 进程干净退出时采纳最终会话，再读取完整 transcript；否则 draft 会话会丢失 id/正文。
    if (!isResume && provider === 'agy' && !state.sessionId) {
      const inferredSessionId = await inferCreatedSessionId(provider, {
        beforeSessionIds,
        startedAt,
        prompt: initialInput || prompt,
        projectDirName: sessionParams.projectDirName,
        cwd: projectPath
      });
      if (inferredSessionId) {
        state.sessionId = inferredSessionId;
        emitEvent({ type: 'session-created', sessionId: inferredSessionId });
      }
    }

    const afterMessages = (isResume || (interactiveCli && state.sessionId))
      ? await waitForSessionUpdate(
        provider,
        {
          sessionId: state.sessionId || sessionParams.sessionId,
          projectDirName: sessionParams.projectDirName
        },
        beforeMessages.length,
        state.sessionId && state.sessionId !== sessionParams.sessionId
          ? resolveSessionFilePath(provider, {
            sessionId: state.sessionId,
            projectDirName: sessionParams.projectDirName
          })
          : sessionPath,
        beforeMtime
      )
      : [];
    if (!isResume && provider === 'claude' && !state.sessionId) {
      const inferredSessionId = await inferClaudeCreatedSessionId(sessionParams.projectDirName, {
        beforeSessionIds,
        startedAt,
        prompt: initialInput || prompt
      });
      if (inferredSessionId) {
        state.sessionId = inferredSessionId;
        emitEvent({ type: 'session-created', sessionId: inferredSessionId });
      }
    }
    const finalContent = state.content || collectAssistantReply(beforeMessages, afterMessages);
    if (provider === 'grok') {
      const grokSessionPath = resolveSessionFilePath(provider, {
        sessionId: state.sessionId || sessionParams.sessionId,
        projectDirName: sessionParams.projectDirName
      }, sessionReaderOptions);
      const turnState = grokSessionPath ? readGrokTurnState(path.dirname(grokSessionPath)) : null;
      if (turnState && (turnState.pendingCount > 0 || (turnState.failedCount > 0 && !turnState.hasAssistantAfterTerminalTool))) {
        const error = new Error(turnState.failureMessage || 'grok_tool_incomplete');
        error.code = turnState.failedCount > 0 ? 'native_session_tool_failed' : 'native_session_tool_incomplete';
        rejectDone(error);
        return;
      }
    }
    resolveDone({
      content: finalContent,
      afterMessages,
      sessionId: state.sessionId || ''
    });
  };

  const emitEvent = (event) => {
    if (!event) return;
    // multiplexer run:拿到真实 sessionId 后回填 manifest——server 重启后的收养全靠它按会话定位 run。
    if (tmuxRun && event.type === 'session-created' && normalizeString(event.sessionId)) {
      try {
        updateRunManifest(tmuxRun.aiHomeDir, runId, { sessionId: normalizeString(event.sessionId) });
      } catch (_error) { /* best-effort */ }
    }
    if (watchdog) watchdog.observe(event);
    if (typeof options.onEvent !== 'function') return;
    options.onEvent({
      ...event,
      runId
    });
  };

  // 主动熔断：只有上游真进展才算心跳，错误/重连行不刷新计时（否则每 ~40s 一条
  // `Reconnecting... n/5` 会让 idle 计时器永不触发）。terminalMode 是用户自己的终端，
  // 空闲是常态，不能挂看门狗。
  watchdog = createNativeRunWatchdog({
    env: options.watchdogEnv || process.env,
    enabled: options.terminalMode ? false : options.watchdogEnabled,
    firstProgressTimeoutMs: options.firstProgressTimeoutMs,
    upstreamErrorTimeoutMs: options.upstreamErrorTimeoutMs,
    stallTimeoutMs: options.stallTimeoutMs,
    terminalOutputIsProgress: Boolean(interactiveCli),
    onTimeout: (info) => {
      if (settled) return;
      state.timeoutInfo = info;
      if (!normalizeString(state.failureMessage)) state.failureMessage = info.message;
      emitEvent({
        type: 'error',
        code: info.code,
        message: info.message,
        reason: info.reason,
        timeout: true,
        elapsedMs: info.elapsedMs
      });
      try {
        child.kill();
      } catch (_error) {}
      // 杀不动也必须收尾：不 settle 的 done 就是老的「挂到天荒地老」故障模式。
      watchdogGraceTimer = setTimeout(() => {
        watchdogGraceTimer = null;
        if (settled) return;
        const error = new Error(info.message);
        error.code = info.code;
        error.retryAnotherAccount = false;
        error.timeoutReason = info.reason;
        fail(error);
        try {
          child.kill();
        } catch (_killError) {}
      }, watchdog.config.killGraceMs);
      if (watchdogGraceTimer && typeof watchdogGraceTimer.unref === 'function') {
        watchdogGraceTimer.unref();
      }
    }
  });
  watchdog.start();

  const recordRuntimeBlockFromOutput = (text) => {
    if (runtimeBlockRecorded) return null;
    const blocker = classifyNativeAccountRuntimeBlocker(provider, text);
    if (!blocker) return null;
    runtimeBlockRecorded = true;
    const persisted = recordNativeAccountRuntimeBlocker({
      ...options,
      provider,
      accountRef,
      aiHomeDir: options.aiHomeDir
    }, blocker);
    state.failureMessage = blocker.message || blocker.reason || 'native_runtime_blocked';
    emitEvent({
      type: 'runtime-blocked',
      provider,
      ...serializeRuntimeTarget(runtimeTarget),
      status: blocker.status,
      reason: blocker.reason,
      persisted
    });
    return blocker;
  };

  const completeFromOfficialTranscript = async () => {
    if (!interactiveCli || options.completeOnTranscriptUpdate === false) return;
    // gemini fork 出的新会话只含【本轮】对话，不展开 import 的旧历史，因此它相对于旧会话
    // 的消息数并不递增（无法用 before/after 计数比对）。对 gemini fork 把 before 视为空，
    // 让“新会话里出现 assistant 回复”即判定本轮完成。
    const effectiveBeforeMessages = geminiSessionFileResume ? [] : beforeMessages;
    const result = await waitForOfficialTranscriptTurn(
      provider,
      {
        // gemini resume 会 fork 新会话：清空 sessionId 强制走 inferCreatedSessionId，
        // 据 beforeSessionIds + prompt 文本命中那个新会话并读取回复。
        sessionId: geminiSessionFileResume ? '' : (state.sessionId || sessionParams.sessionId),
        projectDirName: sessionParams.projectDirName,
        // codex 用 cwd 走 state DB 推断 sessionId（projectPath = 子进程 cwd）。
        cwd: projectPath
      },
      effectiveBeforeMessages,
      {
        beforeSessionIds,
        startedAt,
        prompt: initialInput || prompt,
        aiHomeDir: options.aiHomeDir,
        hostHomeDir: options.hostHomeDir,
        accountRef,
        // gemini fork 必须等到含本轮 prompt 的会话出现，避免采纳到只含导入旧历史的早期 fork。
        requirePromptMatch: geminiSessionFileResume,
        timeoutMs: options.officialTranscriptTimeoutMs
      }
    );
    if (settled) return;
    // gemini fork resume：state.sessionId 初始化为源会话 id（resume 目标），但本轮真正写入
    // 回复的是 fork 出的新会话。必须用 fork id 覆盖，前端据此采纳新会话，下一轮才会 resume
    // 含本轮上下文的 fork、而非反复 import 源会话丢失中间轮。
    if (result.sessionId && (!state.sessionId || geminiSessionFileResume)) {
      state.sessionId = result.sessionId;
      emitEvent({ type: 'session-created', sessionId: result.sessionId });
    }
    const content = state.content || collectAssistantReply(effectiveBeforeMessages, result.afterMessages);
    settled = true;
    stopWatchdog();
    if (flushTimer) clearTimeout(flushTimer);
    resolveDone({
      content,
      afterMessages: result.afterMessages,
      sessionId: state.sessionId || result.sessionId || ''
    });
    try {
      if (!gateway && runtime.projectionRequired) {
        captureProviderAuth(fs, runtimeDir, provider, {
          path,
          aiHomeDir: options.aiHomeDir,
          accountRef
        });
      }
    } catch (_error) {}
    // agy：transcript 终局路径本轮跑完后【不杀进程】，把存活的 agy 进程收编为该账号的暖机 LS，
    // 后续 resume 走 send-message 快路径（见 startAgyWarmResume）。其余 provider 照常结束。
    if (provider === 'agy' && !options.terminalMode && !options.suppressInteractivePrompt && child && typeof child.kill === 'function') {
      ignoreChildOutput = true; // 收编后不再累积该 pty 的交互输出（避免内存随暖机 LS 寿命增长）
      agyWarmPool.adopt({
        accountRef,
        child,
        agyBin: launch.command,
        baseEnv: env,
        projectId: resolveAgyProjectId(projectPath),
        model: options.model,
        writerLease: agyWriterLease
      }).then((adopted) => {
        if (!adopted) {
          try { child.kill(); } catch (_error) {}
        }
      }).catch(() => {
        try { child.kill(); } catch (_error) {}
      });
    } else if (child && typeof child.kill === 'function') {
      try {
        child.kill();
      } catch (_error) {}
    }
  };

  const flushTerminal = () => {
    flushTimer = null;
    const text = pendingTerminal;
    pendingTerminal = '';
    if (!text.trim()) return;
    emitEvent({
      type: 'terminal-output',
      text
    });
  };

  const scheduleTerminalFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushTerminal, 120);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  const pushTerminalText = (text) => {
    const normalized = sanitizeTerminalText(text);
    if (!normalized) return;
    pendingTerminal += normalized;
    scheduleTerminalFlush();
  };

  child.onData((chunk) => {
    if (ignoreChildOutput) return; // 已收编为暖机 LS，pty 自身输出与本次会话无关
    const text = String(chunk || '');
    state.stdout += text;
    if (interactiveCli) {
      const runtimeBlocker = shouldScanNativeRuntimeBlockerOutput({ interactiveCli })
        ? recordRuntimeBlockFromOutput(text)
        : null;
      if (runtimeBlocker) {
        try {
          child.kill();
        } catch (_error) {}
      }
      // terminalMode(slash/显式终端)：整个 TUI 由 xterm 原样渲染,不抓 prompt。
      // suppressInteractivePrompt(agy --print)：输出是干净模型回复、无交互菜单,同样不抓,
      // 避免误判。两者之外(codex/claude slash 等)才做 interactive-prompt 检测。
      if (!options.terminalMode && !options.suppressInteractivePrompt) {
        const promptEvent = interactivePromptDetector.appendOutput(text);
        if (promptEvent) {
          emitEvent(promptEvent);
        }
      }
      // agy headless(--print):stdout 就是流式模型正文,直接作为 delta 事件推给前端。
      // 最终干净正文在进程退出后从完整 transcript 定稿，不能把中间 planner 当作终局。
      if (options.streamRawStdout) {
        const delta = sanitizeTerminalText(text);
        if (delta) emitEvent({ type: 'delta', delta });
        return;
      }
      if (options.emitTerminalOutput !== false) {
        emitEvent({
          type: 'terminal-output',
          text
        });
      }
      return;
    }
    lineBuffer += sanitizeTerminalText(text);

    while (true) {
      const newlineIndex = lineBuffer.indexOf('\n');
      if (newlineIndex < 0) break;
      const rawLine = lineBuffer.slice(0, newlineIndex).replace(/\r/g, '');
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) {
        pushTerminalText('\n');
        continue;
      }
      const parsedResult = parseNativeStreamEvent(provider, trimmedLine, state);
      const events = Array.isArray(parsedResult)
        ? parsedResult
        : (parsedResult ? [parsedResult] : []);
      if (events.length) {
        for (const event of events) {
          if (!event) continue;
          if (shouldScanNativeRuntimeBlockerOutput({ explicitError: event.type === 'error' })) {
            recordRuntimeBlockFromOutput(event.message || state.failureMessage || trimmedLine);
          }
          if (event.type !== IGNORED_NATIVE_STREAM_EVENT.type) {
            emitEvent(event);
          }
          // stream-json 输入模式下 claude 吐完 result 不会自己退出（等下一条 stdin 消息）→
          // 主动 kill，触发 onExit→finish 收尾。有挂账 steer 时消账且不 kill——claude 会
          // 继续处理注入的下一轮,事件继续流入本 run(前端同一气泡续写)。
          if (claudeImageStreamInput && event.claudeTerminalResult) {
            // 错误 result(is_error,如 403 鉴权失败):致命,不可能满足排队 steer → 无条件 kill。
            // 【不】设 expectedResultKill:让 kill 产生的非零退出码走 finish 的失败分支 reject,
            // 前端据此收到 error 并关流(否则会当成功、把 403 文案当正文)。记下失败信息供分类。
            if (!state.failureMessage) state.failureMessage = event.message || 'claude_stream_failed';
            try { child.kill(); } catch (_error) {}
          } else if (claudeImageStreamInput && event.type === 'result') {
            if (pendingSteerTurns > 0) {
              pendingSteerTurns -= 1;
            } else {
              // 预期中的干净收尾:kill 导致的非零退出码不代表失败(tmux 死亡轮询恒报 1)。
              expectedResultKill = true;
              try { child.kill(); } catch (_error) {}
            }
          }
        }
        continue;
      }
      pushTerminalText(`${rawLine}\n`);
    }

    const trailing = lineBuffer.trim();
    if (trailing && !trailing.startsWith('{"')) {
      pushTerminalText(lineBuffer);
      lineBuffer = '';
    }
  });
  child.onExit(({ exitCode }) => {
    const finalWriter = provider !== 'agy' || !agyWriterLease
      ? true
      : agyWarmPool.releaseWriter(agyWriterLease);
    try {
      if (!gateway && runtime.projectionRequired) {
        captureProviderAuth(fs, runtimeDir, provider, {
          path,
          aiHomeDir: options.aiHomeDir,
          accountRef
        });
      }
    } catch (_error) {}
    if (!gateway && runtime.projectionRequired && finalWriter) {
      try {
        reconcileRuntimeResources();
        cleanupTransientAuthProjection();
      } catch (error) {
        fail(error);
        return;
      }
    }
    const promptClearedEvent = interactivePromptDetector.clearActivePrompt('run-finished');
    if (promptClearedEvent) {
      emitEvent(promptClearedEvent);
    }
    if (lineBuffer.trim()) {
      pushTerminalText(lineBuffer);
      lineBuffer = '';
    }
    if (pendingTerminal) {
      flushTerminal();
    }
    finish(exitCode).catch(fail);
  });

  if (interactiveCli && initialInput) {
    try {
      writePtyInput(child, initialInput, { appendNewline: true });
    } catch (_error) {}
  }

  if (!isResume && sessionParams.sessionId) {
    setImmediate(() => {
      if (!settled) {
        emitEvent({ type: 'session-created', sessionId: sessionParams.sessionId });
      }
    });
  }

  completeFromOfficialTranscript().catch((error) => {
    if (settled) return;
    fail(error);
    if (child && typeof child.kill === 'function') {
      try {
        child.kill();
      } catch (_killError) {}
    }
  });

  return {
    runId,
    child,
    done,
    // detached 重连（GET /v0/webui/chat/runs）恢复交互 prompt 用：返回当前待回答的 prompt。
    getActivePrompt() {
      return interactivePromptDetector.getActivePrompt();
    },
    // mid-run steer(P2c,仅 claude stream-json run):把用户消息包成 stream-json user 行
    // 写进 stdin;claude 按同会话下一轮排队处理(S2 实证),result 消账逻辑保证 run 活到
    // steer 轮吐完。不支持的 run 抛 native_steer_unsupported。
    writeSteer(text) {
      if (settled) {
        const error = new Error('native_session_run_not_active');
        error.code = 'native_session_run_not_active';
        throw error;
      }
      if (!claudeImageStreamInput) {
        const error = new Error('native_steer_unsupported');
        error.code = 'native_steer_unsupported';
        throw error;
      }
      const value = String(text || '').trim();
      if (!value) {
        const error = new Error('native_session_input_empty');
        error.code = 'native_session_input_empty';
        throw error;
      }
      pendingSteerTurns += 1;
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: value } });
      writePtyInput(child, line, { appendNewline: true });
    },
    writeInput(input, writeOptions = {}) {
      if (settled) {
        const error = new Error('native_session_run_not_active');
        error.code = 'native_session_run_not_active';
        throw error;
      }
      const rawInput = String(input || '');
      if (!rawInput) {
        const error = new Error('native_session_input_empty');
        error.code = 'native_session_input_empty';
        throw error;
      }
      const promptId = normalizeString(writeOptions.promptId);
      if (promptId) {
        const activePrompt = interactivePromptDetector.getActivePrompt();
        if (!activePrompt || activePrompt.promptId !== promptId) {
          const error = new Error('native_interactive_prompt_not_active');
          error.code = 'native_interactive_prompt_not_active';
          throw error;
        }
      }
      const promptClearedEvent = interactivePromptDetector.clearActivePrompt('input-submitted');
      if (promptClearedEvent) {
        emitEvent(promptClearedEvent);
      }
      writePtyInput(child, rawInput, {
        appendNewline: writeOptions.appendNewline !== false
      });
    },
    resize(cols, rows) {
      if (settled) {
        const error = new Error('native_session_run_not_active');
        error.code = 'native_session_run_not_active';
        throw error;
      }
      const nextCols = Math.max(20, Math.min(400, Number(cols) || 80));
      const nextRows = Math.max(4, Math.min(200, Number(rows) || 24));
      if (typeof child.resize === 'function') {
        child.resize(nextCols, nextRows);
      }
    },
    abort() {
      if (flushTimer) clearTimeout(flushTimer);
      if (child && typeof child.kill === 'function') {
        try {
          child.kill();
        } catch (_error) {}
      }
    }
  };
}

async function waitForOfficialTranscriptTurn(provider, params = {}, beforeMessages = [], options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const defaultTimeoutMs = normalizedProvider === 'grok' ? 30000 : 120000;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || defaultTimeoutMs);
  const startedAt = Number(options.startedAt) || Date.now();
  const prompt = String(options.prompt || '');
  const beforeSessionIds = Array.isArray(options.beforeSessionIds) ? options.beforeSessionIds : [];
  const requirePromptMatch = options.requirePromptMatch === true;
  const deadline = Date.now() + timeoutMs;
  let sessionId = normalizeString(params.sessionId);
  let afterMessages = [];

  if (!sessionId && beforeSessionIds.length > 0) {
    sessionId = await inferCreatedSessionId(normalizedProvider, {
      beforeSessionIds,
      startedAt,
      prompt,
      requirePromptMatch,
      projectDirName: params.projectDirName,
      cwd: params.cwd,
      hostHome: options.hostHome,
      timeoutMs: Math.min(timeoutMs, 10000)
    });
  }

  while (Date.now() < deadline) {
    if (!sessionId && beforeSessionIds.length > 0) {
      sessionId = await inferCreatedSessionId(normalizedProvider, {
        beforeSessionIds,
        startedAt,
        prompt,
        requirePromptMatch,
        projectDirName: params.projectDirName,
        cwd: params.cwd,
        hostHome: options.hostHome,
        timeoutMs: 500
      });
    }

    if (sessionId) {
      afterMessages = readSessionMessages(normalizedProvider, {
        sessionId,
        projectDirName: params.projectDirName
      }, buildSessionReaderOptions(options));
      if (hasAssistantAddition(beforeMessages, afterMessages)) {
        if (normalizedProvider === 'grok') {
          const sessionFilePath = resolveSessionFilePath(normalizedProvider, {
            sessionId,
            projectDirName: params.projectDirName
          }, buildSessionReaderOptions(options));
          const turnState = sessionFilePath ? readGrokTurnState(path.dirname(sessionFilePath)) : null;
          if (turnState && turnState.pendingCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          if (turnState && turnState.failedCount > 0 && !turnState.hasAssistantAfterTerminalTool) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
        }
        return { sessionId, afterMessages };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  let grokTurnState = null;
  if (normalizedProvider === 'grok' && sessionId) {
    const sessionFilePath = resolveSessionFilePath(normalizedProvider, {
      sessionId,
      projectDirName: params.projectDirName
    }, buildSessionReaderOptions(options));
    grokTurnState = sessionFilePath ? readGrokTurnState(path.dirname(sessionFilePath)) : null;
  }
  const failureMessage = grokTurnState && grokTurnState.failureMessage;
  const error = new Error(failureMessage || (
    grokTurnState && grokTurnState.pendingCount > 0
      ? 'grok_tool_incomplete'
      : 'native_session_transcript_not_updated'
  ));
  error.code = failureMessage
    ? 'native_session_tool_failed'
    : (grokTurnState && grokTurnState.pendingCount > 0
      ? 'native_session_tool_incomplete'
      : 'native_session_transcript_not_updated');
  error.sessionId = sessionId;
  error.afterMessages = afterMessages;
  throw error;
}

async function runNativeSessionPrompt(options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const runtimeTarget = resolveRuntimeTarget(options);
  const prompt = String(options.prompt || '');
  const getProfileDir = options.getProfileDir;

  if (!provider || !runtimeTarget || typeof getProfileDir !== 'function') {
    const error = new Error('native_session_invalid_context');
    error.code = 'native_session_invalid_context';
    throw error;
  }

  const stream = spawnNativeSessionStream({
    ...options,
    prompt,
    interactiveCli: provider !== 'claude',
    emitTerminalOutput: false,
    completeOnTranscriptUpdate: provider !== 'claude'
  });
  const result = await stream.done;

  return {
    ok: true,
    provider,
    ...serializeRuntimeTarget(runtimeTarget),
    sessionId: result.sessionId || normalizeString(options.sessionId),
    content: result.content || '',
    beforeCount: 0,
    afterCount: Array.isArray(result.afterMessages) ? result.afterMessages.length : 0
  };
}

// 派生一个会话标题（用于 codex session_index）：取 prompt 首个非空行，截断。
function ensureAgySessionProjectIndex(options = {}) {
  const sessionId = normalizeString(options.sessionId);
  const projectPath = normalizeString(options.projectPath);
  if (!sessionId || !projectPath) return false;
  const hostHome = normalizeString(options.hostHome) || getRealHome();
  const indexPath = agySessionProjectIndexPath(hostHome);
  try {
    const current = readAgySessionProjectIndex(hostHome);
    const existing = current[sessionId];
    const entry = { projectPath, updatedAt: new Date().toISOString() };
    if (existing && existing.projectPath === projectPath) return false;
    current[sessionId] = entry;
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(current, null, 2), 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  DEFAULT_NATIVE_STREAM_COLS,
  ensureCodexSessionIndexEntry,
  inferCodexSessionIdFromStateDb,
  ensureAgySessionProjectIndex,
  resolveAgyProjectId,
  DEFAULT_NATIVE_STREAM_ROWS,
  buildProviderEnv,
  buildPtyInputChunks,
  buildStartCommand,
  buildResumeCommand,
  applyProviderConfigDirArgs,
  resolveNativeCliLaunch,
  ensureNativeCliReadyForChat,
  classifyNativeSessionFailure,
  classifyNativeAccountRuntimeBlocker,
  shouldScanNativeRuntimeBlockerOutput,
  recordNativeAccountRuntimeBlocker,
  recordNativeAccountRuntimeSuccess,
  collectAssistantReply,
  inferClaudeCreatedSessionId,
  isOfficialNativeSessionProvider,
  parseNativeStreamEvent,
  runNativeSessionPrompt,
  startAgyColdAfterQuiesce,
  spawnNativeSessionStream
};
