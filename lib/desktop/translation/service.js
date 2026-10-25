'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { readTranslationSettings, writeTranslationSettings } = require('../../account/translation-settings-store');
const { listLanguages } = require('../../server/translation-language');
const { resolveLanguageIntent } = require('../../translation/language-intent');
const { createTranslationExecutionPort } = require('../../translation/execution-port');
const { createDirectProviderExecutor } = require('../../translation/executors/direct-provider');
const { createAihServerExecutor } = require('../../translation/executors/aih-server');
const { buildMacTranslationHelper } = require('./macos-build');
const { normalizeHelperEvent } = require('./protocol');

const ADAPTERS = { darwin: buildMacTranslationHelper };
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
  fetch: fetchImpl
} = {}) {
  const build = ADAPTERS[platform];
  let child = null;
  let starting = null;
  let generation = 0;
  let request = null;
  let disposed = false;
  let retryTimer = null;
  let retries = 0;
  let preflightController = null;
  let preflightGeneration = 0;
  let diagnostics = { selectionEvents: 0, outcome: 'idle' };
  const focusLeases = new Map();
  let snapshot = { supported: Boolean(build), enabled: false, status: build ? 'disabled' : 'unsupported', detail: build ? '' : '此服务器平台暂不支持桌面取词' };
  const settings = () => readTranslationSettings(fs, aiHomeDir) || { target: 'zh-Hans' };
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
    configure();
    return executionTarget;
  }

  function send(event) {
    if (child && !child.killed && child.stdin.writable) child.stdin.write(`${JSON.stringify(event)}\n`);
  }
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
    send({ type: 'configure', target: current.target, autoCopy: current.autoCopy === true, copyScope: current.copyScope || 'selection', executionTarget, serverTarget: target, serverTargets, languages: listLanguages(), port });
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
    const supportedPatch = Object.fromEntries(Object.entries(settingsPatch).filter(([key]) => ['source', 'target', 'model', 'provider', 'targetPolicy', 'autoCopy', 'copyScope', 'routes'].includes(key)));
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
    const emit = (payload) => {
      if (request !== controller || controller.signal.aborted || !payload || typeof payload !== 'object') return;
      if (payload.type === 'done') emittedDone = true;
      if (payload.type === 'error') emittedError = true;
      send({ ...payload, id: event.id });
    };
    try {
      const current = settings();
      const result = await translationExecution.translate({
        id: event.id,
        target: executionTarget,
        operation: 'selection',
        text,
        source: 'auto',
        targetLanguage: event.target || current.target,
        targetPolicy: event.targetPolicy || current.targetPolicy || 'saved',
        routes: current.routes,
        origin: target.origin,
        serverId: target.serverId,
        fallbackTarget: executionTarget === 'direct-provider' ? 'aih-server' : undefined
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

  async function prepareTranslation(event) {
    const text = String(event.text || '').trim();
    if (!text || text.length > 8000) return;
    const requestedTarget = event.target || settings().target;
    const activeServerTarget = target;
    const generation = ++preflightGeneration;
    preflightController?.abort();
    const controller = new AbortController();
    preflightController = controller;
    let detection;
    try {
      const response = await fetch(`${activeServerTarget.origin}/v0/webui/translation/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getManagementKey()}`, ...(activeServerTarget.serverId ? { 'x-aih-server-id': activeServerTarget.serverId } : {}) },
        body: JSON.stringify({ text: text.slice(0, 4000) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      });
      if (!response.ok) throw new Error('translation_preflight_http_error');
      detection = await response.json();
    } catch (error) {
      if (generation !== preflightGeneration || controller.signal.aborted) return;
      preflightController = null;
      const message = error && error.name === 'TimeoutError'
        ? '语言识别超时，请重试或切换翻译服务'
        : '无法连接翻译服务，请检查服务目标后重试';
      send({ type: 'error', code: 'translation_preflight_error', id: event.id || '', message });
      return;
    }
    if (generation !== preflightGeneration || controller.signal.aborted) return;
    const intent = resolveLanguageIntent({
      source: 'auto',
      target: requestedTarget,
      detected: detection && detection.code,
      confidence: detection && detection.confidence,
      targetPolicy: event.targetPolicy
    });
    if (intent.state !== 'ready') {
      send({ type: 'confirmation', id: event.id || '', state: intent.state, detected: detection?.code || '', confidence: detection?.confidence || 'low', target: requestedTarget, suggestedTargets: listLanguages().map((item) => item.code).filter((code) => code !== intent.source).slice(0, 3) });
      return;
    }
    if (generation !== preflightGeneration || controller.signal.aborted) return;
    preflightController = null;
    await translate({ ...event, target: intent.target, targetPolicy: event.targetPolicy || 'saved' });
  }

  async function start() {
    if (disposed || !build || !snapshot.enabled || child) return;
    if (starting) return starting;
    const token = generation;
    snapshot = { ...snapshot, status: 'starting', detail: '正在准备桌面取词' };
    starting = (async () => {
      try {
        const executable = await build(aiHomeDir);
        if (disposed || token !== generation || !snapshot.enabled) return;
        const env = {};
        for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']) {
          if (process.env[key]) env[key] = process.env[key];
        }
        const current = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
        const spawnedAt = Date.now();
        child = current;
        current.stdin.on('error', () => {});
        let stderr = '';
        current.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-2000); });
        const lines = readline.createInterface({ input: current.stdout });
        lines.on('line', (line) => {
          if (child !== current || line.length > 100000) return;
          try {
            const event = normalizeHelperEvent(JSON.parse(line));
            if (!event) return;
            if (event.type === 'status') {
              snapshot = { ...snapshot, status: event.trusted ? 'running' : 'permission-required', detail: event.trusted ? '在本机应用或网页选词后点击「译」' : '请在系统设置 → 隐私与安全性 → 辅助功能中允许 AIH Translation' };
            } else if (event.type === 'translate-intent') void prepareTranslation(event);
            else if (event.type === 'translate') void translate(event);
            else if (event.type === 'server-target') {
              try { setServerTarget({ kind: 'aih-server', origin: event.origin, serverId: event.serverId, label: event.label }); }
              catch (_error) { send({ type: 'server-target-error', message: '该 AIH Server 尚未完成服务端授权配置' }); }
            }
            else if (event.type === 'cancel') cancel();
            else if (event.type === 'settings' && event.action === 'save') applySettingsPatch(event.patch);
            else if (event.type === 'selection-state') {
              diagnostics = { selectionEvents: diagnostics.selectionEvents + 1, outcome: String(event.outcome || '').slice(0, 100), application: String(event.application || '').slice(0, 100), hitPID: event.hitPID, focusPID: event.focusPID, x: event.x, y: event.y };
            }
          } catch (_error) { /* 丢弃非协议输出，不打印选区。 */ }
        });
        current.once('error', () => { snapshot = { ...snapshot, status: 'error', detail: '桌面取词进程无法启动' }; });
        current.once('exit', () => {
          lines.close();
          if (child !== current) return;
          child = null;
          cancel();
          // ready/trusted 后立即崩溃也计入预算；只有稳定运行过的进程才重新获得恢复预算。
          if (Date.now() - spawnedAt > 30000) retries = 0;
          snapshot = { ...snapshot, status: 'error', detail: stderr.includes('AX') ? '桌面取词权限不可用，请重新授权' : '桌面取词进程已退出，可关闭后重新开启' };
          if (!disposed && snapshot.enabled && retries++ < 3) {
            retryTimer = setTimeout(() => { retryTimer = null; void start(); }, 2000);
            retryTimer.unref();
          }
        });
        configure();
        send({ type: 'webui-focus', until: focusUntil() });
      } catch (error) {
        snapshot = { ...snapshot, status: 'error', detail: error.code === 'ENOENT' ? '需要安装 Xcode Command Line Tools 后重新开启' : '桌面取词构建失败，请检查本机 Swift 工具链' };
      } finally {
        starting = null;
        // 构建期间先关再开时，旧构建只负责退出；新一代再启动。
        if (!disposed && snapshot.enabled && token !== generation) setImmediate(() => { void start(); });
      }
    })();
    return starting;
  }
  function stopChild() {
    generation++;
    clearTimeout(retryTimer);
    retryTimer = null;
    cancel();
    const previous = child;
    child = null;
    if (previous) {
      previous.stdin.end();
      previous.kill('SIGTERM');
    }
  }
  async function setEnabled(enabled) {
    if (!build && enabled) throw new Error('此服务器平台暂不支持桌面取词');
    writeTranslationSettings(fs, aiHomeDir, { systemEnabled: enabled });
    const wasRunning = child !== null;
    snapshot = {
      ...snapshot,
      enabled,
      status: enabled ? (wasRunning ? snapshot.status : 'starting') : 'disabled',
      detail: enabled && wasRunning ? snapshot.detail : ''
    };
    if (enabled) {
      retries = 0;
      configure();
      void start();
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
    translate,
    getServerTarget: () => ({ ...target }),
    setServerTargets,
    setServerTarget,
    setExecutionTarget,
    requestPermission: () => send({ type: 'request-permission' }),
    start: () => {
      snapshot.enabled = settings().systemEnabled === true;
      return start();
    },
    stop: () => { disposed = true; stopChild(); }
  };
}

module.exports = { createSystemTranslationService };
