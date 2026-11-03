'use strict';

// PTY/TUI adapter：没有协议端点，只能读终端屏幕、写按键。
//
// 为什么需要它：agy / kiro / pi / dsh-tui 这类 harness 只有终端界面，但上层仍要
// 同一套交互请求。这里把 native-interactive-prompts 的探测结果翻译成契约交互。
//
// 三条边界：
// - 不自己起 PTY：屏幕来源由 context 注入；缺了就直接 fail closed，绝不偷偷
//   spawn 一个真终端（测试会碰子进程，线上也会和用户现有会话抢同一个 tty）。
// - 不猜按键：每种提示的按键序列来自 PROMPT_MAPPINGS / DECISION_KEY_RESOLVERS
//   数据表，不在代码里散落 if (kind === ...)。
// - 不发事件：交互事件由 router 发；PTY 没有可靠的回合边界，硬造 timeline 只会
//   把整屏重绘当成内容。

const { AgentSessionError, nonEmptyString } = require('../contracts');
const { createInteractivePromptDetector } = require('../../protocol/native-interactive-prompts');

const ADAPTER_ID = 'pty';
// 屏幕变干净后先等这么久再作废交互：TUI 重绘擦屏通常一两帧就回来。
const RETRACT_GRACE_MS = 1500;
const TRANSPORT = 'pty';
const DEFAULT_SCAN_INTERVAL_MS = 250;
// TUI 的中断键（Ctrl+C）是终端层的事实标准，不是某个 provider 的私有约定。
const INTERRUPT_KEYS = '\u0003';
const NEWLINE = '\r';
const CHOICE_FIELD_ID = 'choice';

// 探测器 kind → 契约交互。confirm/acknowledge 是「确认类」提示，天然是 approval；
// choice/plan-choice 要求用户在选项里挑一个，天然是 question/plan_confirmation。
const PROMPT_MAPPINGS = Object.freeze({
  'plan-choice': Object.freeze({
    interactionKind: 'plan_confirmation',
    title: 'CLI 计划确认',
    fieldId: CHOICE_FIELD_ID
  }),
  choice: Object.freeze({
    interactionKind: 'question',
    title: 'CLI 需要你的选择',
    fieldId: CHOICE_FIELD_ID
  }),
  confirm: Object.freeze({
    interactionKind: 'approval',
    // 选项值 → intent。表里没有的值退到 neutral，而不是猜成 accept：
    // 猜错方向等于替用户放行。
    intents: Object.freeze({ y: 'accept', n: 'deny' })
  }),
  acknowledge: Object.freeze({
    interactionKind: 'approval',
    intents: Object.freeze({ enter: 'accept' })
  })
});

// 决策 → 按键。按交互 kind 查表，避免在 respond 里堆 kind 分支。
const DECISION_KEY_RESOLVERS = Object.freeze({
  approval: resolveApprovalKey,
  question: resolveChoiceAnswerKey,
  plan_confirmation: resolveChoiceAnswerKey
});

