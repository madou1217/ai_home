'use strict';

// Codex Responses WebSocket → 网关 HTTP `/v1/responses` 适配器（Adapter）。
//
// 问题：宿主 Codex 的 aih provider 声明 `supports_websockets = true`，于是 Codex 对**任何模型**
// 都先走 WS。WS 通道（codex-responses-websocket.js）只会把帧中继给 Codex 账号的上游 WS；
// 当模型是别名 / 其它 provider（kiro、qoder、claude……）时，Codex 账号池里没有能服务它的账号，
// 首帧直接被 503 拒绝——Codex 要等重试预算耗尽才回落 HTTP（上游 issue #19821 / #22634），
// 表现就是「Codex 里用别名模型一直卡住 / 失败」。
//
// 解法：把「网关 HTTP 通道」包装成一个与上游 WS 同接口的连接（readyState / send / on('message') /
// close / terminate），由 WS 会话桥照常驱动。HTTP 通道复用网关的完整管线（别名解析、按 provider
// 选号、协议桥、工具与流内错误语义、用量记账），因此任意 provider 在 Codex WS 下与 HTTP 下行为一致。
//   * 请求：response.create 帧 → POST /v1/responses（stream:true）。WS 协议用 previous_response_id
//     增量续接，而 HTTP 下游 provider 没有服务端状态，所以用回放账本展开成完整 input；
//   * 响应：SSE 的每个 `data:` 事件原样作为一个 WS 文本帧（两条 wire 的事件 JSON 相同）；
//   * generate:false（预热帧）不打上游，直接回一个空的 created/completed。

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { createResponseReplayLedger } = require('./codex-response-recovery');

const WS_OPEN = 1;
const WS_CLOSED = 3;
// 伪账号：只用于会话桥的「当前连接」身份；记账钩子据此跳过（真实账号由 HTTP 管线记账）。
const GATEWAY_HTTP_ACCOUNT = Object.freeze({ accountRef: 'aih_gateway_http', gatewayHttp: true });
// 透传给 HTTP 管线的请求头（会话粘性、Codex 标识、aih 钉选）；鉴权头单独处理。
const FORWARDED_HEADER_PATTERN = /^(?:x-aih-|x-account-ref$|x-codex-|session_id$|session-id$|originator$|openai-beta$|user-agent$|x-client-request-id$|conversation_id$)/i;

function isGatewayHttpAccount(account) {
  return Boolean(account && account.gatewayHttp === true);
}

function resolveLoopbackBaseUrl(options = {}) {
  const host = String(options.host || '').trim();
  const usable = host && !['0.0.0.0', '::', '[::]'].includes(host) ? host : '127.0.0.1';
  const hostPart = usable.includes(':') && !usable.startsWith('[') ? `[${usable}]` : usable;
  return `http://${hostPart}:${Number(options.port) || 9527}`;
}

function buildForwardHeaders(clientHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream'
  };
  for (const [key, value] of Object.entries(clientHeaders || {})) {
    if (typeof value !== 'string') continue;
    if (key.toLowerCase() === 'authorization' || FORWARDED_HEADER_PATTERN.test(key)) headers[key.toLowerCase()] = value;
  }
  return headers;
}

/** 增量 SSE 解析：只关心 data 行（Responses 事件自带 type）。 */
function createSseDataParser(onData) {
  let buffer = '';
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data && data !== '[DONE]') onData(data);
  };
  return {
    push(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) flush();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    },
    end() {
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
      buffer = '';
      flush();
    }
  };
}

function errorFrame(status, code, message) {
  return JSON.stringify({ type: 'error', status, error: { type: code, code, message } });
}

/**
 * @param {{ baseUrl: string, clientHeaders?: object, fetchImpl?: Function, maxReplayBytes?: number }} options
 * @returns {{ ws: EventEmitter, account: object, finish: Function }}
 */
