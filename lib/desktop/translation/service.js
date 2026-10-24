'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { readTranslationSettings, writeTranslationSettings } = require('../../account/translation-settings-store');
const { listLanguages } = require('../../server/translation-language');
const { resolveLanguageIntent } = require('../../translation/language-intent');
const { buildMacTranslationHelper } = require('./macos-build');

const ADAPTERS = { darwin: buildMacTranslationHelper };
const FOCUS_LEASE_MS = 6000;

// server 拥有 helper 生命周期；helper 只收发文本事件，无 HTTP 监听、无凭据。
function createSystemTranslationService({ fs, aiHomeDir, port, getManagementKey, platform = process.platform }) {
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

  function send(event) {
    if (child && !child.killed && child.stdin.writable) child.stdin.write(`${JSON.stringify(event)}\n`);
  }
  function cancel() {
    preflightGeneration += 1;
    if (preflightController) preflightController.abort();
    preflightController = null;
    if (request) request.abort();
    request = null;
  }
  function configure() {
    const current = settings();
    send({ type: 'configure', target: current.target, autoCopy: current.autoCopy === true, copyScope: current.copyScope || 'selection', languages: listLanguages(), port });
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
    const emit = (payload) => {
      if (request === controller && !controller.signal.aborted) send({ ...payload, id: event.id });
    };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v0/webui/translation/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getManagementKey()}` },
        body: JSON.stringify({ text, source: 'auto', target: event.target || settings().target, targetPolicy: event.targetPolicy || 'saved' }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)])
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        emit({ type: 'error', message: error.detail || '翻译请求失败' });
        return;
      }
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) emit(JSON.parse(line.slice(6)));
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) emit({ type: 'error', message: error.name === 'TimeoutError' ? '翻译超时，请重试' : '翻译连接中断，请重试' });
    } finally {
      if (request === controller) request = null;
    }
  }

  async function prepareTranslation(event) {
    const text = String(event.text || '').trim();
    if (!text || text.length > 8000) return;
    const target = event.target || settings().target;
    const generation = ++preflightGeneration;
    preflightController?.abort();
    const controller = new AbortController();
    preflightController = controller;
    const detection = await fetch(`http://127.0.0.1:${port}/v0/webui/translation/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getManagementKey()}` },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: controller.signal
    }).then((response) => response.ok ? response.json() : null).catch(() => null);
    if (generation !== preflightGeneration || controller.signal.aborted) return;
    const intent = resolveLanguageIntent({
      source: 'auto',
      target,
      detected: detection && detection.code,
      confidence: detection && detection.confidence,
      targetPolicy: event.targetPolicy
    });
    if (intent.state !== 'ready') {
      send({ type: 'confirmation', id: event.id || '', state: intent.state, detected: detection?.code || '', confidence: detection?.confidence || 'low', target, suggestedTargets: listLanguages().map((item) => item.code).filter((code) => code !== intent.source).slice(0, 3) });
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
            const event = JSON.parse(line);
            if (event.type === 'status') {
              snapshot = { ...snapshot, status: event.trusted ? 'running' : 'permission-required', detail: event.trusted ? '在本机应用或网页选词后点击「译」' : '请在系统设置 → 隐私与安全性 → 辅助功能中允许 AIH Translation' };
            } else if (event.type === 'translate-intent') void prepareTranslation(event);
            else if (event.type === 'translate') void translate(event);
            else if (event.type === 'cancel') cancel();
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
  function getStatus() { return { ...snapshot, diagnostics }; }
  return {
    getStatus, setEnabled, updateFocus, configure,
    requestPermission: () => send({ type: 'request-permission' }),
    start: () => {
      snapshot.enabled = settings().systemEnabled === true;
      return start();
    },
    stop: () => { disposed = true; stopChild(); }
  };
}

module.exports = { createSystemTranslationService };
