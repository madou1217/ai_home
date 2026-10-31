'use strict';

// 原生会话事件 → canonical 事件（与 codex-session-event-bridge 同职责）。
//
// legacy 引擎（lib/server/native-session-chat.js 的 spawnNativeSessionStream）产出的是
// 已经渲染好的字符串事件（delta / assistant_tool_call / assistant_tool_result / result /
// error / session-created / terminal-output / interactive-prompt / retry-status …）。
// 这里把它翻译成 canonical 的 timeline.item.* 词汇，让 work 会话在 canonical 里
// 与 codex harness 走同一套时间线渲染。
//
// 只做映射，不做 I/O：调用方（native-session-driver）决定把事件发到哪个端口。

const TERMINAL_EVENT_TYPES = new Set(['terminal-output', 'interactive-prompt']);

/** retry-status / cli-install-progress → 本轮一条运行提示事件（同一 itemId 原地更新）。 */
function nativeRuntimeNoticeEvent(type, event, turnId) {
  const notice = runtimeNoticeFor(type, event);
  if (!notice) return null;
  const turn = String(turnId || '').trim();
  const itemId = `native-${type}-${turn || 'turn'}`;
  return {
    ...(turn ? { turnId: turn } : {}),
    type: notice.done ? 'timeline.item.completed' : 'timeline.item.started',
    itemId,
    payload: {
      item: {
        id: itemId,
        kind: 'notice',
        createdAt: 0,
        updatedAt: 0,
        status: notice.done ? 'completed' : 'running',
        content: notice.text,
        detail: { level: notice.level, code: type === 'retry-status' ? 'native_retry' : 'cli_install' },
        ...(turn ? { turnId: turn } : {})
      }
    }
  };
}

/** retry-status / cli-install-progress → 提示文案（与 legacy 状态条同口径）。 */
function runtimeNoticeFor(type, event = {}) {
  if (type === 'retry-status') {
    const phase = String(event.phase || 'scheduled');
    if (phase === 'recovered' || phase === 'succeeded') return { text: '已恢复，继续生成', level: 'success', done: true };
    if (phase === 'exhausted' || phase === 'failed') {
      return { text: String(event.message || '重试次数已用完'), level: 'warning', done: true };
    }
    const attempt = event.attempt ? `第 ${event.attempt}${event.maxAttempts ? `/${event.maxAttempts}` : ''} 次` : '';
    const wait = Number(event.retryAfterMs) > 0 ? `，${Math.ceil(Number(event.retryAfterMs) / 1000)} 秒后` : '';
    const reason = event.message || event.reason ? `（${String(event.message || event.reason).slice(0, 120)}）` : '';
    return { text: `上游暂时不可用，正在重试${attempt ? ` ${attempt}` : ''}${wait}${reason}`, level: 'warning', done: false };
  }
  // installPhase 来自 ensureNativeCliReadyForChat（native-session-chat-launch）。
  const phase = String(event.installPhase || event.phase || event.status || '');
  const provider = String(event.provider || '').trim();
  const name = provider ? `${provider} CLI` : 'CLI';
  const label = String(event.message || '').trim();
  if (phase === 'installed') return { text: `${name} 已安装，继续本轮`, level: 'success', done: true };
  if (phase === 'cancelled') return { text: label || `已取消安装 ${name}`, level: 'warning', done: true };
  if (phase === 'failed') return { text: label || `${name} 安装失败`, level: 'warning', done: true };
  if (phase === 'plan-failed') {
    return { text: `${event.planLabel || '当前方式'}安装失败，尝试下一种方式…`, level: 'warning', done: false };
  }
  return { text: event.planLabel ? `正在安装 ${name}（${event.planLabel}）…` : `正在安装 ${name}…`, level: 'info', done: false };
}

