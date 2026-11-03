'use strict';

// aih peer 的 **webui-chat 通道**：投给 WebUI chat runtime 里的会话。
//
// 为什么它和 inject 不是一回事：chat runtime 有正规的命令总线
// （`POST /v0/webui/chat/sessions/:id/commands`，见 webui-chat-runtime-routes.js），
// 投递是一条带 `commandId` 的幂等命令，不是往 pane 里敲字。所以这里没有安静期、
// 没有 `send-keys`：忙就排队（`queue.add`），由 runtime 自己在回合边界派发。
//
// 鉴权：`/v0/webui/*` 即使 loopback 也要求 Management Key（webui-auth-gate.js），
// 地址和 key 都从 server config 读。server 没起 / 没配 key 时**静默降级成空列表**，
// 与 native 通道吞掉 claude 探测错误的行为一致——peer 的其它通道照常可用。
//
// 能力边界：chat 会话固定走 Codex driver 且工具被禁用（chat-harness-policy.js），
// 所以发过去的消息只能让它「说话」，不能让它执行命令。这是有意的隔离，不是缺陷。

const DEFAULT_PORT = 9527;
const REQUEST_TIMEOUT_MS = 2_000;

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return text || '';
}

/** server 侧的端口和 key 是运行时才知道的（监听前 / 轮换后），允许传函数。 */
function resolveLazy(value, fallback) {
  if (typeof value === 'function') {
    try {
      return value();
    } catch (_error) {
      return fallback;
    }
  }
  return value == null ? fallback : value;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

function createWebuiChatAdapter(deps = {}) {
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const readServerConfigImpl = deps.readServerConfig || null;
  const fsImpl = deps.fs || require('node:fs');

  /** 解析 base url + key；任一缺失就返回 null（调用方按「本通道不可用」处理）。 */
  function resolveEndpoint(options = {}) {
    const lazyBaseUrl = normalizeBaseUrl(resolveLazy(options.serverBaseUrl, ''));
    const lazyKey = String(resolveLazy(options.managementKey, '') || '').trim();
    let config = null;
    if (!lazyBaseUrl || !lazyKey) {
      try {
        config = typeof readServerConfigImpl === 'function'
          ? readServerConfigImpl({ fs: fsImpl, aiHomeDir: options.aiHomeDir })
          : null;
      } catch (_error) {
        config = null;
      }
    }
    const baseUrl = lazyBaseUrl || `http://127.0.0.1:${Number(config && config.port) || DEFAULT_PORT}`;
    const key = lazyKey || String(config && config.managementKey || '').trim();
    if (!key || !fetchImpl) return null;
    return { baseUrl, key };
  }

  async function request(method, path, body, endpoint) {
    let response;
    try {
      response = await fetchImpl(`${endpoint.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${endpoint.key}`
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: timeoutSignal(REQUEST_TIMEOUT_MS)
      });
    } catch (_error) {
      return { status: 0, ok: false, payload: { error: 'chat_runtime_unavailable' } };
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }
    return { status: response.status, ok: response.ok === true, payload: payload || {} };
  }

  function errorCodeOf(result) {
    return String(result && result.payload && result.payload.error || '').trim();
  }

  function sendCommand(endpoint, sessionId, command) {
    return request(
      'POST',
      `/v0/webui/chat/sessions/${encodeURIComponent(sessionId)}/commands`,
      { commandId: command.commandId, type: command.type, payload: command.payload },
      endpoint
    );
  }

  function toRow(session) {
    const sessionId = String(session && session.sessionId || '').trim();
    if (!sessionId) return null;
    const policy = session && session.policy && typeof session.policy === 'object' ? session.policy : {};
    const title = String(policy.title || '').trim();
    return {
      id: `chat:${sessionId}`,
      channel: 'webui-chat',
      provider: String(session.provider || '').trim(),
      name: title || sessionId,
      address: sessionId,
      sessionId,
      cwd: String(session.projectPath || '').trim(),
      status: String(session.state || '').trim() || 'idle',
      lastActivityAt: Number(session.updatedAt) || 0,
      title
    };
  }

  return {
    id: 'webui-chat',
    channel: 'webui-chat',

    /** 列出 chat runtime 里的会话；server 没起 / 没配 key 时返回空数组。 */
    async listSessions(options = {}) {
      const endpoint = resolveEndpoint(options);
      if (!endpoint) return [];
      const result = await request('GET', '/v0/webui/chat/sessions', undefined, endpoint);
      if (!result.ok) return [];
      const sessions = Array.isArray(result.payload.sessions) ? result.payload.sessions : [];
      return sessions
        .filter((session) => String(session && session.state || '') !== 'closed')
        .map(toRow)
        .filter(Boolean);
    },

    /**
     * 单目标探测：只读这一个会话的快照拿 state。
     * 补投 tick 用；比 listSessions 少一次全表查询。
     */
    async probe(target, options = {}) {
      const endpoint = resolveEndpoint(options);
      if (!endpoint) return { ok: false, error: 'chat_runtime_unavailable' };
      const sessionId = String(target && (target.sessionId || target.address) || '').trim();
      if (!sessionId) return { ok: false, error: 'missing_session_target' };
      const result = await request(
        'GET',
        `/v0/webui/chat/sessions/${encodeURIComponent(sessionId)}/snapshot`,
        undefined,
        endpoint
      );
      if (result.status === 404) return { ok: false, error: 'session_not_found' };
      if (!result.ok) return { ok: false, error: errorCodeOf(result) || 'chat_runtime_failed' };
      const snapshot = result.payload.snapshot || {};
      return {
        ok: true,
        alive: true,
        state: String(snapshot.state || '').trim() || 'idle',
        lastActivityAt: 0
      };
    },

    /**
     * 投递：空闲直接开一轮；忙就排队，让 runtime 在回合边界派发。
     * 三级降级：turn.submit → queue.add → turn.intervene。
     */
    async send(target, text, options = {}) {
      const endpoint = resolveEndpoint(options);
      if (!endpoint) {
        return {
          ok: false,
          error: 'chat_runtime_unavailable',
          message: 'WebUI chat runtime 没在跑或没配 Management Key；消息先留在收件箱。'
        };
      }
      const sessionId = String(target && (target.sessionId || target.address) || '').trim();
      if (!sessionId) return { ok: false, error: 'missing_session_target' };
      if (options.dryRun) {
        return {
          ok: true,
          channel: 'webui-chat',
          dryRun: true,
          commands: [`POST ${endpoint.baseUrl}/v0/webui/chat/sessions/${sessionId}/commands turn.submit`]
        };
      }

      const base = String(options.messageId || '').trim() || `peer-${Date.now().toString(36)}`;
      const content = String(text == null ? '' : text);
      const attempts = [];

      const submit = await sendCommand(endpoint, sessionId, {
        commandId: `${base}-submit`,
        type: 'turn.submit',
        payload: { content }
      });
      if (submit.ok) {
        return { ok: true, channel: 'webui-chat', session: sessionId, commandId: `${base}-submit` };
      }
      attempts.push({ type: 'turn.submit', status: submit.status, error: errorCodeOf(submit) });

      const queued = await sendCommand(endpoint, sessionId, {
        commandId: `${base}-queue`,
        type: 'queue.add',
        payload: { content, policy: 'after_turn' }
      });
      if (queued.ok) {
        return {
          ok: true,
          channel: 'webui-chat',
          session: sessionId,
          queued: true,
          commandId: `${base}-queue`
        };
      }
      attempts.push({ type: 'queue.add', status: queued.status, error: errorCodeOf(queued) });

      const steered = await sendCommand(endpoint, sessionId, {
        commandId: `${base}-steer`,
        type: 'turn.intervene',
        payload: { mode: 'steer_current', content }
      });
      if (steered.ok) {
        return {
          ok: true,
          channel: 'webui-chat',
          session: sessionId,
          steered: true,
          commandId: `${base}-steer`
        };
      }
      attempts.push({ type: 'turn.intervene', status: steered.status, error: errorCodeOf(steered) });

      return {
        ok: false,
        error: 'chat_target_busy',
        attempts,
        message: 'chat 会话现在不接受新轮次；消息先留在收件箱，空闲后自动投递。'
      };
    }
  };
}

module.exports = { createWebuiChatAdapter, DEFAULT_PORT, REQUEST_TIMEOUT_MS };