function createGatewayHttpResponsesConnection(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const endpoint = `${String(options.baseUrl || '').replace(/\/+$/, '')}/v1/responses`;
  const headers = buildForwardHeaders(options.clientHeaders);
  const ledger = createResponseReplayLedger(options.maxReplayBytes);
  const ws = new EventEmitter();
  let controller = null;
  let queue = Promise.resolve();

  ws.readyState = WS_OPEN;
  ws.pause = () => {};
  ws.resume = () => {};

  const emitFrame = (text) => {
    if (ws.readyState === WS_OPEN) ws.emit('message', Buffer.from(text), false);
  };

  const close = (code = 1000, reason = '') => {
    if (ws.readyState === WS_CLOSED) return;
    ws.readyState = WS_CLOSED;
    if (controller) controller.abort();
    ws.emit('close', code, Buffer.from(reason));
  };
  ws.terminate = () => close(1000, 'terminated');
  ws.close = (code, reason) => close(code, reason);

  async function runResponse(payload) {
    const input = ledger.expand(payload);
    if (payload.previous_response_id && !input) {
      emitFrame(errorFrame(400, 'previous_response_not_found',
        'previous_response_id is unknown to the gateway HTTP bridge; resend the full input'));
      return;
    }
    if (payload.generate === false) {
      // 预热帧：没有推理，回一个空完成即可（与上游语义一致：不产生输出）。
      const response = { id: `resp_${crypto.randomUUID().replace(/-/g, '')}`, object: 'response', status: 'completed', model: payload.model, output: [] };
      emitFrame(JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress' } }));
      emitFrame(JSON.stringify({ type: 'response.completed', response }));
      ledger.complete(response, input);
      return;
    }
    const body = { ...(ledger.replay(payload, input) || { ...payload, input }), stream: true };
    delete body.type;
    delete body.generate;
    controller = new AbortController();
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      if (ws.readyState === WS_OPEN) emitFrame(errorFrame(502, 'gateway_unavailable', `gateway HTTP bridge failed: ${error && error.message}`));
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text;
      try {
        const parsed = JSON.parse(text);
        message = (parsed && parsed.error && (parsed.error.message || parsed.error.code)) || parsed.detail || text;
      } catch (_error) { /* raw text */ }
      emitFrame(errorFrame(response.status, 'upstream_error', String(message || `upstream_${response.status}`)));
      return;
    }
    const parser = createSseDataParser((data) => {
      let event = null;
      try {
        event = JSON.parse(data);
      } catch (_error) {
        return;
      }
      if (event && event.type === 'response.completed') ledger.complete(event.response, input);
      emitFrame(data);
    });
    try {
      for await (const chunk of response.body) parser.push(Buffer.from(chunk));
      parser.end();
    } catch (error) {
      if (ws.readyState === WS_OPEN) emitFrame(errorFrame(502, 'stream_interrupted', `gateway stream interrupted: ${error && error.message}`));
    } finally {
      controller = null;
    }
  }

  ws.send = (data, _options, callback) => {
    const done = typeof _options === 'function' ? _options : callback;
    if (ws.readyState !== WS_OPEN) {
      if (done) done(new Error('closed'));
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch (_error) {
      payload = null;
    }
    if (payload && payload.type === 'response.cancel') {
      if (controller) controller.abort();
    } else if (payload && payload.type === 'response.create') {
      // 串行：WS 协议允许流水线，但 HTTP 续接依赖上一轮 response.completed 写入账本。
      queue = queue.then(() => runResponse(payload)).catch(() => {});
    }
    if (done) done();
  };

  return { ws, account: GATEWAY_HTTP_ACCOUNT, finish: () => {} };
}

module.exports = {
  GATEWAY_HTTP_ACCOUNT,
  buildForwardHeaders,
  createGatewayHttpResponsesConnection,
  createSseDataParser,
  isGatewayHttpAccount,
  resolveLoopbackBaseUrl
};
