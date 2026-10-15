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

function createNativeSessionEventMapper(options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const turnId = String(options.turnId || '').trim();
  const assistantItemId = String(options.assistantItemId || '').trim();
  let content = '';
  let toolSeq = 0;
  let error = '';
  // 助手条目的生命周期状态：canonical 投影器只在收到 timeline.item.started/completed 时建条目，
  // 纯 delta 会被忽略（timeline-projector 的 appendDelta 找不到条目就丢）。因此首个 delta 前
  // 必须先发 started，轮次收尾时必须补 completed。
  let assistantStarted = false;
  let assistantCompleted = false;

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
              detail: { role: 'assistant', model: String(event.model || '').trim() || undefined }
            }
          }
        });
        return out;
      }

      if (type === 'error') {
        error = String(event.message || event.error || 'native_session_failed').trim() || 'native_session_failed';
        out.error = error;
        return out;
      }

      if (TERMINAL_EVENT_TYPES.has(type) || type === 'retry-status' || type === 'cli-install-progress') {
        // 透传为瞬时事件：canonical 客户端认得的会渲染（终端/重试/安装进度），
        // 不认得的忽略，不影响时间线。
        out.events.push({ ...base(), type: `transient.${type}`, payload: { provider, event } });
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
      if (assistantCompleted || !text) return { event: null, content };
      assistantCompleted = true;
      assistantStarted = true;
      return {
        event: {
          ...base(),
          type: 'timeline.item.completed',
          itemId: assistantItemId,
          payload: { item: assistantItem('completed', text) }
        },
        content
      };
    }
  };
}

module.exports = { createNativeSessionEventMapper };
