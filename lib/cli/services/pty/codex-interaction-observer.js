'use strict';

const { createInteractivePromptDetector } = require('../../../protocol/native-interactive-prompts');
const { createAnsiTerminalScreen } = require('./ansi-terminal-screen');

const SYNC_EVENT_NAME = 'AihCliInteractionSync';
const DEFAULT_SYNC_INTERVAL_MS = 300;

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

  async function sync() {
    const hasPendingSync = activePrompt || clearedPromptId || resolvedDeliveryId;
    if (!hasPendingSync || inFlight || !correlationId || !receiverUrl) return null;
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
      if (!delivery || !delivery.ok) return delivery;
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
    timer = (options.setInterval || setInterval)(() => { void sync(); }, intervalMs);
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

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

module.exports = {
  DEFAULT_SYNC_INTERVAL_MS,
  SYNC_EVENT_NAME,
  createCodexInteractionObserver
};
