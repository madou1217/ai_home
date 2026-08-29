'use strict';

const { DEFAULT_SERVER_PORT } = require('./server-defaults');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureCodexHooksEnabled, ensureCodexProjectRegistered } = require('./codex-project-registry');
const { resolveProviderDefaultModel } = require('./provider-default-models');
const { defaultSessionEventBus } = require('./session-event-bus');
const {
  appendImagePathsToPrompt,
  persistChatImages,
  resolveChatAttachmentPath,
  guessAttachmentMimeType
} = require('./chat-attachments');
const { validateNativeSlashCommand, getProviderSlashCommands } = require('./native-slash-commands');
const {
  isOfficialNativeSessionProvider,
  recordNativeAccountRuntimeSuccess
} = require('./native-session-chat');
const {
  supportsAihServerProfile,
  buildAihServerProfileEnv
} = require('../account/self-relay-account');
const { readServerConfig } = require('./server-config-store');
const {
  readAccountCredentialRecord,
  readAccountCredentials
} = require('./account-credential-store');
const { isAccountRef } = require('./account-ref-store');
const {
  resolveRuntimeTarget,
  serializeRuntimeTarget
} = require('../account/runtime-target');
const { createCodexLaunchSupport } = require('../cli/services/pty/codex-launch-support');
const { normalizeApprovalMode, approvalModeNeedsBridge } = require('./native-approval-modes');
const { canonicalizeProviderResourceValue } = require('../runtime/provider-resource-path');
const {
  registerApprovalRequest,
  decideApproval,
  cancelApprovalsForRun,
  getPendingApprovalPromptForRun,
  toApprovalPrompt
} = require('./native-approval-bridge');
const { isImageGenerationModel } = require('./code-assist-image-generation');
const { loadAliases, resolveAlias } = require('./model-alias-store');
const {
  CLAUDE_CREDENTIAL_TYPES,
  readClaudeCredential
} = require('../account/claude-credential');
const {
  DEFAULT_CLI_INSTALL_CONFIRMATION_TIMEOUT_MS,
  defaultCliInstallConfirmationRegistry
} = require('./cli-install-confirmation-registry');

const { parseJsonFileSafe, normalizeString, canonicalizeChatPayload, finishStartedChatStream, humanizeUpstreamError, attachAbortableRequestClose } = require('./webui-chat-routes-utils');
const { sanitizeClaudeProjectDirName, resolveNativeProjectDirName, truncateText, listProjectRootEntries, readProjectTextFile, buildPackageJsonSummary, buildProjectContextMessage, injectProjectContextMessage } = require('./webui-chat-routes-project');
const { resolveNativeFallbackAccountRefs, resolveRuntimeApiKeyMode, nativeAccountHasCredentials, recordNativeSessionModelUsage, normalizeNativeSessionModel, resolveNativeAliasModel, publishNativeSessionEvent, waitForNativeSessionTranscriptReadable, refreshProjectsSnapshotAfterNativeSession, detectApiKeyMode } = require('./webui-chat-routes-native-session');
const { getOpenCodeSessionHostHome, toOpenAiHistoryMessages, appendCurrentUserMessage, buildOpenCodeApiProxyMessages, beginOpenCodeApiProxyTurn, completeOpenCodeApiProxyTurn, requireOpenCodeTurnSessionId, resolveApiProxyJsonSessionId, buildApiProxyMessages, createOpenAiChunkAdapter } = require('./webui-chat-routes-opencode-proxy');
const { readClaudeApiSettings, isAnthropicCompatibleClaudeBaseUrl, buildAnthropicMessagesPayload, extractAnthropicTextFromResponse, handleClaudeAnthropicCompatibleChat } = require('./webui-chat-routes-claude-compat');
const { resolveCliInstallConfirmationRegistry, resolveCliInstallConfirmationTimeoutMs, requestCliInstallConfirmation } = require('./webui-chat-routes-cli-confirm');
async function handleGetSlashCommandsRequest(ctx) {
  const provider = String(ctx.url.searchParams.get('provider') || '').trim().toLowerCase();
  if (!provider) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'missing_provider' });
    return true;
  }
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    provider,
    commands: getProviderSlashCommands(provider)
  });
  return true;
}

async function handleGetChatAttachmentRequest(ctx) {
  const { url, res } = ctx;
  const targetPath = String(url.searchParams.get('path') || '');

  let resolvedPath = '';
  try {
    resolvedPath = resolveChatAttachmentPath(targetPath, {
      fs: ctx.fs || (ctx.deps && ctx.deps.fs),
      aiHomeDir: ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir),
      hostHomeDir: ctx.hostHomeDir || (ctx.deps && ctx.deps.hostHomeDir)
    });
  } catch (_error) {
    ctx.writeJson(res, 404, { ok: false, error: 'chat_attachment_not_found' });
    return true;
  }

  const contentType = guessAttachmentMimeType(resolvedPath);
  if (!contentType) {
    ctx.writeJson(res, 415, { ok: false, error: 'unsupported_chat_attachment_type' });
    return true;
  }
  const stat = fs.statSync(resolvedPath);
  const payload = fs.readFileSync(resolvedPath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=300'
  });
  res.end(payload);
  return true;
}

async function handleNativeChatRunInputRequest(ctx) {
  const {
    pathname,
    readRequestBody,
    writeJson,
    getNativeChatRun,
    unregisterNativeChatRun
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/input$/);
  const runId = matches && matches[1] ? matches[1] : '';
  const payload = await readRequestBody(ctx.req, { maxBytes: 256 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const input = String(payload && payload.input || '');
  const appendNewline = !payload || payload.appendNewline !== false;
  const promptId = String(payload && payload.promptId || '').trim();
  const mode = String(payload && payload.mode || '').trim();
  const run = getNativeChatRun(runId);

  if (!run) {
    writeJson(ctx.res, 404, { ok: false, error: 'native_chat_run_not_found' });
    return true;
  }
  if (!input) {
    writeJson(ctx.res, 400, { ok: false, error: 'native_chat_input_empty' });
    return true;
  }

  try {
    if (mode === 'steer') {
      // mid-run 插话(P2c):注入下一条 user 消息,claude stream-json run 支持;其余 unsupported。
      if (typeof run.writeSteer !== 'function') {
        const error = new Error('native_steer_unsupported');
        error.code = 'native_steer_unsupported';
        throw error;
      }
      run.writeSteer(input);
    } else {
      run.writeInput(input, promptId ? { appendNewline, promptId } : { appendNewline });
    }
    writeJson(ctx.res, 200, { ok: true, runId, mode: mode || 'input' });
  } catch (error) {
    const code = String(error && error.code || 'native_chat_input_failed');
    if (code === 'native_session_run_not_active') {
      unregisterNativeChatRun(runId);
    }
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, run.provider, {
      ok: false,
      error: code,
      message: String((error && error.message) || error || 'native_chat_input_failed')
    }));
  }
  return true;
}

async function handleNativeChatRunResizeRequest(ctx) {
  const {
    pathname,
    readRequestBody,
    writeJson,
    getNativeChatRun,
    unregisterNativeChatRun
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/resize$/);
  const runId = matches && matches[1] ? matches[1] : '';
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const cols = Number(payload && payload.cols);
  const rows = Number(payload && payload.rows);
  const run = getNativeChatRun(runId);

  if (!run) {
    writeJson(ctx.res, 404, { ok: false, error: 'native_chat_run_not_found' });
    return true;
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    writeJson(ctx.res, 400, { ok: false, error: 'native_chat_resize_invalid' });
    return true;
  }

  try {
    run.resize(cols, rows);
    writeJson(ctx.res, 200, { ok: true, runId, cols, rows });
  } catch (error) {
    const code = String(error && error.code || 'native_chat_resize_failed');
    if (code === 'native_session_run_not_active') {
      unregisterNativeChatRun(runId);
    }
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, run.provider, {
      ok: false,
      error: code,
      message: String((error && error.message) || error || 'native_chat_resize_failed')
    }));
  }
  return true;
}

