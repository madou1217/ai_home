'use strict';

const protocol = require('./codex-app-server-protocol');

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 8;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function createAppServerClient(options = {}) {
  const WebSocketImpl = options.wsImpl || require('ws');
  const resolveEndpoint = options.resolveEndpoint;
  const state = {
    ws: null,
    nextId: 1,
    pending: new Map(),
    turns: new Map(),
    connecting: null,
    closedForever: false,
    ready: false,
    verifiedAccountIdentity: null
  };

  async function dial() {
    if (state.closedForever) throw closedClientError();
    const endpoint = await resolveEndpoint();
    const ws = new WebSocketImpl(endpoint);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('close', () => handleClose(ws));
    ws.on('error', () => { /* close 事件统一处理 */ });
    state.ws = ws;
    state.ready = false;
    state.verifiedAccountIdentity = null;
    try {
      const initialize = await requestOn(ws, 'initialize', {
        clientInfo: { name: 'aih-webui', title: 'AI Home WebUI', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      });
      notifyOn(ws, 'initialized', {});
      if (typeof options.accountIdentityValidator === 'function') {
        const accountRead = await requestOn(ws, 'account/read', { refreshToken: false });
        state.verifiedAccountIdentity = verifiedAccountIdentity(
          await options.accountIdentityValidator({
            initializeResult: initialize,
            accountResult: accountRead
          })
        );
      }
      if (state.closedForever) throw closedClientError();
      state.ready = true;
      return ws;
    } catch (error) {
      state.ready = false;
      state.verifiedAccountIdentity = null;
      if (state.ws === ws) state.ws = null;
      try { ws.terminate ? ws.terminate() : ws.close(); } catch (_closeError) {}
      throw error;
    }
  }

  function requestOn(ws, method, params) {
    const id = state.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      try {
        ws.send(payload);
      } catch (error) {
        state.pending.delete(id);
        reject(error);
      }
    });
  }

  function notifyOn(ws, method, params) {
    try {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch (_error) { /* 断线由 close 流程处理 */ }
  }

  function handleMessage(ws, data) {
    let message = null;
    try {
      message = JSON.parse(String(data));
    } catch (_error) {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && !message.method) {
      settlePendingRequest(message);
      return;
    }
    const params = message.params && typeof message.params === 'object'
      ? message.params
      : {};
    const binding = state.turns.get(normalizeString(params.threadId));
    if (message.method && message.id !== undefined) {
      forwardServerRequest(ws, binding, message);
      return;
    }
    if (binding && typeof binding.onNotification === 'function') {
      binding.onNotification(message);
    }
  }

  function settlePendingRequest(message) {
    const waiter = state.pending.get(message.id);
    if (!waiter) return;
    state.pending.delete(message.id);
    if (message.error) {
      waiter.reject(codedError(
        'codex_app_server_rpc_error',
        normalizeString(message.error.message) || JSON.stringify(message.error)
      ));
      return;
    }
    waiter.resolve(message.result);
  }

  function forwardServerRequest(ws, binding, message) {
    if (binding && typeof binding.onServerRequest === 'function') {
      binding.onServerRequest(message);
      return;
    }
    try {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `unhandled server request: ${message.method}` }
      }));
    } catch (_error) { /* ignore */ }
  }

  function handleClose(ws) {
    if (state.ws !== ws) return;
    state.ws = null;
    state.ready = false;
    state.verifiedAccountIdentity = null;
    rejectPendingRequests(codedError(
      'codex_app_server_disconnected',
      'codex app-server 连接断开'
    ));
    if (state.turns.size === 0 || state.closedForever) return;
    reconnectLoop().catch((error) => {
      for (const [, binding] of state.turns) {
        if (typeof binding.onDisconnected === 'function') binding.onDisconnected(error);
      }
      state.turns.clear();
    });
  }

  function rejectPendingRequests(error) {
    for (const [, waiter] of state.pending) waiter.reject(error);
    state.pending.clear();
  }

  async function reconnectLoop() {
    let lastError = null;
    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      const delayMs = RECONNECT_BASE_DELAY_MS * attempt;
      notifyTurnBindings('onReconnectAttempt', {
        attempt,
        maxAttempts: RECONNECT_MAX_ATTEMPTS,
        delayMs
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (state.turns.size === 0) return;
      try {
        const ws = await ensureConnected();
        for (const [threadId, binding] of state.turns) {
          await requestOn(ws, 'thread/resume', binding.resumeParams || protocol.buildThreadResumeParams({
            threadId,
            approvalMode: 'confirm'
          }));
        }
        notifyTurnBindings('onReconnectRecovered', { attempt });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || codedError(
      'codex_app_server_reconnect_failed',
      'codex app-server 重连失败'
    );
  }

  function notifyTurnBindings(callback, payload) {
    for (const [, binding] of state.turns) {
      if (typeof binding[callback] !== 'function') continue;
      try {
        binding[callback](payload);
      } catch (_error) { /* 观察回调不能打断 transport 恢复 */ }
    }
  }

  async function ensureConnected() {
    if (state.closedForever) throw closedClientError();
    if (state.connecting) return state.connecting;
    if (state.ws && state.ready) return state.ws;
    state.connecting = dial().finally(() => {
      state.connecting = null;
    });
    return state.connecting;
  }

  return {
    async request(method, params) {
      const ws = await ensureConnected();
      return requestOn(ws, method, params);
    },
    respond(id, result) {
      return sendResponse({ jsonrpc: '2.0', id, result });
    },
    respondError(id, code, message) {
      return sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
    },
    bindTurn(threadId, binding) {
      if (state.closedForever) throw closedClientError();
      state.turns.set(normalizeString(threadId), binding);
    },
    unbindTurn(threadId) {
      state.turns.delete(normalizeString(threadId));
      if (state.turns.size === 0 && typeof options.onIdle === 'function') {
        options.onIdle();
      }
    },
    hasActiveTurns() {
      return state.turns.size > 0;
    },
    getVerifiedAccountIdentity() {
      return state.verifiedAccountIdentity
        ? { ...state.verifiedAccountIdentity }
        : null;
    },
    ensureConnected,
    destroy() {
      if (state.closedForever) return;
      state.closedForever = true;
      state.turns.clear();
      state.ready = false;
      state.verifiedAccountIdentity = null;
      rejectPendingRequests(codedError(
        'codex_app_server_disconnected',
        'Codex app-server 连接已关闭'
      ));
      if (state.ws) {
        try { state.ws.terminate ? state.ws.terminate() : state.ws.close(); } catch (_error) { /* ignore */ }
        state.ws = null;
      }
    }
  };

  function sendResponse(payload) {
    if (!state.ws || !state.ready) return false;
    try {
      state.ws.send(JSON.stringify(payload));
      return true;
    } catch (_error) {
      return false;
    }
  }
}

function verifiedAccountIdentity(value) {
  const identity = value && typeof value === 'object' ? value : {};
  const identityHash = normalizeString(identity.identityHash);
  const executionAccountHash = normalizeString(identity.executionAccountHash);
  const runtimeHomeHash = normalizeString(identity.runtimeHomeHash);
  if (
    identity.verified !== true
    || !isSha256(runtimeHomeHash)
  ) {
    throw unverifiedAccountError();
  }
  if (
    identity.kind === 'oauth'
    && identity.assurance === 'identity'
    && isSha256(identityHash)
  ) {
    return Object.freeze({
      verified: true,
      kind: 'oauth',
      assurance: 'identity',
      identityHash,
      runtimeHomeHash
    });
  }
  if (
    identity.kind === 'api-key'
    && identity.assurance === 'execution-credential'
    && isSha256(executionAccountHash)
  ) {
    return Object.freeze({
      verified: true,
      kind: 'api-key',
      assurance: 'execution-credential',
      executionAccountHash,
      runtimeHomeHash
    });
  }
  throw unverifiedAccountError();
}

function unverifiedAccountError() {
  return codedError(
    'codex_account_identity_not_verified',
    'Codex app-server account context was not verified'
  );
}

function closedClientError() {
  return codedError(
    'codex_app_server_client_closed',
    'Codex app-server resident client is closed'
  );
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(normalizeString(value));
}

module.exports = { createAppServerClient };
