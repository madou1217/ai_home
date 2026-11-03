'use strict';

const { createInteractivePromptDetector } = require('../../../protocol/native-interactive-prompts');
const { createAnsiTerminalScreen } = require('./ansi-terminal-screen');

const SYNC_EVENT_NAME = 'AihCliInteractionSync';
const DEFAULT_SYNC_INTERVAL_MS = 300;
// 终端会话没有关联到 WebUI 会话时，服务端回 409 session_correlation_not_ready，而且在这次
// 运行里通常一直不会就绪（例如直接在终端跑的 aih codex 停在 hooks 确认 / 登录选择上）。
// 定时轮询按 300ms 重试会把服务端日志刷屏（实测每分钟约 200 次），因此对这种拒绝退避：
// 1s 起翻倍，最多 30s；提示出现、消失或下发命令时立即同步并重置退避。
const NOT_READY_BACKOFF_MIN_MS = 1000;
const NOT_READY_BACKOFF_MAX_MS = 30000;

function createCodexInteractionObserver(options = {}) {
  const correlationId = normalizeText(options.correlationId);
  const accountRef = normalizeText(options.accountRef);
  const receiverUrl = normalizeText(options.receiverUrl);
  const postJson = typeof options.postJson === 'function' ? options.postJson : async () => ({ ok: false });
  const writeInput = typeof options.writeInput === 'function' ? options.writeInput : () => {};
  const screen = createAnsiTerminalScreen();
  const detector = createInteractivePromptDetector('codex');
  const delivered = new Set();
  let timer = null;
  let inFlight = false;
  let activePrompt = null;
  let activePromptRevision = 0;
  let clearedPromptId = '';
  let clearedPromptRevision = 0;
  let resolvedDeliveryId = '';
  let notReadyBackoffMs = 0;
  let nextTimerSyncAt = 0;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function observe(output) {
    screen.feed(output);
    const event = detector.replaceOutput(screen.toText(), { clearWhenMissing: true });
    if (!event) return null;
    if (event.type === 'interactive-prompt-cleared') {
      activePrompt = null;
      clearedPromptId = event.promptId;
      clearedPromptRevision = activePromptRevision;
      void sync();
      return event;
    }
    if (event.type !== 'interactive-prompt') return null;
    activePrompt = event.prompt;
    activePromptRevision += 1;
    clearedPromptId = '';
    clearedPromptRevision = 0;
    nextTimerSyncAt = 0;
    void sync();
    return event;
  }

  function observeInput(input) {
    if (!activePrompt || !/[\r\n]/.test(String(input || ''))) return null;
    return clear('local-input');
  }

  function clear(reason = 'cleared') {
    const event = detector.clearActivePrompt(reason);
    if (!event) return null;
    activePrompt = null;
    clearedPromptId = event.promptId;
    clearedPromptRevision = activePromptRevision;
    void sync();
    return event;
  }

  async function sync(syncOptions = {}) {
    const hasPendingSync = activePrompt || clearedPromptId || resolvedDeliveryId;
    if (!hasPendingSync || inFlight || !correlationId || !receiverUrl) return null;
    if (syncOptions.fromTimer === true && now() < nextTimerSyncAt) return null;
    inFlight = true;
    try {
      const delivery = await postJson(receiverUrl, {
        provider: 'codex',
        eventName: SYNC_EVENT_NAME,
        correlationId,
        accountRef,
        ...(activePrompt ? { prompt: activePrompt, promptRevision: activePromptRevision } : {}),
        ...(clearedPromptId ? { clearedPromptId, clearedPromptRevision } : {}),
        ...(resolvedDeliveryId ? { resolvedDeliveryId } : {})
      }, { timeoutMs: 1000 });
      if (isCorrelationNotReady(delivery)) {
        notReadyBackoffMs = Math.min(
          NOT_READY_BACKOFF_MAX_MS,
          Math.max(NOT_READY_BACKOFF_MIN_MS, notReadyBackoffMs * 2)
        );
        nextTimerSyncAt = now() + notReadyBackoffMs;
        return delivery;
      }
      if (!delivery || !delivery.ok) return delivery;
      notReadyBackoffMs = 0;
      nextTimerSyncAt = 0;
      if (clearedPromptId) {
        clearedPromptId = '';
        clearedPromptRevision = 0;
      }
      if (resolvedDeliveryId) resolvedDeliveryId = '';
      const command = delivery.json && delivery.json.command;
      if (command) applyCommand(command);
      return delivery;
    } finally {
      inFlight = false;
    }
  }

  function applyCommand(command) {
    const deliveryId = normalizeText(command.deliveryId);
    const promptId = normalizeText(command.promptId);
    const promptRevision = Number(command.promptRevision);
    const choiceValue = normalizeText(command.choiceValue);
    if (!deliveryId || delivered.has(deliveryId)) return false;
    if (!activePrompt || activePrompt.promptId !== promptId) return false;
    if (promptRevision !== activePromptRevision) return false;
    const option = activePrompt.options.find((candidate) => normalizeText(candidate.value) === choiceValue);
    if (!option) return false;

    delivered.add(deliveryId);
    const input = option.send === undefined ? choiceValue : String(option.send);
    const appendNewline = activePrompt.submit !== 'raw';
    writeInput(input, { appendNewline, promptId });
    detector.clearActivePrompt('webui-input');
    activePrompt = null;
    resolvedDeliveryId = deliveryId;
    void sync();
    return true;
  }

  function start() {
    if (timer || !correlationId || !receiverUrl) return false;
    const intervalMs = Math.max(100, Number(options.syncIntervalMs) || DEFAULT_SYNC_INTERVAL_MS);
    timer = (options.setInterval || setInterval)(() => { void sync({ fromTimer: true }); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    (options.clearInterval || clearInterval)(timer);
    timer = null;
    return true;
  }

  return {
    observe,
    observeInput,
    clear,
    sync,
    start,
    stop,
    getActivePrompt: () => activePrompt
  };
}

function isCorrelationNotReady(delivery) {
  return Boolean(delivery)
    && Number(delivery.statusCode) === 409
    && String(delivery.json && delivery.json.error || '') === 'session_correlation_not_ready';
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

module.exports = {
  DEFAULT_SYNC_INTERVAL_MS,
  SYNC_EVENT_NAME,
  createCodexInteractionObserver
};