// GET /v0/webui/chat/runs?sessionId=&provider=&projectDirName= —— 列出注册表中仍在跑的 native run。
// detached 场景（刷新/导航/代理抖动断连后服务端只 detach 不 kill）的状态恢复入口：
// 页面重连后据此得知"该会话有 run 正在跑"（恢复运行中/停止按钮），并用 activePrompt
// 恢复待回答的交互 prompt（回答仍走 POST /runs/:runId/input + promptId）。
async function handleNativeChatRunListRequest(ctx) {
  const { url, writeJson } = ctx;
  const listRuns = typeof ctx.listNativeChatRuns === 'function'
    ? ctx.listNativeChatRuns
    : require('./native-chat-run-store').listNativeChatRuns;
  const sessionId = normalizeString(url.searchParams.get('sessionId'));
  const provider = normalizeString(url.searchParams.get('provider')).toLowerCase();
  const projectDirName = normalizeString(url.searchParams.get('projectDirName'));

  const runs = listRuns()
    .filter((run) => run && normalizeString(run.runId))
    .filter((run) => !sessionId || normalizeString(run.sessionId) === sessionId)
    .filter((run) => !provider || normalizeString(run.provider).toLowerCase() === provider)
    // projectDirName 仅在两边都有值时参与匹配（codex/agy 的 run 不带该字段）。
    .filter((run) => !projectDirName
      || !normalizeString(run.projectDirName)
      || normalizeString(run.projectDirName) === projectDirName)
    .map((run) => ({
      runId: normalizeString(run.runId),
      provider: normalizeString(run.provider).toLowerCase(),
      accountRef: normalizeString(run.accountRef),
      sessionId: normalizeString(run.sessionId),
      projectDirName: normalizeString(run.projectDirName),
      projectPath: normalizeString(run.projectPath),
      startedAt: Number(run.startedAt) || 0,
      interactionMode: normalizeString(run.interactionMode) || 'default',
      activePrompt: (typeof run.getActivePrompt === 'function' ? run.getActivePrompt() : null)
        // 挂起的审批(P3)也算待答 prompt:detached 刷新后审批卡随 /chat/runs 恢复。
        || getPendingApprovalPromptForRun(normalizeString(run.runId))
        || null
    }));

  writeJson(ctx.res, 200, canonicalizeChatPayload(ctx, provider, { ok: true, runs }));
  return true;
}

// POST /v0/webui/chat/runs/:runId/abort —— 【显式 stop】。前端点停止时调用它真正 kill CLI 进程。
// 与"被动断连"（浏览器导航/刷新、跨境代理抖动 → SSE close）区分开：被动断连只 detach 不 kill
// （见 closeStream），让 native run 跑完写进 CLI 自己的会话库、重连后能看到完整结果（并行子代理
// 综合等长任务不再被断连腰斩成"看着没处理完"）。只有这个显式 abort 才真正终止。
async function handleNativeChatRunAbortRequest(ctx) {
  const { pathname, writeJson, getNativeChatRun, unregisterNativeChatRun } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/abort$/);
  const runId = matches && matches[1] ? matches[1] : '';
  const run = getNativeChatRun(runId);
  if (!run) {
    // 已完成/已清理：幂等成功，前端不用报错。
    writeJson(ctx.res, 200, { ok: true, runId, alreadyGone: true });
    return true;
  }
  try {
    if (typeof run.abort === 'function') run.abort();
    cancelApprovalsForRun(runId, 'aborted');
    unregisterNativeChatRun(runId);
    writeJson(ctx.res, 200, { ok: true, runId });
  } catch (error) {
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, run.provider, {
      ok: false,
      error: 'native_chat_abort_failed',
      message: String((error && error.message) || error || 'native_chat_abort_failed')
    }));
  }
  return true;
}

// POST /v0/webui/internal/approval-request —— claude 权限工具(MCP)打进来的审批请求(P3)。
// 【长挂】响应直到用户在 webUI 决策(decideApproval 回填)或工具端超时断开。
// 仅 loopback 可达；webui-auth-gate 只为该内部 POST ingress 保留窄白名单。
async function handleNativeApprovalInboundRequest(ctx) {
  const { readRequestBody, writeJson, getNativeChatRun } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 512 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const runId = normalizeString(payload && payload.runId);
  const entry = registerApprovalRequest({
    runId,
    toolName: payload && payload.toolName,
    input: payload && payload.input,
    toolUseId: payload && payload.toolUseId
  }, (decision) => {
    if (!ctx.res.writableEnded) writeJson(ctx.res, 200, decision);
  });
  // 发布到会话事件通道:live SSE 页与 detached watch 页都能弹审批卡。
  const run = typeof getNativeChatRun === 'function' ? getNativeChatRun(runId) : null;
  if (run && run.provider && run.sessionId) {
    publishNativeSessionEvent(ctx, {
      provider: run.provider,
      sessionId: run.sessionId,
      projectDirName: run.projectDirName,
      projectPath: run.projectPath
    }, {
      type: 'session:approval-request',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: entry.approvalId,
      prompt: toApprovalPrompt(entry)
    });
  }
  // 工具端断开(claude 被杀/超时)→ 清掉挂账,避免僵尸审批卡。
  attachAbortableRequestClose(ctx.req, () => {
    decideApproval(entry.approvalId, 'deny', 'approval_channel_closed');
  }, ctx.res);
  return true; // 响应由 decideApproval 回填,勿在此 end
}

// POST /v0/webui/chat/runs/:runId/approvals/:approvalId —— 前端的审批决策(P3)。
async function handleNativeApprovalDecisionRequest(ctx) {
  const { pathname, readRequestBody, writeJson, getNativeChatRun } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/approvals\/([^/]+)$/);
  const runId = matches && matches[1] ? decodeURIComponent(matches[1]) : '';
  const approvalId = matches && matches[2] ? decodeURIComponent(matches[2]) : '';
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const decision = normalizeString(payload && payload.decision) === 'allow' ? 'allow' : 'deny';
  const entry = decideApproval(approvalId, decision, payload && payload.message);
  if (!entry) {
    writeJson(ctx.res, 200, { ok: true, approvalId, alreadyResolved: true });
    return true;
  }
  const run = typeof getNativeChatRun === 'function' ? getNativeChatRun(runId) : null;
  if (run && run.provider && run.sessionId) {
    publishNativeSessionEvent(ctx, {
      provider: run.provider,
      sessionId: run.sessionId,
      projectDirName: run.projectDirName,
      projectPath: run.projectPath
    }, {
      type: 'session:approval-resolved',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: approvalId,
      reason: decision
    });
  }
  writeJson(ctx.res, 200, { ok: true, approvalId, decision });
  return true;
}

