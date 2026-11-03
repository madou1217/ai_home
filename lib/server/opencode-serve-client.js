'use strict';

// 本地 `opencode serve` HTTP API 的最小客户端(P3c:confirm 审批模式)。
// ⚠️ 与 opencode-server-client.js(Zen 云端客户端)无关——这里只打 localhost serve 实例。
//
// 两代 API 的形状差异全部声明在 opencode-serve-api-layouts.js（布局表），本文件只做
// 「按布局组请求」的适配：路由模板、鉴权(Basic 密码从 serve 日志读)、`{data}` 信封、
// directory 作用域传递方式、prompt 体形状、模型传递方式、权限规则/回执字段名。
//
// v1 端点契约(1.4.7 与 1.17.13 真机实证,2026-07-04):
//   GET  /global/health                      → {healthy:true,version}
//   POST /session?directory=<abs>            → {id:"ses_*",directory,projectID,...}(directory 只认 query,body 无效)
//   PATCH /session/:id {permission:[...]}    → 会话级权限规则注入(confirm 模式按会话注入 ask,不碰全局配置)
//   POST /session/:id/prompt_async           → 204 立即返回,进展走 /event
//   POST /session/:id/abort                  → 200
//   GET  /permission                         → 挂起权限请求列表
//   POST /permission/:id/reply {reply,message} → "once"|"always"|"reject"
//   GET  /event                              → SSE 事件流(message.part.delta/permission.asked/session.idle 等,均带 sessionID)
//
// ⚠️ v1 directory 作用域(1.17.13 实证):serve 内部按 directory 分 app 实例,/event、/permission、
// /permission/:id/reply 等都只作用于「请求携带的 ?directory=」对应实例(缺省=serve 进程 cwd)。
// 1.4.7 无此语义、多余的 ?directory 参数无害。因此 v1 所有调用一律带上会话的 directory,
// 否则(踩过的坑)事件流空转、权限列表恒空、tool 永远挂在 running。
//
// v2 端点契约(opencode 2.0.29 真机实证,2026-10-16):
//   GET  /api/info                                        → {version,pid,urls}（Basic 鉴权）
//   POST /api/session {location:{directory},model}        → {data:Session.Info}
//   GET  /api/session/:id                                 → {data:Session.Info}（location.directory）
//   PATCH /api/session/:id {permissions:[{action,resource,effect}]} → 204
//   POST /api/session/:id/model {model:{id,providerID}}   → 会话级切模型
//   POST /api/session/:id/prompt {text}                   → {data:Inbox.Item}(delivery=steer,进展走 /api/event)
//   POST /api/session/:id/interrupt                       → {interrupted:bool}
//   GET  /api/session/:id/permission                      → {data:[Permission.Request]}
//   POST /api/session/:id/permission/:rid/reply {decision}→ 204
//   GET  /api/event                                       → SSE 事件流(全局,**不**按 directory 分实例,按 sessionID 过滤)

const http = require('node:http');

const {
  LAYOUTS,
  serveApiLayout,
  serveApiRoute,
  parseServePassword
} = require('./opencode-serve-api-layouts');

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
// 未注入布局时的回退：v1（旧调用方/旧测试的既有行为）。
const DEFAULT_LAYOUT_ID = 'v1';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^http:\/\//.test(text)) {
    const error = new Error(`opencode serve baseUrl 非法: ${text || '(空)'}`);
    error.code = 'opencode_serve_invalid_base_url';
    throw error;
  }
  return text;
}