function createNativeSessionEventMapper(options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const turnId = String(options.turnId || '').trim();
  const assistantItemId = String(options.assistantItemId || '').trim();
  const slash = options.slash === true;
  const terminalItemId = `native-terminal-${turnId || 'turn'}`;
  // 本轮的模型由驱动在起轮时确定（引擎 result 事件偶尔不带模型），作为兜底写进助手条目。
  // 推理强度刻意不兜底：原生 CLI 没有接收 effort 的通道，写策略里的意图会让界面撒谎。
  const turnModel = String(options.model || '').trim();
  let content = '';
  let toolSeq = 0;
  let error = '';
  // 助手条目的生命周期状态：canonical 投影器只在收到 timeline.item.started/completed 时建条目，
  // 纯 delta 会被忽略（timeline-projector 的 appendDelta 找不到条目就丢）。因此首个 delta 前
  // 必须先发 started，轮次收尾时必须补 completed。
  let assistantStarted = false;
  let assistantCompleted = false;
  let terminalContent = '';
  let terminalStarted = false;
  let terminalCompleted = false;

  const base = () => (turnId ? { turnId } : {});

  const assistantItem = (status, text) => ({
    id: assistantItemId,
    kind: 'message',
    createdAt: 0,
    updatedAt: 0,
    status,
    content: String(text || ''),
    detail: { role: 'assistant' }
  });

  return {
    /** @returns {{events: object[], error: string, content: string, nativeSessionId: string}} */
    map(event) {
      const out = { events: [], error: '', content, nativeSessionId: '' };
      const type = String(event && event.type || '').trim();
      if (!type) return out;

      if (type === 'session-created') {
        out.nativeSessionId = String(event.sessionId || '').trim();
        return out;
      }

      if (type === 'delta') {
        const chunk = String(event.delta || '');
        if (chunk) {
          content += chunk;
          if (!assistantStarted) {
            assistantStarted = true;
            out.events.push({
              ...base(),
              type: 'timeline.item.started',
              itemId: assistantItemId,
              payload: { item: assistantItem('streaming', '') }
            });
          }
          out.events.push({
            ...base(),
            type: 'timeline.item.delta',
            itemId: assistantItemId,
            payload: { itemId: assistantItemId, chunk }
          });
        }
        out.content = content;
        return out;
      }

      if (type === 'assistant_tool_call' || type === 'assistant_tool_result') {
        const text = String(event.content || '').trim();
        if (text) {
          toolSeq += 1;
          const itemId = `native-tool-${turnId || 'turn'}-${toolSeq}`;
          out.events.push({
            ...base(),
            type: 'timeline.item.completed',
            itemId,
            payload: {
              item: {
                id: itemId,
                kind: 'tool',
                createdAt: 0,
                updatedAt: 0,
                status: 'completed',
                content: text,
                detail: {
                  name: type === 'assistant_tool_call' ? 'Tool' : 'Tool result',
                  callId: itemId
                }
              }
            }
          });
        }
        return out;
      }

      if (type === 'result') {
        // 引擎给的 result.content 是权威终稿：以它收口，避免 delta 与终稿不一致。
        const final = String(event.content || '').trim() || content;
        content = final;
        out.content = content;
        assistantCompleted = true;
        out.events.push({
          ...base(),
          type: 'timeline.item.completed',
          itemId: assistantItemId,
          payload: {
            item: {
              ...assistantItem('completed', final),
              detail: {
                role: 'assistant',
                ...(String(event.model || '').trim() || turnModel
                  ? { model: String(event.model || '').trim() || turnModel } : {}),
                // 引擎自己报了档位才记录（例如 CLI 回显）。
                ...(String(event.effort || '').trim() ? { effort: String(event.effort).trim() } : {})
              }
            }
          }
        });
        return out;
      }

      if (type === 'terminal-output' && slash) {
        const chunk = String(event.text || '');
        if (chunk) {
          terminalContent += chunk;
          if (!terminalStarted) {
            terminalStarted = true;
            out.events.push({
              ...base(),
              type: 'timeline.item.started',
              itemId: terminalItemId,
              payload: { item: {
                id: terminalItemId,
                kind: 'terminal',
                createdAt: 0,
                updatedAt: 0,
                status: 'running',
                content: '',
                detail: { stream: 'stdout' }
              } }
            });
          }
          out.events.push({
            ...base(),
            type: 'timeline.item.delta',
            itemId: terminalItemId,
            payload: { itemId: terminalItemId, chunk, detail: { channel: 'output' } }
          });
        }
        return out;
      }

      if (type === 'error') {
        error = String(event.message || event.error || 'native_session_failed').trim() || 'native_session_failed';
        out.error = error;
        return out;
      }

      // 重试倒计时 / CLI 安装进度（legacy 用状态条展示）：映射成本轮一条运行提示，原地更新，
      // 不再静默丢弃 —— 否则换号重试或首次装 CLI 时界面看起来像卡死。
      if (type === 'retry-status' || type === 'cli-install-progress') {
        const notice = nativeRuntimeNoticeEvent(type, event, turnId);
        if (notice) out.events.push(notice);
        return out;
      }

      if (TERMINAL_EVENT_TYPES.has(type)) {
        // Native slash runs use the provider TUI as their input channel.  The
        // canonical work timeline has no terminal transport event, so consume
        // these PTY frames here instead of emitting an event type the strict
        // chat contract cannot validate.  Completion and transcript events
        // still settle the turn normally.
        return out;
      }

      return out;
    },

    /**
     * 轮次收尾：若引擎没发 `result`（agy 这类只流式输出正文的 provider），补一条 completed 收口，
     * 否则时间线会停在 streaming 状态（投影器只认 started/completed 建条目）。
     * @returns {{event: object|null, content: string}}
     */
    finalize() {
      const text = String(content || '').trim();
      if (slash && terminalStarted && !terminalCompleted) {
        terminalCompleted = true;
        return {
          event: {
            ...base(),
            type: 'timeline.item.completed',
            itemId: terminalItemId,
            payload: { item: {
              id: terminalItemId,
              kind: 'terminal',
              createdAt: 0,
              updatedAt: 0,
              status: 'completed',
              content: terminalContent,
              detail: { stream: 'stdout' }
            } }
          },
          content
        };
      }
      if (assistantCompleted || !text) return { event: null, content };
      assistantCompleted = true;
      assistantStarted = true;
      return {
        event: {
          ...base(),
          type: 'timeline.item.completed',
          itemId: assistantItemId,
          payload: {
            item: {
              ...assistantItem('completed', text),
              // 引擎没发 result 时也要带上本轮模型，否则消息元信息只能靠前端猜。
              ...(turnModel ? { detail: { role: 'assistant', model: turnModel } } : {})
            }
          }
        },
        content
      };
    }
  };
}

module.exports = {
  nativeRuntimeNoticeEvent, createNativeSessionEventMapper };
