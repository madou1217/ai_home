'use strict';

const { readTranslationSettings, writeTranslationSettings } = require('../../account/translation-settings-store');
const { listLanguages, detectLanguage } = require('../../server/translation-language');
const { resolveLanguageIntent } = require('../../translation/language-intent');
const { createTranslationExecutionPort } = require('../../translation/execution-port');
const { createDirectProviderExecutor } = require('../../translation/executors/direct-provider');
const { createAihServerExecutor } = require('../../translation/executors/aih-server');
const { normalizeHelperEvent } = require('./protocol');
const { createDesktopLauncher } = require('../runtime/desktop-launcher');
const { createDesktopChatRuntimeBridge } = require('../chat/chat-runtime-bridge');
const { createDesktopTranslationModelCatalog } = require('./model-catalog');
const { translationRoutesAllowAutoSource } = require('../../translation/source-policy');
const { getTranslationPlatformAdapter } = require('./platform-adapter');
const { readServerConfig, resolveLargePasteChars } = require('../../server/server-config-store');
const FOCUS_LEASE_MS = 6000;

// server 拥有 helper 生命周期；helper 只收发文本事件，无 HTTP 监听、无凭据。
function createSystemTranslationService({
  fs,
  aiHomeDir,
  port,
  getManagementKey,
  platform = process.platform,
  serverTarget = null,
  mode = 'helper',
  executionTarget: configuredExecutionTarget = null,
  executionPort = null,
  directExecutor = null,
  serverExecutor = null,
  fetch: fetchImpl,
  spawn: spawnImpl,
  chatRuntimeService,
  build: buildImpl,
  chatEvent: chatEventHandler,
  chatClose
} = {}) {
  const platformAdapter = getTranslationPlatformAdapter(platform, { mode, build: buildImpl });
  const build = platformAdapter.build;
  let request = null;
  let disposed = false;
  let preflightController = null;
  let preflightGeneration = 0;
  let diagnostics = { selectionEvents: 0, outcome: 'idle' };
  const focusLeases = new Map();
  let snapshot = {
    supported: Boolean(build),
    enabled: false,
    status: build ? 'disabled' : 'unsupported',
    detail: build ? '' : platformAdapter.statusText,
    platform: platformAdapter.id,
    captureModes: platformAdapter.captureModes,
    permission: platformAdapter.permission,
    shortcut: platformAdapter.shortcut,
  };
  const settings = () => readTranslationSettings(fs, aiHomeDir) || { target: 'zh-Hans' };
  // 原生 Chat 与 WebUI 共用同一个「大段粘贴转附件」阈值（aih server config --large-paste-chars）。
  const readLargePasteChars = () => {
    try { return resolveLargePasteChars(readServerConfig({ fs, aiHomeDir })); } catch (_error) { return 200; }
  };
  const defaultOrigin = Number.isFinite(Number(port)) && Number(port) > 0 ? `http://127.0.0.1:${Number(port)}` : '';
  let target = serverTarget && typeof serverTarget === 'object' ? { ...serverTarget } : settings()?.systemServerTarget || { kind: 'aih-server', label: '本机 AIH Server', origin: defaultOrigin, serverId: '' };
  let serverTargets = settings()?.systemServerTargets?.length ? settings().systemServerTargets : [target];
  const initialSettings = settings();
  let executionTarget = String(configuredExecutionTarget || initialSettings.executionTarget || (mode === 'full-app' ? 'direct-provider' : 'aih-server')).trim().toLowerCase() === 'direct-provider'
    ? 'direct-provider'
    : 'aih-server';
  const direct = directExecutor || createDirectProviderExecutor({ fs, aiHomeDir, fetch: fetchImpl });
  const server = serverExecutor || createAihServerExecutor({ fetch: fetchImpl, getManagementKey });
  const translationExecution = executionPort || createTranslationExecutionPort({ direct, server });
  const modelCatalog = createDesktopTranslationModelCatalog({ fetch: fetchImpl, getManagementKey, onChange: () => configure() });
  const launcher = createDesktopLauncher({
    build: async () => build(aiHomeDir, { platform: platformAdapter.id }),
    spawn: spawnImpl || require('node:child_process').spawn,
    mode,
    config: {
      parentPid: process.ppid,
      watchParent: mode === 'helper',
      args: mode === 'full-app' ? ['--full-app'] : [],
      spawnOptions: {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.fromEntries((platformAdapter.environmentKeys || [])
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]))
      }
    }
  });

  // The active target is always rendered in the native picker. Older settings
  // can contain a target list that predates the currently selected target (or
  // an empty list after a profile was removed), so keep the active entry as a
  // bounded, de-duplicated member before sending configure events.
  function ensureActiveServerTarget() {
    const activeKey = target.serverId || target.origin;
    if (!activeKey) return;
    if (serverTargets.some((item) => (item.serverId || item.origin) === activeKey)) return;
    serverTargets = [target, ...serverTargets].slice(0, 32);
  }

  function setServerTarget(next) {
    if (!next || typeof next !== 'object') throw new Error('translation_server_target_invalid');
    const kind = String(next.kind || 'aih-server').trim();
    const origin = String(next.origin || '').trim().replace(/\/$/, '');
    if (kind !== 'aih-server' || !/^https?:\/\//.test(origin)) throw new Error('translation_server_target_invalid');
    // A target change invalidates both language detection and the active
    // stream before the helper receives its new configuration.
    cancel({ notify: true });
    target = { kind, label: String(next.label || origin).slice(0, 120), origin, serverId: String(next.serverId || '').trim().slice(0, 200) };
    if (!serverTargets.some((item) => (item.serverId || item.origin) === (target.serverId || target.origin))) serverTargets = [...serverTargets, target].slice(0, 32);
    ensureActiveServerTarget();
    writeTranslationSettings(fs, aiHomeDir, { systemServerTarget: target, systemServerTargets: serverTargets });
    configure();
    return { ...target };
  }
  function setServerTargets(next) {
    if (!Array.isArray(next)) throw new Error('translation_server_targets_invalid');
    cancel({ notify: true });
    serverTargets = next.filter((item) => item && item.kind === 'aih-server' && /^https?:\/\//.test(String(item.origin || ''))).slice(0, 32);
    ensureActiveServerTarget();
    writeTranslationSettings(fs, aiHomeDir, { systemServerTargets: serverTargets });
    configure();
    return serverTargets.map((item) => ({ ...item }));
  }

  function setExecutionTarget(next) {
    const normalized = String(next || '').trim().toLowerCase();
    if (!['aih-server', 'direct-provider'].includes(normalized)) throw new Error('translation_execution_target_invalid');
    cancel({ notify: true });
    executionTarget = normalized;
    writeTranslationSettings(fs, aiHomeDir, { executionTarget: normalized });
    configure();
    return executionTarget;
  }

  function send(event) {
    launcher.send(event);
  }
  const chatBridge = chatRuntimeService && !chatEventHandler
    ? createDesktopChatRuntimeBridge({
      runtime: chatRuntimeService,
      resolveTarget: () => {
        const current = settings();
        const route = Array.isArray(current.routes) ? current.routes.find((item) => item && item.enabled !== false) : null;
        return {
          provider: current.provider || route?.modelProvider || '',
          model: current.model || route?.model || '',
          executionAccountRef: 'gateway'
        };
      }
    })
    : null;
  function cancel({ notify = false } = {}) {
    preflightGeneration += 1;
    if (preflightController) preflightController.abort();
    preflightController = null;
    if (request) request.abort();
    request = null;
    if (notify) send({ type: 'cancel' });
  }
  function configure() {
    const current = settings();
    ensureActiveServerTarget();
    const catalog = modelCatalog.read(target, current, executionTarget);
    send({ type: 'configure', ...catalog, model: current.model || '', provider: current.provider || '', target: current.target, autoCopy: current.autoCopy === true, copyScope: current.copyScope || 'selection', executionTarget, shortcut: current.shortcut, shortcutEnabled: current.shortcutEnabled !== false, chatShortcut: current.chatShortcut, chatShortcutEnabled: current.chatShortcutEnabled !== false, serverTarget: target, serverTargets, chatTarget: target, chatModel: current.model || '', languages: listLanguages(), port, platform: platformAdapter.id, captureModes: platformAdapter.captureModes, permission: platformAdapter.permission, nativeShortcut: platformAdapter.shortcut, largePasteChars: readLargePasteChars(), readingTheme: current.readingTheme || 'plain' });
    void modelCatalog.refresh(target, executionTarget);
  }
  function applySettingsPatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    const { serverTarget, serverTargets: nextServerTargets, executionTarget: nextExecutionTarget, ...settingsPatch } = patch;
    if (Array.isArray(nextServerTargets)) {
      try { setServerTargets(nextServerTargets); } catch (_error) { /* ignore invalid settings target lists */ }
    }
    if (serverTarget && typeof serverTarget === 'object') {
      try { setServerTarget(serverTarget); } catch (_error) { /* ignore invalid settings target */ }
    }
    if (nextExecutionTarget !== undefined) {
      try { setExecutionTarget(nextExecutionTarget); } catch (_error) { /* ignore invalid execution target */ }
    }
    const supportedPatch = Object.fromEntries(Object.entries(settingsPatch).filter(([key]) => ['source', 'target', 'model', 'provider', 'targetPolicy', 'autoCopy', 'copyScope', 'routes', 'executionTarget', 'shortcut', 'shortcutEnabled', 'chatShortcut', 'chatShortcutEnabled', 'readingTheme'].includes(key)));
    if (Object.keys(supportedPatch).length > 0) {
      writeTranslationSettings(fs, aiHomeDir, supportedPatch);
      configure();
    }
  }
  function updateFocus({ id, focused, observedAt, revision }) {
    const now = Date.now();
    if (typeof id !== 'string' || id.length > 100 || !Number.isSafeInteger(revision)
      || !Number.isFinite(observedAt) || Math.abs(now - observedAt) > FOCUS_LEASE_MS) return;
    for (const [key, lease] of focusLeases) if (lease.observedAt + FOCUS_LEASE_MS * 2 < now) focusLeases.delete(key);
    const previous = focusLeases.get(id);
    if (previous && revision <= previous.revision) return;
    if (!previous && focusLeases.size >= 64) return;
    focusLeases.set(id, { revision, observedAt, until: focused === true ? observedAt + FOCUS_LEASE_MS : 0 });
    send({ type: 'webui-focus', until: focusUntil() });
  }
  function focusUntil() { return Math.max(0, ...Array.from(focusLeases.values(), (lease) => lease.until)); }
  async function translate(event) {
    cancel();
    const text = String(event.text || '').trim();
    if (!text || text.length > 8000) return;
    const controller = new AbortController();
    request = controller;
    let emittedDone = false;
    let emittedError = false;
    const startedAt = Number(event.__intentAt) || Date.now();
    let firstDeltaLogged = false;
    timingLog(event.id, 'request', startedAt, `target=${executionTarget}`);
    const emit = (payload) => {
      if (request !== controller || controller.signal.aborted || !payload || typeof payload !== 'object') return;
      if (payload.type === 'delta' && !firstDeltaLogged) { firstDeltaLogged = true; timingLog(event.id, 'first-delta', startedAt); }
      if (payload.type === 'done') { emittedDone = true; timingLog(event.id, 'done', startedAt); }
      if (payload.type === 'error') { emittedError = true; timingLog(event.id, 'error', startedAt, String(payload.code || '')); }
      send({ ...payload, id: event.id });
    };
    try {
      const current = settings();
      const model = String(event.model || '').trim();
      const firstRoute = (current.routes || []).find((route) => route.enabled !== false && route.operations?.includes('selection'));
      const defaultProvider = firstRoute?.modelProvider || (executionTarget === 'direct-provider' ? firstRoute?.provider : '') || current.provider;
      const provider = String(event.provider || (model ? defaultProvider : '') || '').trim();
      let routes = executionTarget === 'aih-server' && !current.routes?.length ? undefined : current.routes;
      if (model) {
        if (executionTarget === 'aih-server') routes = undefined;
        else {
          const candidates = (current.routes || []).filter((route) => route.enabled !== false && route.operations?.includes('selection'));
          const selected = candidates.find((route) => (!provider || (route.modelProvider || route.provider) === provider) && route.model === model)
            || candidates.find((route) => !provider || (route.modelProvider || route.provider) === provider);
          routes = selected ? [{ ...selected, model }] : [];
        }
      }
      emit({ type: 'start', from: event.source || 'auto', to: event.target || current.target, model: model || current.model || '', provider });
      const result = await translationExecution.translate({
        id: event.id,
        target: executionTarget,
        operation: 'selection',
        text,
        source: event.source || 'auto',
        targetLanguage: event.target || current.target,
        targetPolicy: event.targetPolicy || current.targetPolicy || 'saved',
        model,
        provider,
        routes,
        origin: target.origin,
        serverId: target.serverId,
        fallbackTarget: executionTarget === 'direct-provider' && mode !== 'full-app' && target.origin && typeof server === 'function'
          ? 'aih-server'
          : undefined
      }, {
        signal: controller.signal,
        isCurrent: () => request === controller,
        emit
      });
      if (request !== controller || controller.signal.aborted) return;
      if (!result || !result.ok) {
        const error = result && result.error || {};
        if (!emittedError) emit({ type: 'error', code: error.code || 'translation_failed', message: error.message || '翻译失败' });
        return result;
      }
      // Direct Provider adapters are finite requests and do not emit a final
      // SSE `done`; project the common completion event at this boundary.
      if (!emittedDone) emit({ type: 'done', text: String(result.text || ''), usage: result.usage || null });
      return result;
    } catch (error) {
      if (!controller.signal.aborted && request === controller) emit({
        type: 'error',
        code: error && error.code || 'translation_execution_failed',
        message: error && error.message || '翻译连接中断，请重试'
      });
      return { ok: false, text: '', usage: null, attempts: [], error: { code: error && error.code || 'translation_execution_failed', message: error && error.message || '翻译连接中断，请重试', retryable: error && error.retryable !== false } };
    } finally {
      if (request === controller) request = null;
    }
  }

  // 原生划词的分段耗时（收到划词 → 语言判定 → 发出请求 → 首个译文 → 结束）写到 stderr，
  // 由后台 supervisor 日志收集；用户报「原生翻译 20s」而服务端只要 3s 时用来定位卡在哪一段。
  const timingLog = (id, stage, startedAt, extra = '') => {
    try { process.stderr.write(`[aih:translation-timing] id=${String(id || '').slice(0, 8)} ${stage} +${Date.now() - startedAt}ms${extra ? ` ${extra}` : ''}\n`); } catch (_error) { /* best effort */ }
  };

  async function prepareTranslation(event) {
    const text = String(event.text || '').trim();
    if (!text || text.length > 8000) return;
    const intentAt = Date.now();
    event = { ...event, __intentAt: intentAt };
    const requestedTarget = event.target || settings().target;
    const generation = ++preflightGeneration;
    preflightController?.abort();
    const controller = new AbortController();
    preflightController = controller;
    // Both execution targets use the same canonical detector. Preflight is
    // bounded local work; connecting to a server belongs to translation only.
    const detection = detectLanguage(text.slice(0, 4000));
    timingLog(event.id, 'detected', intentAt, `lang=${detection && detection.code || ''}`);
    if (generation !== preflightGeneration || controller.signal.aborted) return;
    const intent = resolveLanguageIntent({
      source: 'auto',
      target: requestedTarget,
      detected: detection && detection.code,
      confidence: detection && detection.confidence,
      allowAutoSource: translationRoutesAllowAutoSource(event.model && executionTarget === 'aih-server' ? [] : settings().routes, { useGatewayDefault: executionTarget === 'aih-server', facade: direct.facade }),
      targetPolicy: event.targetPolicy
    });
    if (intent.state !== 'ready') {
      send({ type: 'confirmation', id: event.id || '', state: intent.state, detected: detection?.code || '', confidence: detection?.confidence || 'low', target: requestedTarget, suggestedTargets: listLanguages().map((item) => item.code).filter((code) => code !== intent.source).slice(0, 3) });
      return;
    }
    if (generation !== preflightGeneration || controller.signal.aborted) return;
    preflightController = null;
    await translate({ ...event, source: intent.source, target: intent.target, targetPolicy: event.targetPolicy || 'saved' });
  }

  function handleHelperEvent(rawEvent) {
    const event = normalizeHelperEvent(rawEvent);
    if (!event) return;
    if (event.type.startsWith('chat.')) {
      if (typeof chatEventHandler === 'function') void chatEventHandler(event, { send });
      else if (chatBridge) void chatBridge.handle(event, { send });
      else send({
        type: 'chat.error',
        requestId: event.requestId,
        ...(event.generation !== undefined ? { generation: event.generation } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.commandId ? { commandId: event.commandId } : {}),
        code: 'chat_runtime_unavailable',
        message: '当前桌面模式没有可用的 Chat Runtime，请连接 AIH Server 后重试'
      });
    } else if (event.type === 'status') {
      snapshot = {
        ...snapshot,
        status: event.trusted ? 'running' : 'permission-required',
        detail: event.detail || (event.trusted ? platformAdapter.statusText : platformAdapter.permission === 'accessibility'
          ? '请在系统设置 → 隐私与安全性 → 辅助功能（macOS 27 英文界面：System Settings → Privacy & Security → Device Control and Data Access），把 AIH Translation 拖进列表并打开开关'
          : '请允许 AIH Translation 使用快捷键和剪贴板'),
        ...(event.platform ? { platform: event.platform } : {}),
        ...(event.captureModes ? { captureModes: event.captureModes } : {}),
        ...(event.permission ? { permission: event.permission } : {}),
        ...(event.shortcut ? { shortcut: event.shortcut } : {}),
      };
    } else if (event.type === 'error') {
      snapshot = {
        ...snapshot,
        status: 'error',
        detail: event.message || '桌面取词进程发生错误',
      };
    } else if (event.type === 'translate-intent') void prepareTranslation(event);
    else if (event.type === 'translate') void translate(event);
    else if (event.type === 'server-target') {
      try { setServerTarget({ kind: 'aih-server', origin: event.origin, serverId: event.serverId, label: event.label }); }
      catch (_error) { send({ type: 'server-target-error', message: '该 AIH Server 尚未完成服务端授权配置' }); }
    } else if (event.type === 'cancel') cancel();
    else if (event.type === 'settings' && event.action === 'save') applySettingsPatch(event.patch);
    else if (event.type === 'selection-state') diagnostics = { selectionEvents: diagnostics.selectionEvents + 1, outcome: String(event.outcome || '').slice(0, 100), application: String(event.application || '').slice(0, 100), hitPID: event.hitPID, focusPID: event.focusPID, x: event.x, y: event.y };
  }
  launcher.on('event', handleHelperEvent);
  launcher.on('ready', () => {
    if (disposed || !snapshot.enabled) return;
    configure();
    send({ type: 'webui-focus', until: focusUntil() });
  });
  launcher.on('status', (status, detail) => {
    if (status === 'starting') snapshot = { ...snapshot, status: 'starting', detail: '正在准备桌面取词' };
    else if (status === 'error') snapshot = { ...snapshot, status: 'error', detail: detail || '桌面取词进程已退出，可关闭后重新开启' };
  });

  async function start() {
    if (mode === 'full-app' && !snapshot.enabled) snapshot.enabled = true;
    if (disposed || !build || !snapshot.enabled) return false;
    const started = await launcher.start();
    return started;
  }
  function stopChild() {
    cancel();
    chatBridge?.close();
    launcher.stop();
  }
  async function setEnabled(enabled) {
    if (!build && enabled) {
      const error = new Error(platformAdapter.statusText);
      error.code = 'desktop_platform_unsupported';
      throw error;
    }
    writeTranslationSettings(fs, aiHomeDir, { systemEnabled: enabled });
    const wasRunning = ['running', 'starting', 'stopping'].includes(launcher.status().status);
    snapshot = {
      ...snapshot,
      platform: platformAdapter.id,
      captureModes: platformAdapter.captureModes,
      permission: platformAdapter.permission,
      shortcut: platformAdapter.shortcut,
      enabled,
      status: enabled ? (wasRunning ? snapshot.status : 'starting') : 'disabled',
      detail: enabled && wasRunning ? snapshot.detail : ''
    };
    if (enabled) {
      configure();
      await start();
    } else stopChild();
    return getStatus();
  }
  function getStatus() {
    const providers = typeof direct.describe === 'function' ? direct.describe() : [];
    return {
      ...snapshot,
      diagnostics,
      executionTarget,
      executionTargets: [
        {
          id: 'aih-server',
          label: 'AIH Server',
          available: typeof server === 'function',
          configured: Boolean(target && target.origin),
          capabilities: { streaming: true, operations: ['selection', 'batch', 'page', 'replace'] }
        },
        {
          id: 'direct-provider',
          label: 'Provider 直连',
          available: typeof direct === 'function',
          configured: providers.some((provider) => provider.configured === true),
          capabilities: {
            streaming: providers.some((provider) => provider.streaming === true),
            operations: Array.from(new Set(providers.flatMap((provider) => provider.operations || [])))
          },
          providers
        }
      ],
      serverTarget: { ...target },
      serverTargets: serverTargets.map((item) => ({ ...item }))
    };
  }
  return {
    getStatus, setEnabled, updateFocus, configure,
    translate, prepareTranslation,
    sendEvent: send,
    getServerTarget: () => ({ ...target }),
    setServerTargets,
    setServerTarget,
    setExecutionTarget,
    requestPermission: () => send({ type: 'request-permission' }),
    start: () => {
      snapshot.enabled = mode === 'full-app' || settings().systemEnabled === true;
      return start();
    },
    stop: () => { disposed = true; cancel(); modelCatalog.reset(); chatBridge?.close(); chatClose?.(); launcher.stop({ permanent: true }); }
  };
}

module.exports = { createSystemTranslationService };