// "opencode-go/glm-5.2" → {providerID,modelID}。无 "/" 或残缺 → null(prompt 不带 model,用会话默认)。
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
  const readLogTail = typeof options.readLogTail === 'function' ? options.readLogTail : null;

  // activeLayout 判定前为 null（一律按 v1 组请求，保持旧调用方行为）；health() 命中时落定。
  let activeLayout = serveApiLayout(options.layout) || null;
  let password = normalizeString(options.password);

  const resolveLayout = () => activeLayout || serveApiLayout(DEFAULT_LAYOUT_ID);

  function authHeaders(layout, passwordOverride) {
    const secret = passwordOverride == null ? password : passwordOverride;
    if (!layout || layout.auth !== 'basic' || !secret) return {};
    return {
      authorization: `Basic ${Buffer.from(`${layout.authUser || 'opencode'}:${secret}`).toString('base64')}`
    };
  }

  function rawRequest(method, pathname, body, { layout, passwordOverride } = {}) {
    const useLayout = layout || resolveLayout();
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = authHeaders(useLayout, passwordOverride);
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = payload.length;
      }
      const req = httpImpl.request(`${baseUrl}${pathname}`, { method, headers }, (res) => {
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

  const request = (method, pathname, body) => rawRequest(method, pathname, body, {});

  function unwrapEnvelope(layout, json) {
    if (layout && layout.envelope === 'data' && json && typeof json === 'object' && !Array.isArray(json) && 'data' in json) {
      return json.data;
    }
    return json;
  }

  // v2 的会话对象把目录放在 location.directory；统一补一个 directory 字段，调用方（runner）
  // 反查作用域的逻辑两代同构。
  function normalizeSession(session) {
    if (!session || typeof session !== 'object') return session;
    if (normalizeString(session.directory)) return session;
    const directory = session.location && typeof session.location === 'object'
      ? normalizeString(session.location.directory)
      : '';
    return directory ? { ...session, directory } : session;
  }

  // directory 作用域后缀：只有 query 型布局（v1）需要（见文件头）。
  function scopeQuery(layout, directory) {
    if (!layout.scope || layout.scope.kind !== 'query') return '';
    const text = normalizeString(directory);
    return text ? `?${layout.scope.param}=${encodeURIComponent(text)}` : '';
  }

  // 模型引用形状（v1 {providerID, modelID} / v2 {id, providerID}）由布局表声明。
  function modelRefFor(layout, model) {
    if (!model || !model.providerID || !model.modelID) return null;
    const keys = layout.requests && layout.requests.modelRef ? layout.requests.modelRef : { id: 'modelID', provider: 'providerID' };
    return { [keys.provider]: model.providerID, [keys.id]: model.modelID };
  }

  // 规范权限规则 [{action,resource,effect}] → 各代字段名（v1 是 {permission,pattern,action}）。
  function permissionRulesFor(layout, rules) {
    const descriptor = layout.requests && layout.requests.permissionRules;
    if (!descriptor) return Array.isArray(rules) ? rules : [];
    const keyMap = descriptor.keyMap || {};
    return (Array.isArray(rules) ? rules : []).map((rule) => {
      const out = {};
      for (const canonical of Object.keys(keyMap)) out[keyMap[canonical]] = rule && rule[canonical];
      return out;
    });
  }

  async function probeLayout(layout, passwordOverride) {
    const route = serveApiRoute(layout, 'health');
    const healthOk = layout.probe && typeof layout.probe.healthOk === 'function' ? layout.probe.healthOk : null;
    if (!route || !healthOk) return null;
    try {
      const { json } = await rawRequest('GET', route, null, { layout, passwordOverride });
      if (!healthOk(json)) return null;
      const versionField = layout.probe.versionField;
      const version = json && versionField ? normalizeString(json[versionField]) : '';
      return { ...(json && typeof json === 'object' ? json : {}), healthy: true, layout: layout.id, version };
    } catch (_error) {
      return null; // 该布局不匹配（404/401/HTML 正文等），继续试下一个
    }
  }

  return {
    baseUrl,

    // 尚未判定布局时按布局表逐代探测（v1 → v2）：命中即落定并记住密码（v2 Basic）。
    async health() {
      if (activeLayout) return probeLayout(activeLayout, null);
      const logTail = readLogTail ? readLogTail() : '';
      const logPassword = parseServePassword(logTail);
      for (const layout of LAYOUTS) {
        const layoutPassword = layout.auth === 'basic' ? (password || logPassword) : '';
        const result = await probeLayout(layout, layoutPassword);
        if (result) {
          activeLayout = layout;
          if (layoutPassword) password = layoutPassword;
          return result;
        }
      }
      return null;
    },

    get layout() {
      return activeLayout;
    },

    get password() {
      return password;
    },

    // v1: directory 只能走 query param(body.directory 实证无效)。
    // v2: directory 走 create body 的 location.directory。
    async createSession({ directory, model } = {}) {
      const layout = resolveLayout();
      const route = serveApiRoute(layout, 'createSession');
      const body = {};
      const dir = normalizeString(directory);
      // v1 不接受 body.directory（实证无效），走 query；v2 只有 create 需要显式 location。
      if (dir && layout.scope && layout.scope.kind === 'create-location') body.location = { directory: dir };
      if (layout.requests && layout.requests.modelOnCreate && model) {
        const ref = modelRefFor(layout, model);
        if (ref) body.model = ref;
      }
      const { json } = await rawRequest('POST', `${route}${scopeQuery(layout, dir)}`, body);
      return normalizeSession(unwrapEnvelope(layout, json));
    },

    // 会话元数据(resume 时反查 directory 用)。
    async getSession(sessionId, { directory } = {}) {
      const layout = resolveLayout();
      const route = serveApiRoute(layout, 'session', { sessionId });
      const { json } = await rawRequest('GET', `${route}${scopeQuery(layout, directory)}`);
      return normalizeSession(unwrapEnvelope(layout, json));
    },

    // 会话级权限规则注入:PATCH 全量覆盖该会话的权限规则集(两代回显/204 实证)。
    // rules 用规范形状 [{action,resource,effect}]，字段名按布局表映射。
    async updateSessionPermissions(sessionId, rules, { directory } = {}) {
      const layout = resolveLayout();
      const descriptor = layout.requests && layout.requests.permissionRules ? layout.requests.permissionRules : {};
      const route = serveApiRoute(layout, 'session', { sessionId });
      const body = { [descriptor.bodyKey || 'permission']: permissionRulesFor(layout, rules) };
      const { json } = await rawRequest('PATCH', `${route}${scopeQuery(layout, directory)}`, body);
      return unwrapEnvelope(layout, json);
    },

    // 立即返回(v1 204 / v2 {data:Inbox})；进展/完成经事件流 SSE。
    // v2 模型不在 prompt 体里:先切会话模型再发 prompt。model 为 null 时用会话/全局默认。
    async promptAsync(sessionId, { model, text, directory } = {}) {
      const layout = resolveLayout();
      const requests = layout.requests || {};
      const dir = normalizeString(directory);
      if (model && !requests.modelOnPrompt && requests.modelRoute) {
        const ref = modelRefFor(layout, model);
        if (ref) {
          const modelRoute = serveApiRoute(layout, requests.modelRoute, { sessionId });
          await rawRequest('POST', `${modelRoute}${scopeQuery(layout, dir)}`, { model: ref });
        }
      }
      const body = {};
      if (requests.prompt && requests.prompt.textShape === 'text') {
        body.text = String(text || '');
      } else {
        body.parts = [{ type: 'text', text: String(text || '') }];
        if (model) {
          const ref = modelRefFor(layout, model);
          if (ref) body.model = ref;
        }
      }
      const route = serveApiRoute(layout, 'prompt', { sessionId });
      await rawRequest('POST', `${route}${scopeQuery(layout, dir)}`, body);
      return true;
    },

    async listPermissions({ sessionId, directory } = {}) {
      const layout = resolveLayout();
      const route = serveApiRoute(layout, 'permissionList', { sessionId });
      if (!route) return [];
      const { json } = await rawRequest('GET', `${route}${scopeQuery(layout, directory)}`);
      const unwrapped = unwrapEnvelope(layout, json);
      return Array.isArray(unwrapped) ? unwrapped : [];
    },

    // reply: 'once'(允许本次)|'always'|'reject';message 在 reject 时作为反馈转给模型。
    // v1 路由不含 sessionID；v2 是会话级路由（必须给 sessionId）。
    async replyPermission(permissionId, reply, message, { sessionId, directory } = {}) {
      const layout = resolveLayout();
      const bodyKey = layout.requests && layout.requests.permissionReply
        ? layout.requests.permissionReply.bodyKey
        : 'reply';
      const body = { [bodyKey]: String(reply || 'reject') };
      if (normalizeString(message)) body.message = String(message).trim();
      const route = serveApiRoute(layout, 'permissionReply', { sessionId, requestId: permissionId });
      await rawRequest('POST', `${route}${scopeQuery(layout, directory)}`, body);
      return true;
    },

    async abortSession(sessionId, { directory } = {}) {
      const layout = resolveLayout();
      const route = serveApiRoute(layout, 'abort', { sessionId });
      const withBody = layout.requests ? layout.requests.abortBody !== false : true;
      await rawRequest('POST', `${route}${scopeQuery(layout, directory)}`, withBody ? {} : null);
      return true;
    },

    // SSE 事件流（v1 按 directory 作用域；v2 全局流，调用方按 sessionID 过滤）。
    // onEvent 收已解析的 JSON 事件对象;断流(close/error)回调 onClose。
    openEventStream({ directory, onEvent, onClose } = {}) {
      const layout = resolveLayout();
      let closed = false;
      const finish = (error) => {
        if (closed) return;
        closed = true;
        if (typeof onClose === 'function') onClose(error || null);
      };
      const url = `${baseUrl}${serveApiRoute(layout, 'eventStream')}${scopeQuery(layout, directory)}`;
      const headers = { accept: 'text/event-stream', ...authHeaders(layout, null) };
      const req = httpImpl.request(url, { method: 'GET', headers }, (res) => {
        if (Number(res.statusCode) !== 200) {
          const error = new Error(`opencode serve GET ${serveApiRoute(layout, 'eventStream')} → HTTP ${res.statusCode}`);
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
      req.end();
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