function createAdapter(options) {
  const config = options && typeof options === 'object' ? options : {};
  const sessionId = nonEmptyString(config.sessionId);
  if (!sessionId) throw new AgentSessionError('agent_session_id_required');
  const provider = nonEmptyString(config.provider);
  if (!provider) throw new AgentSessionError('agent_session_provider_required');
  const transport = nonEmptyString(config.transport) || TRANSPORT;
  const context = config.context && typeof config.context === 'object' ? config.context : {};

  const readScreen = typeof context.readScreen === 'function' ? context.readScreen : null;
  const writeInput = typeof context.writeInput === 'function' ? context.writeInput : null;
  const onScreen = typeof context.onScreen === 'function' ? context.onScreen : null;
  const setIntervalFn = typeof context.setInterval === 'function' ? context.setInterval : setInterval;
  const clearIntervalFn = typeof context.clearInterval === 'function' ? context.clearInterval : clearInterval;
  const setTimeoutFn = typeof context.setTimeout === 'function' ? context.setTimeout : setTimeout;
  const clearTimeoutFn = typeof context.clearTimeout === 'function' ? context.clearTimeout : clearTimeout;
  const scanIntervalMs = positiveInteger(context.scanIntervalMs) || DEFAULT_SCAN_INTERVAL_MS;

  const detector = createInteractivePromptDetector(provider);
  // PTY 这一层当前不产事件；listener 集合保留是为了满足契约形状，
  // 也方便以后加「屏幕快照」事件时不改调用方。
  const listeners = new Set();
  const handlers = new Set();
  const expireHandlers = new Set();
  const records = new Map();
  // 已答复过的提示签名。屏幕没变干净之前不许重开：同一行提示会在屏幕上停留
  // 好几个扫描周期，放开就会变成一串重复交互。
  const retired = new Set();

  let activeRecord = null;
  let currentTurnId = null;
  let interactionSeq = 0;
  let opened = false;
  let disposed = false;
  let scanTimer = null;
  let retractTimer = null;
  let unsubscribeScreen = null;

  function scan() {
    if (disposed || !opened) return;
    let text = '';
    try {
      text = String(readScreen() || '');
    } catch (_error) {
      // 屏幕源抖动不该杀掉会话；下一帧再试，这一帧当作什么都没看见。
      return;
    }
    let event = null;
    try {
      event = detector.replaceOutput(text, { clearWhenMissing: true });
    } catch (_error) {
      // 输入是任意终端输出，解析器出错只能说明这屏看不懂，不能向上抛。
      return;
    }
    if (event && event.type === 'interactive-prompt-cleared') {
      onScreenClean();
      return;
    }
    const prompt = event && event.type === 'interactive-prompt' ? event.prompt : detector.getActivePrompt();
    if (!prompt) return;
    consider(prompt);
  }

  // 屏幕变干净 = 上一条提示确实消失了。此时才允许「同一签名」再次成为新交互；
  // 但已经开出去的记录不立刻作废：TUI 重绘会短暂擦屏，同一个签名再出现时
  // 还能接着用原记录回答。
  function onScreenClean() {
    retired.clear();
    if (activeRecord) activeRecord.detached = true;
    // 不立刻作废：TUI 重绘会短暂擦屏，同一个提示很快回来时交互还得能答。
    // 给一个宽限期，过了才告诉外壳收尾（否则那条 pending 会一直挂着，
    // 标题的 ? 帧也就一直钉着）。
    scheduleRetract();
  }

  function scheduleRetract() {
    if (retractTimer !== null) {
      try { clearTimeoutFn(retractTimer); } catch (_error) {}
      retractTimer = null;
    }
    if (!activeRecord || activeRecord.answered) return;
    retractTimer = setTimeoutFn(() => {
      retractTimer = null;
      retractActive('prompt_gone');
    }, RETRACT_GRACE_MS);
    if (retractTimer && typeof retractTimer.unref === 'function') retractTimer.unref();
  }

  function cancelRetract() {
    if (retractTimer === null) return;
    try { clearTimeoutFn(retractTimer); } catch (_error) {}
    retractTimer = null;
  }

  // 交互已经不可能被回答：告诉外壳收尾（router.expire），但保留记录，
  // 让之后按错键时还能拿到 pty_interaction_stale 而不是「未知交互」。
  function retractActive(reason) {
    const record = activeRecord;
    if (!record || record.answered) return;
    record.answered = true;
    for (const handler of Array.from(expireHandlers)) {
      try {
        handler(record.interactionId, reason);
      } catch (_error) {}
    }
  }

  function consider(prompt) {
    const signature = nonEmptyString(prompt && prompt.promptId);
    if (!signature) return;
    if (activeRecord && activeRecord.signature === signature) {
      // 同一条提示的重复帧：不是新交互，只是屏幕还没变（或刚重绘回来）。
      activeRecord.detached = false;
      cancelRetract();
      return;
    }
    if (retired.has(signature)) return;
    const mapping = PROMPT_MAPPINGS[prompt.kind];
    if (!mapping) return;
    if (handlers.size === 0) return;
    if (activeRecord) {
      // 屏幕上换成了另一条提示：旧记录已经不在屏幕上，之后按它的键会打到
      // 别的提示上，必须标记为不可回答，并让 router 收尾。
      activeRecord.detached = true;
      cancelRetract();
      retractActive('prompt_replaced');
    }

    interactionSeq += 1;
    const built = buildRequest(prompt, mapping, `pty_interaction_${interactionSeq}`, currentTurnId);
    if (!built) return;
    const record = {
      interactionId: built.request.interactionId,
      signature,
      kind: mapping.interactionKind,
      fieldId: mapping.fieldId || null,
      submit: prompt.submit === 'raw' ? 'raw' : 'enter',
      choiceKeys: built.choiceKeys,
      detached: false,
      answered: false
    };
    records.set(record.interactionId, record);
    activeRecord = record;
    try {
      emitRequest(built.request);
    } catch (_error) {
      // router 拒收（payload 非法、id 撞车）时不能每个扫描周期重试，
      // 否则 250ms 一条 stream.error。退休到屏幕变干净为止。
      records.delete(record.interactionId);
      if (activeRecord === record) activeRecord = null;
      retired.add(signature);
    }
  }

  function emitRequest(request) {
    let firstError = null;
    for (const handler of Array.from(handlers)) {
      try {
        handler(request);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    if (firstError) throw firstError;
  }

  function buildRequest(prompt, mapping, interactionId, turnId) {
    const choiceKeys = new Map();
    const itemId = `pty-prompt:${prompt.promptId}`;
    if (mapping.interactionKind === 'approval') {
      const choices = [];
      for (const option of prompt.options || []) {
        const id = String(option.value);
        choiceKeys.set(id, option.send === undefined ? id : String(option.send));
        choices.push({
          id,
          label: option.title,
          intent: mapping.intents[id.toLowerCase()] || 'neutral'
        });
      }
      if (choices.length === 0) return null;
      return {
        choiceKeys,
        request: {
          interactionId,
          kind: 'approval',
          payload: {
            presentation: { title: prompt.question },
            choices
          },
          turnId,
          itemId
        }
      };
    }

    const options = [];
    for (const option of prompt.options || []) {
      const value = String(option.value);
      choiceKeys.set(value, option.send === undefined ? value : String(option.send));
      options.push({
        value,
        label: option.title,
        ...(option.description ? { description: option.description } : {})
      });
    }
    if (options.length === 0) return null;
    return {
      choiceKeys,
      request: {
        interactionId,
        kind: mapping.interactionKind,
        payload: {
          presentation: { title: mapping.title, message: prompt.question },
          fields: [{
            id: mapping.fieldId,
            label: prompt.question,
            type: 'single_select',
            required: true,
            allowOther: false,
            secret: false,
            options
          }],
          actions: ['submit', 'cancel'],
          answerShape: 'answers',
          confirmUnanswered: false
        },
        turnId,
        itemId
      }
    };
  }

  async function open(openOptions) {
    if (disposed) throw new AgentSessionError('pty_adapter_disposed', { sessionId });
    if (!readScreen || !writeInput) {
      throw new AgentSessionError('pty_screen_source_required', {
        sessionId,
        missing: [
          readScreen ? null : 'readScreen',
          writeInput ? null : 'writeInput'
        ].filter(Boolean)
      });
    }
    const input = openOptions && typeof openOptions === 'object' ? openOptions : {};
    if (input.newSession === true) {
      // PTY adapter 附着在既有终端上；它没有能力新开一个 harness 会话，
      // 假装成功会让调用方以为新会话已经起来了。
      throw new AgentSessionError('pty_new_session_unsupported', { sessionId });
    }
    if (opened) return describeSession();
    opened = true;
    if (onScreen) {
      try {
        unsubscribeScreen = onScreen(scan);
      } catch (_error) {
        // 推模式坏了还有轮询兜底，不必让 open 失败。
        unsubscribeScreen = null;
      }
    }
    // 即使有 onScreen 也保留轮询：附着到一个已经停在提示上的会话时，
    // 不会有新的终端输出来触发推送。
    scanTimer = setIntervalFn(scan, scanIntervalMs) || null;
    if (scanTimer && typeof scanTimer.unref === 'function') scanTimer.unref();
    return describeSession();
  }

  function describeSession() {
    // PTY 没有 mode/model 协商能力，返回空表就是「没有可选值」的诚实表达；
    // 因此也不实现 setMode/setModel，调用会得到 unsupported_operation。
    return { sessionId, models: [], modes: [] };
  }

  async function prompt(input) {
    if (disposed) throw new AgentSessionError('pty_adapter_disposed', { sessionId });
    if (!opened) throw new AgentSessionError('pty_adapter_not_open', { sessionId });
    const options = input && typeof input === 'object' ? input : {};
    const text = nonEmptyString(options.text);
    if (!text) throw new AgentSessionError('pty_prompt_text_required', { sessionId });
    if (Array.isArray(options.images) && options.images.length > 0) {
      // 终端里没有粘贴图片的通用办法，静默丢弃会让用户以为图片已送达。
      throw new AgentSessionError('pty_images_unsupported', { count: options.images.length });
    }
    const turnId = nonEmptyString(options.turnId);
    if (turnId) currentTurnId = turnId;
    writeOrThrow(text + NEWLINE, 'prompt');
    // PTY 没有回合完成信号：这里只承诺「输入已交给终端」。
    // 冒充 end_turn 会让上层以为模型已经答完。
    return { stopReason: 'submitted' };
  }

  async function cancel(reason) {
    if (disposed) throw new AgentSessionError('pty_adapter_disposed', { sessionId });
    if (!opened) throw new AgentSessionError('pty_adapter_not_open', { sessionId });
    writeOrThrow(INTERRUPT_KEYS, 'cancel');
    return { cancelled: true, reason: nonEmptyString(reason) || null };
  }

  function respond(interactionId, decision) {
    if (disposed) throw new AgentSessionError('pty_adapter_disposed', { sessionId });
    const id = nonEmptyString(interactionId);
    const record = records.get(id);
    if (!record) throw new AgentSessionError('pty_interaction_unknown', { interactionId: id });
    if (record.answered) throw new AgentSessionError('pty_interaction_already_answered', { interactionId: id });
    if (record.detached || activeRecord !== record) {
      // 屏幕已经不是这条提示了：再写按键会落到别的提示或 shell 上。
      throw new AgentSessionError('pty_interaction_stale', { interactionId: id });
    }
    const resolver = DECISION_KEY_RESOLVERS[record.kind];
    if (!resolver) throw new AgentSessionError('pty_interaction_kind_unsupported', { kind: record.kind });
    const keys = resolver(record, decision);
    writeOrThrow(keys + (record.submit === 'raw' ? '' : NEWLINE), 'respond');
    record.answered = true;
    retired.add(record.signature);
    activeRecord = null;
    detector.clearActivePrompt('answered');
  }

  function writeOrThrow(text, operation) {
    try {
      writeInput(text);
    } catch (error) {
      throw new AgentSessionError('pty_write_failed', {
        operation,
        cause: error && error.code ? error.code : String(error && error.message)
      });
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new AgentSessionError('agent_session_listener_invalid');
    }
    if (disposed) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function onInteractionRequest(handler) {
    if (typeof handler !== 'function') {
      throw new AgentSessionError('agent_session_listener_invalid');
    }
    if (disposed) return () => {};
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  function onInteractionExpire(handler) {
    if (typeof handler !== 'function') {
      throw new AgentSessionError('agent_session_listener_invalid');
    }
    if (disposed) return () => {};
    expireHandlers.add(handler);
    return () => {
      expireHandlers.delete(handler);
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    opened = false;
    if (scanTimer !== null) {
      try {
        clearIntervalFn(scanTimer);
      } catch (_error) {}
      scanTimer = null;
    }
    if (retractTimer !== null) {
      try {
        clearTimeoutFn(retractTimer);
      } catch (_error) {}
      retractTimer = null;
    }
    if (unsubscribeScreen) {
      try {
        unsubscribeScreen();
      } catch (_error) {}
      unsubscribeScreen = null;
    }
    detector.clearActivePrompt('disposed');
    records.clear();
    activeRecord = null;
    retired.clear();
    handlers.clear();
    expireHandlers.clear();
    listeners.clear();
  }

  return {
    id: ADAPTER_ID,
    provider,
    transport,
    open,
    prompt,
    cancel,
    respond,
    subscribe,
    onInteractionRequest,
    onInteractionExpire,
    dispose
  };
}

function resolveApprovalKey(record, decision) {
  const choiceId = nonEmptyString(decision && decision.choiceId);
  if (!choiceId) throw new AgentSessionError('pty_decision_choice_required');
  const keys = record.choiceKeys.get(choiceId);
  if (keys === undefined) throw new AgentSessionError('pty_decision_choice_unknown', { choiceId });
  return keys;
}

function resolveChoiceAnswerKey(record, decision) {
  const action = nonEmptyString(decision && decision.action) || 'submit';
  if (action !== 'submit') {
    // 编号选择器没有「拒绝」键位；猜一个 Esc 可能把用户带进更糟的状态，
    // 所以宁可拒绝写入。
    throw new AgentSessionError('pty_decision_action_unsupported', { action });
  }
  const raw = decision && decision.answers ? decision.answers[record.fieldId] : undefined;
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : '') : raw;
  const answer = nonEmptyString(value);
  if (!answer) throw new AgentSessionError('pty_decision_answer_required', { field: record.fieldId });
  const keys = record.choiceKeys.get(answer);
  if (keys === undefined) throw new AgentSessionError('pty_decision_choice_unknown', { choice: answer });
  return keys;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

module.exports = { createAdapter };