async function handleCliInstallConfirmationDecisionRequest(ctx) {
  const matches = ctx.pathname.match(/^\/v0\/webui\/chat\/cli-install-confirmations\/([^/]+)$/);
  const confirmationId = matches && matches[1] ? decodeURIComponent(matches[1]) : '';
  const payload = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const decision = normalizeString(payload && payload.decision).toLowerCase();
  if (!confirmationId || !['confirm', 'cancel'].includes(decision)) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_cli_install_confirmation' });
    return true;
  }

  const outcome = resolveCliInstallConfirmationRegistry(ctx)
    .decide(confirmationId, decision, 'user');
  if (!outcome) {
    ctx.writeJson(ctx.res, 404, {
      ok: false,
      error: 'cli_install_confirmation_expired',
      confirmationId
    });
    return true;
  }

  ctx.writeJson(ctx.res, 200, {
    ok: true,
    confirmationId,
    decision: outcome.decision
  });
  return true;
}

async function handleChatRequest(ctx) {
  const {
    options,
    readRequestBody,
    writeJson,
    fs,
    getToolConfigDir,
    getProfileDir,
    loadServerRuntimeAccounts,
    ensureSessionStoreLinks,
    registerNativeChatRun,
    unregisterNativeChatRun,
    createChatEventMeta
  } = ctx;

  const payload = await readRequestBody(ctx.req, { maxBytes: 10 * 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  if (!payload || !payload.messages) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }

  const {
    messages,
    mode: requestedChatMode,
    provider,
    accountRef: requestedAccountRef,
    gateway,
    stream,
    model: requestModel,
    prompt,
    createSession,
    sessionId,
    projectDirName,
    projectPath,
    images,
    // 会话级审批模式(P3):bypass(默认,现状)/ confirm(权限请求转发 webUI)/ plan(计划模式+确认)。
    approvalMode
  } = payload;

  const useAihServerProfile = Boolean(gateway) && supportsAihServerProfile(provider);
  const runtimeTarget = resolveRuntimeTarget({
    gateway: useAihServerProfile,
    accountRef: requestedAccountRef
  });
  if (!provider || !runtimeTarget) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'missing_account_info',
      detail: 'provider and either gateway=true or a valid accountRef are required'
    });
    return true;
  }
  const { accountRef } = runtimeTarget;
  const responseIdentity = serializeRuntimeTarget(runtimeTarget);
  const storedServerConfig = useAihServerProfile
    ? readServerConfig({ fs, aiHomeDir: ctx.aiHomeDir })
    : null;
  const nativeProcessEnv = useAihServerProfile
    ? {
        ...process.env,
        ...buildAihServerProfileEnv(provider, {
          ...storedServerConfig,
          port: options.port || storedServerConfig.port,
          apiKey: options.clientKey || storedServerConfig.apiKey
        })
      }
    : process.env;

  // P0: WebUI 会话走 aih-server 网关 profile(和 CLI `aih codex` 一致)——池化该 provider 全部账号
  // aih-server profile：网关凭据从 readServerConfig() 热读，不写文件。
  // buildBuiltinServerProfileEnv (runtime.js) 动态构建，无需持久化。
  let normalizedPrompt = String(
    prompt
    || (
      Array.isArray(messages)
        ? [...messages].reverse().find((message) => message && message.role === 'user' && String(message.content || '').trim())
        : null
    )?.content
    || ''
  ).trim();
  let persistedImagePaths = [];
  const apiKeyMode = !useAihServerProfile && (
    detectApiKeyMode(provider, accountRef, fs, ctx.aiHomeDir)
    || resolveRuntimeApiKeyMode(loadServerRuntimeAccounts, provider, accountRef)
  );

  // apikey codex 走 native 会话（native CLI 本就能用 API key）需要 config.toml 里有从账号凭据
  // (app-state.db 的 OPENAI_BASE_URL/OPENAI_API_KEY)生成的 [model_providers.<key>]，否则
  // gpt-5.5 这类自定义端点模型在 CLI 侧无法路由 → no_available_account。该 config-sync 原本只在
  // `aih codex` 终端启动时跑，webui native 路径不跑 → 远端(如 AWS)config 缺该段。这里在 spawn 前
  // 幂等补跑（best-effort，失败不阻塞——真缺凭据会在后续 native 报错里体现）。
  if (provider === 'codex' && apiKeyMode) {
    const syncGlobalConfigToHost = ctx.deps && ctx.deps.syncGlobalConfigToHost;
    if (typeof syncGlobalConfigToHost === 'function') {
      try { syncGlobalConfigToHost('codex', accountRef); } catch (_error) { /* best-effort */ }
    }
  }

  // 前置校验：未登录/未配置凭据的账号(如只有 config.toml、无 auth.json 的半成品 codex 账号)
  // 直接拒绝并给可操作报错，避免真去开 native 会话拿到隐晦的 401 native_session_failed。
  if (!useAihServerProfile && !nativeAccountHasCredentials(provider, accountRef, fs, ctx.aiHomeDir)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'account_not_configured',
      code: 'account_not_configured',
      message: `该账号（${provider} ${accountRef}）尚未登录或未配置凭据，无法发起会话。请重新登录该账号，或改用其他已登录的账号。`
    });
    return true;
  }

  if (Array.isArray(images) && images.length > 0) {
    try {
      persistedImagePaths = persistChatImages(images, {
        fs,
        provider,
        aiHomeDir: ctx.aiHomeDir,
        hostHomeDir: ctx.deps && ctx.deps.hostHomeDir,
        projectPath
      });
      normalizedPrompt = appendImagePathsToPrompt(normalizedPrompt, persistedImagePaths);
    } catch (error) {
      writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, provider, {
        ok: false,
        error: 'invalid_chat_images',
        message: String((error && error.message) || error || 'invalid_chat_images')
      }));
      return true;
    }
  }

  let slashMeta = null;
  try {
    slashMeta = validateNativeSlashCommand(provider, normalizedPrompt);
  } catch (error) {
    const code = String(error && error.code || 'native_slash_command_unsupported');
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, provider, {
      ok: false,
      error: code,
      code,
      message: String((error && error.message) || error || 'native_slash_command_unsupported'),
      commands: Array.isArray(error && error.commands) ? error.commands : []
    }));
    return true;
  }
  // opencode 也走 native（`opencode run --format json` headless，已验证可用），不再甩去 api-proxy
  // 导致 /chat 里 401/缺模型。之前把 opencode 排除在 webui native 之外是历史遗留。
  // 模型别名解析（native 路径此前不解析别名 → 用户在原生会话里选的自定义别名被原样塞给 CLI
  // → `claude --model <别名>` / `codex -m <别名>` 报错或落到错误模型）。/v1 网关走 v1-router 的
  // 别名解析，native 必须自己补上。只解析【同 provider】别名:native 绑定 provider+account,
  // 跨 provider 别名(如 claude-*→agy)是网关语义、无法在 native 里换号,保持原样交由上层。
  const effectiveRequestModel = (await resolveNativeAliasModel(ctx, provider, requestModel)) || requestModel;
  const isAgyImageModel = (provider === 'agy' || provider === 'gemini') && isImageGenerationModel(effectiveRequestModel);

  // opencode 也走 native（`opencode run --format json` headless，已验证可用），不再甩去 api-proxy
  // 导致 /chat 里 401/缺模型。之前把 opencode 排除在 webui native 之外是历史遗留。
  const webuiNativeSessionProvider = isOfficialNativeSessionProvider(provider);
  // slash 命令的意义就是交互(如 /model 弹选择器切模型)——一律走交互终端(xterm),包括 agy。
  // 普通对话才走 headless(agy 用 --print),二者分开:普通稳、slash 可交互。生图模型不具备 CLI 交互环境，不进交互终端。
  const useInteractiveNativeSlash = Boolean(
    webuiNativeSessionProvider
    && slashMeta
    && slashMeta.isSlashCommand
    && !isAgyImageModel
  );
  // agy/gemini 生图模型（如 gemini-3.1-flash-image）必须跳过本地 Native CLI，改走 API 网关流式生图通道
  const useOfficialNativeSession = Boolean(
    webuiNativeSessionProvider
    && !useInteractiveNativeSlash
    && !isAgyImageModel
    && normalizedPrompt
  );
  const nativeSessionModel = normalizeNativeSessionModel(provider, effectiveRequestModel, apiKeyMode);
  const resolvedProjectDirName = resolveNativeProjectDirName(provider, projectDirName, projectPath);

  // slash command 是真实 CLI 进程的能力，与账号用 OAuth 还是 API key 鉴权无关——
  // 真实 CLI 带 API key（ANTHROPIC_API_KEY 等）同样能启动并执行 slash。因此 slash 一律走
  // native，不再被 apiKeyMode 甩去 /v1 代理（旧实现会让 API-key 账号丢掉 slash 能力）。
  // 普通消息仍保留原有路由：apiKeyMode 账号（可能指向自定义 base_url 的第三方端点）走代理，
  // 避免改动既有对外行为。
  // apikey 账号也走 native（native CLI 能用 API key → 拿到真会话:sessionId/持久化/隔离/续接，
  // 而非无状态 api-proxy 补全）。codex：spawn 前 config-sync 生成 [model_providers]（env_key）；
  // claude：buildProviderEnv 加载账号 DB 凭据的 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL 进
  // spawn env。opencode apikey 的 native 凭据注入待验证，暂不放行。
  const apiKeyNativeReady = provider === 'codex' || provider === 'claude';
  const isExplicitPureChatMode = requestedChatMode === 'chat' || (!projectPath && !projectDirName);
  const runNativeInteractive = !isExplicitPureChatMode && (sessionId || createSession) && normalizedPrompt && (
    useInteractiveNativeSlash || (useOfficialNativeSession && (!apiKeyMode || apiKeyNativeReady))
  );
  if (runNativeInteractive) {
    // claude/codex/opencode 普通会话走 headless 流式（claude: --print stream-json；
    // codex: exec --json；opencode: run --format json），输出结构化 JSONL、干净可解析、
    // 不卡在交互 TUI。slash 命令仍走交互式 PTY。
    const useHeadlessStream = (
      provider === 'claude'
      || provider === 'codex'
      || provider === 'opencode'
      || provider === 'qoder'
      || provider === 'qodercn'
      || provider === 'grok'
    )
      && useOfficialNativeSession && !useInteractiveNativeSlash;
    const nativeCliInteractive = !useHeadlessStream;
    // 普通会话不再强制走终端。agy 改用 headless `--print`(见 native-session-chat 的 agy 分支):
    // 干净结构化回复、跳过首次引导、正常「完成」→ 稳定不卡"正在处理"。终端(xterm)能力保留给
    // slash 命令(以及将来显式「打开终端」),不再对 agy 默认强制,避免 WebUI 一直卡在 TUI 里。
    const useTerminalMode = useInteractiveNativeSlash;
    // agy 用 --print,输出是干净模型回复、不存在交互式菜单;关掉 interactive-prompt 抓取,
    // 避免回复里偶发的编号列表/“press Enter”被误判成需要确认的 prompt。
    const suppressInteractivePrompt = provider === 'agy';
    const normalizedApprovalMode = normalizeApprovalMode(approvalMode);
    // codex confirm/plan(P3b)：exec --json 是单向输出流、无法回带审批决策，改走 app-server
    // JSON-RPC runner(每账号 tmux 常驻 + ws,审批经审批桥往返)。bypass 与其他 provider 零变化。
    const useCodexAppServerRunner = provider === 'codex'
      && useHeadlessStream
      && approvalModeNeedsBridge(normalizedApprovalMode);
    // opencode confirm/plan(P3c)：headless run(--dangerously-skip-permissions)无权限回路，
    // 改走常驻 `opencode serve` HTTP API runner(会话级注入 ask 规则,permission.asked 经审批桥
    // 往返 webUI)。bypass 保持现状 run 路径零变化。
    const useOpenCodeServeRunner = provider === 'opencode'
      && useHeadlessStream
      && approvalModeNeedsBridge(normalizedApprovalMode);
    try {
      if (provider === 'codex' && projectPath) {
        ensureCodexHooksEnabled({ fs });
        ensureCodexProjectRegistered(projectPath, {
          fs
        });
      }
      const {
        runNativeSessionPrompt,
        spawnNativeSessionStream,
        classifyNativeSessionFailure,
        ensureNativeCliReadyForChat
      } = require('./native-session-chat');
      if (stream !== false) {
        const startedAt = Date.now();
        let firstTokenAt = 0;
        const fallbackAccountRefs = useAihServerProfile
          ? []
          : resolveNativeFallbackAccountRefs(loadServerRuntimeAccounts, provider, accountRef);
        const attemptAccountRefs = [accountRef, ...fallbackAccountRefs];
        let currentStream = null;
        ctx.res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive'
        });
        if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();

        let streamClosed = false;
        const writeSse = (payloadItem) => {
          if (streamClosed || ctx.res.writableEnded) return;
          ctx.res.write(`data: ${JSON.stringify(canonicalizeChatPayload(ctx, provider, payloadItem))}\n\n`);
        };

        let cliInstallConfirmationId = '';
        const cliReadiness = await ensureNativeCliReadyForChat(provider, {
          env: nativeProcessEnv,
          confirmInstall: async () => {
            const outcome = await requestCliInstallConfirmation(ctx, provider, (event) => {
              cliInstallConfirmationId = event.confirmationId;
              writeSse({
                ...event,
                ...createChatEventMeta(startedAt)
              });
            });
            return outcome;
          },
          onProgress: (progress) => writeSse({
            type: 'cli-install-progress',
            provider,
            ...(cliInstallConfirmationId ? { confirmationId: cliInstallConfirmationId } : {}),
            ...progress,
            ...createChatEventMeta(startedAt)
          })
        });
        if (!cliReadiness.ok) {
          writeSse({
            type: 'error',
            code: cliReadiness.cancelled ? 'cli_install_cancelled' : 'cli_not_found',
            message: cliReadiness.message,
            ...(cliInstallConfirmationId ? { confirmationId: cliInstallConfirmationId } : {}),
            ...createChatEventMeta(startedAt)
          });
          streamClosed = true;
          ctx.res.end();
          return true;
        }

        const createAttemptStream = (attemptIndex) => {
          const attemptAccountRef = attemptAccountRefs[attemptIndex];
          const bufferedEvents = [];
          let attemptVisible = false;
          const handleStreamEvent = (event) => {
            if (!event) return;
            if (!useTerminalMode && event.type === 'terminal-output') {
              return;
            }
            // 新建会话拿到真实 sessionId 后立即回填 run handle，并补发 turn-started：
            // detached 重连（GET /runs?sessionId= / sessions/watch）都按 sessionId 找 run，
            // 不回填的话新会话在跑完前对刷新后的页面完全不可见。
            if (event.type === 'session-created' && event.sessionId && nativeRunHandle
              && !nativeRunHandle.sessionId) {
              nativeRunHandle.sessionId = normalizeString(event.sessionId);
              publishNativeSessionEvent(ctx, {
                provider,
                sessionId: nativeRunHandle.sessionId,
                projectDirName: resolvedProjectDirName,
                projectPath
              }, {
                type: 'session:turn-started',
                reason: 'native_session_created',
                phase: 'turn-started',
                at: Date.now(),
                runId: nativeRunHandle.runId
              });
            }
            // 交互 prompt 的出现/清除同步发布到会话事件通道：detached（刷新/断连重连）的
            // 客户端靠 sessions/watch 也能弹出/收起 PlanChoiceDock，回答走 runs/:runId/input。
            if (event.type === 'interactive-prompt' || event.type === 'interactive-prompt-cleared') {
              publishNativeSessionEvent(ctx, {
                provider,
                sessionId: (nativeRunHandle && nativeRunHandle.sessionId) || sessionId,
                projectDirName: resolvedProjectDirName,
                projectPath
              }, event.type === 'interactive-prompt'
                ? {
                    type: 'session:interactive-prompt',
                    phase: 'interactive-prompt',
                    at: Date.now(),
                    runId: nativeRunHandle && nativeRunHandle.runId,
                    prompt: event.prompt
                  }
                : {
                    type: 'session:interactive-prompt-cleared',
                    phase: 'interactive-prompt',
                    at: Date.now(),
                    runId: nativeRunHandle && nativeRunHandle.runId,
                    promptId: event.promptId,
                    reason: event.reason
                  });
            }
            if (event.type === 'retry-status') {
              publishNativeSessionEvent(ctx, {
                provider,
                sessionId: (nativeRunHandle && nativeRunHandle.sessionId) || sessionId,
                projectDirName: resolvedProjectDirName,
                projectPath
              }, {
                type: 'session:retry-status',
                phase: event.phase,
                at: Date.now(),
                runId: nativeRunHandle && nativeRunHandle.runId,
                retryStatus: event
              });
            }
            const eventPayload = {
              ...event,
              runId: nativeRunHandle.runId,
              ...createChatEventMeta(startedAt, firstTokenAt
                ? { firstTokenElapsedMs: firstTokenAt - startedAt }
                : {})
            };
            if (useTerminalMode) {
              writeSse(eventPayload);
              return;
            }
            // 交互 prompt 需要用户立刻响应，不能进「首 token 前缓冲」（agy/gemini 的 PTY 轮
            // 可能整轮都卡在 prompt 上、永远等不到首个 delta → 死锁），直接写通。
            if (event.type === 'interactive-prompt'
              || event.type === 'interactive-prompt-cleared'
              || event.type === 'retry-status') {
              writeSse(eventPayload);
              return;
            }
            if (event.type === 'delta' || event.type === 'result') {
              if (!firstTokenAt) firstTokenAt = Date.now();
              if (!attemptVisible) {
                attemptVisible = true;
                bufferedEvents.forEach((item) => writeSse(item));
                bufferedEvents.length = 0;
              }
              writeSse({
                ...event,
                runId: nativeRunHandle.runId,
                ...createChatEventMeta(startedAt, {
                  firstTokenElapsedMs: firstTokenAt - startedAt
                })
              });
              return;
            }
            if (event.type === 'error') {
              return;
            }
            bufferedEvents.push(eventPayload);
          };
          const streamInstance = useCodexAppServerRunner
            ? require('./codex-app-server-runner').startCodexAppServerTurn({
              accountRef: attemptAccountRef,
              gateway: useAihServerProfile,
              sessionId,
              projectDirName: resolvedProjectDirName,
              projectPath,
              prompt: normalizedPrompt,
              imagePaths: persistedImagePaths,
              model: nativeSessionModel,
              approvalMode: normalizedApprovalMode,
              getProfileDir,
              env: nativeProcessEnv,
              aiHomeDir: ctx.aiHomeDir,
              sessionEventBus: ctx.deps && ctx.deps.sessionEventBus,
              onEvent: handleStreamEvent
            })
            : useOpenCodeServeRunner
            ? require('./opencode-serve-runner').startOpenCodeServeTurn({
              accountRef: attemptAccountRef,
              gateway: useAihServerProfile,
              sessionId,
              projectDirName: resolvedProjectDirName,
              projectPath,
              prompt: normalizedPrompt,
              model: nativeSessionModel,
              getProfileDir,
              env: nativeProcessEnv,
              aiHomeDir: ctx.aiHomeDir,
              sessionEventBus: ctx.deps && ctx.deps.sessionEventBus,
              onEvent: handleStreamEvent
            })
            : spawnNativeSessionStream({
              provider,
              accountRef: attemptAccountRef,
              gateway: useAihServerProfile,
              sessionId,
              projectDirName: resolvedProjectDirName,
              projectPath,
              prompt: useOfficialNativeSession ? normalizedPrompt : '',
              initialInput: useInteractiveNativeSlash ? normalizedPrompt : '',
              interactiveCli: nativeCliInteractive,
              emitTerminalOutput: useTerminalMode,
              // terminalMode(slash/显式终端):只发原始 terminal-output 供 xterm 渲染,不抓
              // interactive-prompt(否则前端同时弹 TerminalDock+坏的 acknowledge)、不收编暖机 LS。
              terminalMode: useTerminalMode,
              // agy headless(--print):关掉 interactive-prompt 抓取 + 不收编暖机 LS(--print 跑完即退)。
              suppressInteractivePrompt,
              // agy --print 实测是【流式 stdout】(逐段吐字)。把 stdout 直接作为 delta 事件推给前端做
              // 真流式,而不是等整轮跑完一次性 done(之前 firstTokenElapsedMs=null、16s 后才蹦出来)。
              streamRawStdout: provider === 'agy' && !useTerminalMode,
              // 终端模式是常驻交互进程；agy transcript 的 PLANNER_RESPONSE 也只是阶段性输出。
              // 两者都必须等待进程自身退出，不能在 transcript 首次更新时提前结束本轮。
              completeOnTranscriptUpdate: provider !== 'agy'
                && useOfficialNativeSession
                && !useHeadlessStream
                && !useTerminalMode,
              imagePaths: persistedImagePaths,
              model: nativeSessionModel,
              getProfileDir,
              ensureSessionStoreLinks,
              env: nativeProcessEnv,
              // tmux 化 run 的清单/日志落盘根（server 重启后据此收养仍在跑的 run）。
              aiHomeDir: ctx.aiHomeDir,
              accountRuntimeEventHub: ctx.deps && ctx.deps.accountRuntimeEventHub,
              accountStateService: ctx.deps && ctx.deps.accountStateService,
              // 会话级审批模式(P3):confirm/plan 时 claude 挂权限工具,请求打回本机审批桥。
              approvalMode: normalizedApprovalMode,
              approvalRequestUrl: `http://127.0.0.1:${options.port || DEFAULT_SERVER_PORT}/v0/webui/internal/approval-request`,
              onEvent: handleStreamEvent
            });
          return {
            attemptAccountRef,
            bufferedEvents,
            wasVisible() {
              return attemptVisible;
            },
            streamInstance
          };
        };
        let nativeRunHandle = null;
        const initialAttempt = createAttemptStream(0);
        currentStream = initialAttempt.streamInstance;
        nativeRunHandle = {
          runId: currentStream.runId || (typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `native-stream-${Date.now()}-${Math.random().toString(16).slice(2)}`),
          provider,
          ...responseIdentity,
          sessionId,
          projectDirName: resolvedProjectDirName,
          projectPath: normalizeString(projectPath),
          startedAt,
          interactionMode: useTerminalMode ? 'terminal' : 'default',
          // detached 重连时恢复待回答的交互 prompt（GET /v0/webui/chat/runs 返回 activePrompt）。
          getActivePrompt() {
            return currentStream && typeof currentStream.getActivePrompt === 'function'
              ? (currentStream.getActivePrompt() || null)
              : null;
          },
          abort() {
            if (currentStream && typeof currentStream.abort === 'function') {
              currentStream.abort();
            }
          },
          writeInput(input, writeOptions = {}) {
            if (!currentStream || typeof currentStream.writeInput !== 'function') {
              const error = new Error('native_session_run_not_active');
              error.code = 'native_session_run_not_active';
              throw error;
            }
            return currentStream.writeInput(input, writeOptions);
          },
          writeSteer(text) {
            if (!currentStream || typeof currentStream.writeSteer !== 'function') {
              const error = new Error('native_steer_unsupported');
              error.code = 'native_steer_unsupported';
              throw error;
            }
            return currentStream.writeSteer(text);
          },
          resize(cols, rows) {
            if (!currentStream || typeof currentStream.resize !== 'function') {
              const error = new Error('native_session_run_not_active');
              error.code = 'native_session_run_not_active';
              throw error;
            }
            return currentStream.resize(cols, rows);
          }
        };
        registerNativeChatRun(nativeRunHandle);
        // 被动断连（浏览器导航/刷新、跨境代理抖动 → SSE close）**只 detach 不 kill**：停止往已关的
        // SSE 写，但让 native run 在后台跑完（CLI 写进自己的会话库、done 时刷新快照）。这样长任务
        // （如 opencode 并行子代理 review 综合，耗时几分钟）不会被一次断连腰斩成"看着没处理完"，
        // 重连后读 session messages 就能看到完整结果——对齐"关终端不丢"的持久会话理念。
        // run 不在这里 unregister（保持注册以便重连交互/显式 abort 找到它），完成/失败路径会 unregister。
        // 真正的终止走【显式 stop】→ POST /runs/:runId/abort（handleNativeChatRunAbortRequest）。
        const closeStream = () => {
          if (streamClosed) return;
          streamClosed = true;
          // 不 abort、不 unregister：run 继续，SSE 写入自然 no-op（writableEnded）。
        };

        attachAbortableRequestClose(ctx.req, closeStream, ctx.res);
        writeSse({
          type: 'ready',
          mode: 'native-session',
          provider,
          ...responseIdentity,
          sessionId,
          runId: nativeRunHandle.runId,
          interactionMode: useTerminalMode ? 'terminal' : 'default',
          slashCommand: useInteractiveNativeSlash ? normalizedPrompt : '',
          createSession: Boolean(createSession && !sessionId),
          ...createChatEventMeta(startedAt)
        });
        publishNativeSessionEvent(ctx, {
          provider,
          sessionId,
          projectDirName: resolvedProjectDirName,
          projectPath
        }, {
          type: 'session:turn-started',
          reason: 'native_session_ready',
          phase: 'turn-started',
          at: startedAt,
          runId: nativeRunHandle.runId
        });

        const runAttempt = async (attemptIndex, existingAttempt = null) => {
          const attempt = existingAttempt || createAttemptStream(attemptIndex);
          currentStream = attempt.streamInstance;
          try {
            const result = await currentStream.done;
            if (!attempt.wasVisible()) {
              attempt.bufferedEvents.forEach((item) => writeSse(item));
            }
            return {
              result,
              attemptAccountRef: attempt.attemptAccountRef
            };
          } catch (error) {
            const classifiedFailure = classifyNativeSessionFailure(provider, error);
            const canRetry = !useInteractiveNativeSlash
              && classifiedFailure.retryAnotherAccount === true
              && attemptIndex < attemptAccountRefs.length - 1
              && !firstTokenAt;
            if (canRetry) {
              return runAttempt(attemptIndex + 1);
            }
            throw error;
          }
        };

        // 注意：完成/失败的收尾（会话索引、快照刷新、session:turn-* 事件发布）必须在
        // 「streamClosed 早退」之前执行——被动断连(detached)后 SSE 已关，但后台 run 跑完时
        // 仍要让 sessions/watch 的订阅者（刷新后重连的页面）收到 turn-completed/failed、
        // 且新会话要进项目快照。否则 detached run 结束后页面永远停在"运行中"。
        runAttempt(0, initialAttempt).then(async ({ result, attemptAccountRef }) => {
          cancelApprovalsForRun(nativeRunHandle.runId, 'run_finished');
          unregisterNativeChatRun(nativeRunHandle.runId);
          const doneAt = Date.now();
          const firstTokenElapsedMs = firstTokenAt ? (firstTokenAt - startedAt) : null;
          const resolvedSessionId = String(result && result.sessionId || sessionId || '');
          nativeRunHandle.sessionId = resolvedSessionId;
          // 只要是「新建会话」这一轮就刷新项目快照——即使 resolvedSessionId 为空（codex 推断
          // 超时等），新会话也已落盘，必须刷新缓存，否则刷新页面列表看不到。
          if (createSession && !sessionId) {
            // codex 新会话若 rollout/DB 解析不出标题会被列表过滤（'未命名会话'），导致刷新后不可见。
            // 用本轮 prompt 作标题补一条 session_index 条目，让 reader 给它一个标题 → 列表可见。
            if (provider === 'codex' && resolvedSessionId) {
              try {
                require('./native-session-chat').ensureCodexSessionIndexEntry({
                  sessionId: resolvedSessionId,
                  prompt: normalizedPrompt
                });
              } catch (_error) {
                // best effort
              }
            }
            // agy 存储无 cwd → 写 sessionId→projectPath 索引，readAgyProjectsFromHost 据此入列表。
            if (provider === 'agy' && resolvedSessionId && projectPath) {
              try {
                require('./native-session-chat').ensureAgySessionProjectIndex({
                  sessionId: resolvedSessionId,
                  projectPath
                });
              } catch (_error) {
                // best effort
              }
            }
            try {
              await refreshProjectsSnapshotAfterNativeSession(ctx, provider, resolvedSessionId, resolvedProjectDirName, {
                accountRef: attemptAccountRef
              });
            } catch (_error) {
              // best effort; done event should not be blocked forever by snapshot refresh failures
            }
          }
          recordNativeSessionModelUsage(ctx, {
            provider,
            sessionId: resolvedSessionId,
            accountRef: attemptAccountRef,
            model: effectiveRequestModel,
            runId: nativeRunHandle.runId
          });
          recordNativeAccountRuntimeSuccess({
            provider,
            accountRef: attemptAccountRef,
            aiHomeDir: ctx.aiHomeDir,
            accountRuntimeEventHub: ctx.deps && ctx.deps.accountRuntimeEventHub,
            accountStateService: ctx.deps && ctx.deps.accountStateService,
            source: 'webui_native_session',
            happenedAt: doneAt
          });
          publishNativeSessionEvent(ctx, {
            provider,
            sessionId: resolvedSessionId,
            projectDirName: resolvedProjectDirName,
            projectPath
          }, {
            type: 'session:turn-completed',
            reason: 'native_session_done',
            phase: 'turn-completed',
            at: doneAt,
            runId: nativeRunHandle.runId
          });
          if (streamClosed || ctx.res.writableEnded) return;
          writeSse({
            type: 'done',
            mode: 'native-session',
            provider,
            ...(useAihServerProfile ? responseIdentity : { accountRef: attemptAccountRef }),
            runId: nativeRunHandle.runId,
            sessionId: resolvedSessionId,
            content: result && typeof result.content === 'string' ? result.content : '',
            ...createChatEventMeta(startedAt, {
              firstTokenElapsedMs,
              totalElapsedMs: doneAt - startedAt
            })
          });
          streamClosed = true;
          ctx.res.end();
        }).catch((error) => {
          cancelApprovalsForRun(nativeRunHandle.runId, 'run_finished');
          unregisterNativeChatRun(nativeRunHandle.runId);
          const errorAt = Date.now();
          const classifiedFailure = classifyNativeSessionFailure(provider, error);
          publishNativeSessionEvent(ctx, {
            provider,
            sessionId: nativeRunHandle.sessionId || sessionId,
            projectDirName: resolvedProjectDirName,
            projectPath
          }, {
            type: 'session:turn-failed',
            reason: String(classifiedFailure.code || error && error.code || 'native_session_failed'),
            phase: 'turn-failed',
            at: errorAt,
            runId: nativeRunHandle.runId
          });
          if (streamClosed || ctx.res.writableEnded) return;
          writeSse({
            type: 'error',
            runId: nativeRunHandle.runId,
            code: String(classifiedFailure.code || error && error.code || 'native_session_failed'),
            message: String(classifiedFailure.message || (error && error.message) || error || 'native_session_failed'),
            ...createChatEventMeta(startedAt, {
              firstTokenElapsedMs: firstTokenAt ? (firstTokenAt - startedAt) : null,
              totalElapsedMs: errorAt - startedAt
            })
          });
          streamClosed = true;
          ctx.res.end();
        });
        return true;
      }

      const cliReadiness = await ensureNativeCliReadyForChat(provider, { env: nativeProcessEnv });
      if (!cliReadiness.ok) {
        writeJson(ctx.res, cliReadiness.confirmationRequired ? 409 : 400, canonicalizeChatPayload(ctx, provider, {
          ok: false,
          error: cliReadiness.confirmationRequired
            ? 'cli_install_confirmation_required'
            : 'cli_not_found',
          code: cliReadiness.confirmationRequired
            ? 'cli_install_confirmation_required'
            : 'cli_not_found',
          message: cliReadiness.message
        }));
        return true;
      }

      publishNativeSessionEvent(ctx, {
        provider,
        sessionId,
        projectDirName: resolvedProjectDirName,
        projectPath
      }, {
        type: 'session:turn-started',
        reason: 'native_session_ready',
        phase: 'turn-started',
        at: Date.now()
      });
      const nativeResult = await runNativeSessionPrompt({
        provider,
        accountRef,
        gateway: useAihServerProfile,
        sessionId,
        projectDirName: resolvedProjectDirName,
        projectPath,
        prompt: normalizedPrompt,
        imagePaths: persistedImagePaths,
        model: nativeSessionModel,
        getProfileDir,
        ensureSessionStoreLinks,
        env: nativeProcessEnv,
        aiHomeDir: ctx.aiHomeDir
      });
      recordNativeAccountRuntimeSuccess({
        provider,
        accountRef,
        aiHomeDir: ctx.aiHomeDir,
        accountRuntimeEventHub: ctx.deps && ctx.deps.accountRuntimeEventHub,
        accountStateService: ctx.deps && ctx.deps.accountStateService,
        source: 'webui_native_session',
        happenedAt: Date.now()
      });
      const resolvedSessionId = String(nativeResult && nativeResult.sessionId || sessionId || '');
      // 新建会话这一轮一律刷新快照（即使 resolvedSessionId 为空），避免新会话落盘但列表缓存陈旧。
      if (createSession && !sessionId) {
        if (provider === 'codex' && resolvedSessionId) {
          try {
            require('./native-session-chat').ensureCodexSessionIndexEntry({
              sessionId: resolvedSessionId,
              prompt: normalizedPrompt
            });
          } catch (_error) {
            // best effort
          }
        }
        if (provider === 'agy' && resolvedSessionId && projectPath) {
          try {
            require('./native-session-chat').ensureAgySessionProjectIndex({
              sessionId: resolvedSessionId,
              projectPath
            });
          } catch (_error) {
            // best effort
          }
        }
        try {
          await refreshProjectsSnapshotAfterNativeSession(ctx, provider, resolvedSessionId, resolvedProjectDirName, {
            accountRef
          });
        } catch (_error) {
          // best effort
        }
      }
      publishNativeSessionEvent(ctx, {
        provider,
        sessionId: resolvedSessionId,
        projectDirName: resolvedProjectDirName,
        projectPath
      }, {
        type: 'session:turn-completed',
        reason: 'native_session_done',
        phase: 'turn-completed',
        at: Date.now()
      });
      writeJson(ctx.res, 200, canonicalizeChatPayload(ctx, provider, {
        ok: true,
        provider,
        ...responseIdentity,
        sessionId: resolvedSessionId,
        mode: 'native-session',
        content: nativeResult.content || ''
      }));
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      const code = String(error && error.code || '');
      publishNativeSessionEvent(ctx, {
        provider,
        sessionId,
        projectDirName: resolvedProjectDirName,
        projectPath
      }, {
        type: 'session:turn-failed',
        reason: code || 'native_session_failed',
        phase: 'turn-failed',
        at: Date.now()
      });
      const statusCode = (
        code === 'native_session_invalid_context'
        || code === 'native_session_resume_unsupported'
        || code === 'missing_session_id'
        || code === 'empty_prompt'
      ) ? 400 : 500;
      const failure = {
        ok: false,
        error: 'native_session_failed',
        code,
        message: msg
      };
      if (finishStartedChatStream(ctx, provider, {
        ...failure,
        mode: 'native-session'
      })) return true;
      writeJson(ctx.res, statusCode, canonicalizeChatPayload(ctx, provider, failure));
      return true;
    }
  }

  let model = effectiveRequestModel || requestModel || null;
  if (!model) {
    try {
      const configDir = getToolConfigDir(provider, accountRef, { gateway: useAihServerProfile });
      const configPath = require('node:path').join(configDir, 'config.toml');
      if (fs.existsSync(configPath)) {
        const tomlContent = fs.readFileSync(configPath, 'utf8');
        const modelMatch = tomlContent.match(/^model\s*=\s*["']([^"']+)["']/m);
        if (modelMatch) model = modelMatch[1];
      }
    } catch (_error) {}
  }
  if (!model) {
    model = resolveProviderDefaultModel(provider, '', {
      state: ctx.state,
      accountRef
    });
  }

  const baseApiProxyMessages = buildApiProxyMessages(messages, images, { model, provider });
  let opencodeTurn = null;
  let opencodeSessionId = normalizeString(sessionId);
  if (provider === 'opencode' && (opencodeSessionId || createSession)) {
    try {
      opencodeTurn = beginOpenCodeApiProxyTurn({
        sessionId: opencodeSessionId,
        projectPath,
        prompt: normalizedPrompt,
        model
      });
      opencodeSessionId = opencodeTurn.sessionId;
    } catch (error) {
      writeJson(ctx.res, 500, canonicalizeChatPayload(ctx, provider, {
        ok: false,
        error: 'opencode_session_store_failed',
        code: String(error && error.code || ''),
        message: String((error && error.message) || error || 'opencode_session_store_failed')
      }));
      return true;
    }
  }
  const apiProxyMessages = provider === 'opencode'
    ? buildOpenCodeApiProxyMessages(baseApiProxyMessages, opencodeSessionId)
    : baseApiProxyMessages;

  const chatRequest = {
    model,
    messages: injectProjectContextMessage(
      apiProxyMessages,
      buildProjectContextMessage(fs, projectPath)
    ),
    stream: stream || false,
    ...(provider === 'opencode'
      ? { session_id: opencodeSessionId || normalizeString(sessionId) }
      : {})
  };

  if (
    provider === 'claude'
    && apiKeyMode
    && isAnthropicCompatibleClaudeBaseUrl(readClaudeApiSettings(accountRef, fs, ctx.aiHomeDir).baseUrl)
  ) {
    return handleClaudeAnthropicCompatibleChat(ctx, {
      provider,
      accountRef,
      model,
      messages: chatRequest.messages,
      stream: stream || false
    });
  }

  try {
    const { fetchWithTimeout } = require('./http-utils');
    const apiUrl = `http://127.0.0.1:${options.port || DEFAULT_SERVER_PORT}/v1/chat/completions`;
    const proxyTimeoutMs = isImageGenerationModel(model) ? 120000 : 60000;
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.clientKey || 'dummy'}`,
        'X-Provider': provider,
        ...(!useAihServerProfile ? { 'X-Account-Ref': accountRef } : {})
      },
      body: JSON.stringify(chatRequest)
    }, proxyTimeoutMs);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      writeJson(ctx.res, response.status, {
        ok: false,
        error: 'upstream_error',
        message: humanizeUpstreamError(errorText, {
          status: response.status,
          model,
          provider
        })
      });
      return true;
    }

    if (stream) {
      const startedAt = Date.now();
      let firstTokenAt = 0;
      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();
      const writeSse = (payloadItem) => {
        if (ctx.res.writableEnded) return;
        ctx.res.write(`data: ${JSON.stringify(canonicalizeChatPayload(ctx, provider, payloadItem))}\n\n`);
      };
      const chatSessionId = sessionId || ('chat-' + startedAt);
      writeSse({
        type: 'ready',
        mode: 'api-proxy',
        provider,
        accountRef,
        sessionId: chatSessionId,
        interactionMode: 'default',
        ...createChatEventMeta(startedAt)
      });
      if (createSession || (requestedChatMode === 'chat' || isExplicitPureChatMode)) {
        writeSse({
          type: 'session-created',
          sessionId: chatSessionId,
          mode: 'api-proxy',
          ...createChatEventMeta(startedAt)
        });
      }
      const adapter = createOpenAiChunkAdapter(writeSse, () => createChatEventMeta(startedAt, firstTokenAt
        ? { firstTokenElapsedMs: firstTokenAt - startedAt }
        : {}));
      const reader = response.body && typeof response.body.getReader === 'function'
        ? response.body.getReader()
        : null;
      if (!reader) {
        writeSse({
          type: 'error',
          code: 'api_proxy_stream_unavailable',
          message: 'api_proxy_stream_unavailable',
          mode: 'api-proxy',
          ...createChatEventMeta(startedAt)
        });
        ctx.res.end();
        return true;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let clientDisconnected = false;
      let streamClosed = false;
      const closeStream = () => {
        clientDisconnected = true;
      };
      attachAbortableRequestClose(ctx.req, closeStream, ctx.res);
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const rawBlock = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);
            if (rawBlock) {
              const payloadText = rawBlock
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n');
              if (payloadText && payloadText !== '[DONE]') {
                try {
                  const parsed = JSON.parse(payloadText);
                  const deltaText = String(
                    parsed
                    && parsed.choices
                    && parsed.choices[0]
                    && parsed.choices[0].delta
                    && parsed.choices[0].delta.content
                    || ''
                  );
                  if (deltaText && !firstTokenAt) firstTokenAt = Date.now();
                  adapter.handleChunk(parsed);
                } catch (_error) {}
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
          if (done) break;
          if (ctx.res.writableEnded || clientDisconnected) { /* continue reading upstream in background */ }
        }
      } finally {
        try {
          if (typeof reader.releaseLock === 'function') {
            reader.releaseLock();
          }
        } catch (_error) {}
      }
      const adapterState = adapter.getState();
      if (opencodeTurn) {
        try {
          completeOpenCodeApiProxyTurn({
            turn: opencodeTurn,
            projectPath,
            content: adapterState.content,
            model,
            finishReason: adapterState.finishReason,
            startedMs: startedAt
          });
          await refreshProjectsSnapshotAfterNativeSession(ctx, provider, opencodeTurn.sessionId, resolvedProjectDirName);
        } catch (_error) {
          // The upstream response has already succeeded; keep the SSE turn alive
          // and let the next project refresh recover from the session DB.
        }
      }
                  // 纯聊天模式 (Chat)：自动同步保存会话到 chatStore (~/.aih/chat-sessions)
      if (requestedChatMode === 'chat' || isExplicitPureChatMode) {
        try {
          const chatStore = require('./webui-chat-store');
          const effectiveSessionId = sessionId || (adapterState && adapterState.sessionId) || ('chat-' + startedAt);
          const durationMs = Date.now() - startedAt;
          const ttftMs = firstTokenAt && firstTokenAt >= startedAt ? (firstTokenAt - startedAt) : undefined;
          const totalContent = adapterState.reasoning
            ? (':::thinking\n' + adapterState.reasoning + '\n:::\n\n' + (adapterState.content || ''))
            : adapterState.content;
          chatStore.appendMessageToChatSession(
            effectiveSessionId,
            normalizedPrompt,
            totalContent,
            {
              provider,
              model,
              accountRef,
              metrics: {
                durationMs,
                ttftMs,
              }
            },
            ctx.hostHomeDir || (ctx.deps && ctx.deps.hostHomeDir)
          );
        } catch (_err) {}
      }
      adapter.finalize();
      ctx.res.end();
    } else {
      const data = await response.json();
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      if (opencodeTurn) {
        try {
          completeOpenCodeApiProxyTurn({
            turn: opencodeTurn,
            projectPath,
            content,
            model: data.model || model,
            usage: data.usage,
            finishReason: data.choices && data.choices[0] && data.choices[0].finish_reason,
            startedMs: Date.now()
          });
          await refreshProjectsSnapshotAfterNativeSession(ctx, provider, opencodeTurn.sessionId, resolvedProjectDirName);
        } catch (_error) {
          // best effort
        }
      }

      writeJson(ctx.res, 200, canonicalizeChatPayload(ctx, provider, {
        ok: true,
        content,
        model: data.model,
        usage: data.usage,
        sessionId: opencodeTurn
          ? requireOpenCodeTurnSessionId(opencodeTurn)
          : resolveApiProxyJsonSessionId(data)
      }));
    }

    return true;
  } catch (error) {
    const failure = {
      ok: false,
      error: 'chat_failed',
      message: String((error && error.message) || error || 'unknown')
    };
    if (finishStartedChatStream(ctx, provider, {
      ...failure,
      mode: 'api-proxy'
    })) return true;
    writeJson(ctx.res, 500, canonicalizeChatPayload(ctx, provider, failure));
    return true;
  }
}

module.exports = {
  handleGetChatAttachmentRequest,
  handleGetSlashCommandsRequest,
  handleNativeChatRunListRequest,
  handleNativeChatRunInputRequest,
  handleNativeChatRunResizeRequest,
  handleNativeChatRunAbortRequest,
  handleNativeApprovalInboundRequest,
  handleNativeApprovalDecisionRequest,
  handleCliInstallConfirmationDecisionRequest,
  handleChatRequest,
  resolveNativeAliasModel,
  normalizeNativeSessionModel,
  humanizeUpstreamError
};
