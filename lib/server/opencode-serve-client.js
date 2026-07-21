'use strict';

// 本地 `opencode serve` HTTP API 的最小客户端(P3c:confirm 审批模式)。
// ⚠️ 与 opencode-server-client.js(Zen 云端客户端)无关——这里只打 localhost serve 实例。
//
// 端点契约(1.4.7 与 1.17.13 真机实证,2026-07-04):
//   GET  /global/health                      → {healthy:true,version}
//   POST /session?directory=<abs>            → {id:"ses_*",directory,projectID,...}(directory 只认 query,body 无效)
//   PATCH /session/:id {permission:[...]}    → 会话级权限规则注入(confirm 模式按会话注入 ask,不碰全局配置)
//   POST /session/:id/prompt_async           → 204 立即返回,进展走 /event
//   POST /session/:id/abort                  → 200
//   GET  /permission                         → 挂起权限请求列表
//   POST /permission/:id/reply {reply,message} → "once"|"always"|"reject"
//   GET  /event                              → SSE 事件流(message.part.delta/permission.asked/session.idle 等,均带 sessionID)
//
// ⚠️ directory 作用域(1.17.13 实证):serve 内部按 directory 分 app 实例,/event、/permission、
// /permission/:id/reply 等都只作用于「请求携带的 ?directory=」对应实例(缺省=serve 进程 cwd)。
// 1.4.7 无此语义、多余的 ?directory 参数无害。因此所有调用一律带上会话的 directory,
// 否则(踩过的坑)事件流空转、权限列表恒空、tool 永远挂在 running。

const http = require('node:http');

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function normalizeBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^http:\/\//.test(text)) {
    const error = new Error(`opencode serve baseUrl 非法: ${text || '(空)'}`);
    error.code = 'opencode_serve_invalid_base_url';
    throw error;
  }
  return text;
}

// "opencode-go/glm-5.2" → {providerID,modelID}。无 "/" 或残缺 → null(prompt_async 不带 model,用会话默认)。
function parseOpenCodeModelRef(model) {
  const text = String(model || '').trim();
  const idx = text.indexOf('/');
  if (idx <= 0 || idx === text.length - 1) return null;
  return { providerID: text.slice(0, idx), modelID: text.slice(idx + 1) };
}

// SSE 帧解码器(纯状态机,单测友好):喂 chunk 字符串,产出 data: 行的 JSON 对象。
function createSseJsonDecoder(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += String(chunk == null ? '' : chunk);
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line.slice(5));
        } catch (_error) {
          continue; // 非 JSON data 行忽略
        }
        if (parsed && typeof parsed === 'object') onEvent(parsed);
      }
    }
  };
}

function createOpenCodeServeClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const httpImpl = options.httpImpl || http;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;

  function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = httpImpl.request(`${baseUrl}${pathname}`, {
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {}
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          const status = Number(res.statusCode) || 0;
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_error) { json = null; }
          if (status < 200 || status >= 300) {
            const error = new Error(`opencode serve ${method} ${pathname} → HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ''}`);
            error.code = 'opencode_serve_http_error';
            error.status = status;
            reject(error);
            return;
          }
          resolve({ status, json, text });
        });
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`opencode serve ${method} ${pathname} 超时(${timeoutMs}ms)`));
      });
      req.on('error', (error) => {
        if (!error.code) error.code = 'opencode_serve_request_failed';
        reject(error);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // directory 作用域后缀:所有会话/权限/事件调用都必须带(见文件头)。
  function directoryQuery(directory) {
    const text = String(directory || '').trim();
    return text ? `?directory=${encodeURIComponent(text)}` : '';
  }

  return {
    baseUrl,

    async health() {
      const { json } = await request('GET', '/global/health');
      return json && json.healthy === true ? json : null;
    },

    // directory 只能走 query param(body.directory 实证无效)。
    async createSession({ directory } = {}) {
      const { json } = await request('POST', `/session${directoryQuery(directory)}`, {});
      return json;
    },

    // 会话元数据(resume 时反查 directory 用;GET /session/:id 不依赖作用域即可命中)。
    async getSession(sessionId, { directory } = {}) {
      const { json } = await request('GET', `/session/${encodeURIComponent(sessionId)}${directoryQuery(directory)}`);
      return json;
    },

    // 会话级权限规则注入:PATCH 全量覆盖该会话的 permission 规则集(实证回显)。
    async updateSessionPermissions(sessionId, rules, { directory } = {}) {
      const { json } = await request('PATCH', `/session/${encodeURIComponent(sessionId)}${directoryQuery(directory)}`, {
        permission: Array.isArray(rules) ? rules : []
      });
      return json;
    },

    // 立即返回(204);进展/完成经 /event SSE。model 为 null 时用会话/全局默认。
    async promptAsync(sessionId, { model, text, directory } = {}) {
      const body = { parts: [{ type: 'text', text: String(text || '') }] };
      if (model && model.providerID && model.modelID) body.model = model;
      await request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async${directoryQuery(directory)}`, body);
      return true;
    },

    async listPermissions({ directory } = {}) {
      const { json } = await request('GET', `/permission${directoryQuery(directory)}`);
      return Array.isArray(json) ? json : [];
    },

    // reply: 'once'(允许本次)|'always'|'reject';message 在 reject 时作为反馈转给模型。
    async replyPermission(permissionId, reply, message, { directory } = {}) {
      const body = { reply: String(reply || 'reject') };
      if (String(message || '').trim()) body.message = String(message).trim();
      await request('POST', `/permission/${encodeURIComponent(permissionId)}/reply${directoryQuery(directory)}`, body);
      return true;
    },

    async abortSession(sessionId, { directory } = {}) {
      await request('POST', `/session/${encodeURIComponent(sessionId)}/abort${directoryQuery(directory)}`, {});
      return true;
    },

    // SSE 事件流(directory 作用域)。onEvent 收已解析的 JSON 事件对象;断流(close/error)回调 onClose。
    openEventStream({ directory, onEvent, onClose } = {}) {
      let closed = false;
      const finish = (error) => {
        if (closed) return;
        closed = true;
        if (typeof onClose === 'function') onClose(error || null);
      };
      const req = httpImpl.get(`${baseUrl}/event${directoryQuery(directory)}`, (res) => {
        if (Number(res.statusCode) !== 200) {
          const error = new Error(`opencode serve GET /event → HTTP ${res.statusCode}`);
          error.code = 'opencode_serve_event_stream_failed';
          res.resume();
          finish(error);
          return;
        }
        res.setEncoding('utf8');
        const decode = createSseJsonDecoder((event) => {
          if (!closed && typeof onEvent === 'function') onEvent(event);
        });
        res.on('data', decode);
        res.on('end', () => finish(null));
        res.on('error', (error) => finish(error));
      });
      req.on('error', (error) => finish(error));
      return {
        close() {
          if (closed) return;
          closed = true;
          try { req.destroy(); } catch (_error) { /* 已断开 */ }
        },
        get closed() {
          return closed;
        }
      };
    }
  };
}

module.exports = {
  createOpenCodeServeClient,
  createSseJsonDecoder,
  parseOpenCodeModelRef
};
