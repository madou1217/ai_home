'use strict';

// opencode serve API 布局表（OpenCode API Layout Table）。
//
// `opencode serve` 存在两代 API，**布局完全不同**，差异是数据不是 if/else：
//   v1（≤1.x）：无前缀、无鉴权、事件体 `{type, properties}`、裸 JSON 响应、
//               directory 走 `?directory=`、prompt 体用 `parts[]`、模型随 prompt 传
//   v2（≥2.0）：`/api/*` 前缀 + HTTP Basic（用户 opencode，密码启动时打印在日志里）、
//               事件体 `{id, type, data}`（新事件词汇：session.text.*/session.tool.*/
//               session.execution.*/permission.asked）、响应统一 `{data: …}` 信封、
//               directory 在 create body 的 `location.directory`（会话级路由自带上文）、
//               prompt 体用 `text`、模型走会话级 `POST /api/session/:id/model`、
//               事件流 `GET /api/event` 是**全局**的（不按 directory 分实例，按 sessionID 过滤）
//
// 本表是唯一事实来源：路由模板、鉴权、信封形状、作用域传递、请求体形状、就绪探测谓词。
// 新增一代 = 加一行 + 事件映射器（eventShape 对应的 adapter），派发代码不动；已识别但
// 未实现的布局会**立即**给出明确原因，而不是让就绪探测空转到超时
// （2026-10-15 实测：v2 下旧的 25s「就绪超时」完全指不到病因；2026-10-16 实测补全 v2 接入）。
//
// 就绪探测（probe.healthOk）必须能区分「本布局」与「别的布局」：v2 的 `/global/health`
// 会落到 Web UI 返回 200 HTML —— 只看状态码会把 v2 误判成 v1。

function objectFreeze(value) {
  return Object.freeze(value);
}

const LAYOUTS = Object.freeze([
  objectFreeze({
    id: 'v1',
    supported: true,
    auth: 'none',
    envelope: 'bare',
    eventShape: 'properties',
    routes: objectFreeze({
      health: '/global/health',
      session: '/session/:sessionId',
      createSession: '/session',
      prompt: '/session/:sessionId/prompt_async',
      permissionReply: '/permission/:requestId/reply',
      permissionList: '/permission',
      eventStream: '/event',
      abort: '/session/:sessionId/abort'
    }),
    // directory 作用域：每个请求都带 ?directory=<abs>（1.17.13 起 serve 按 directory 分实例）。
    scope: objectFreeze({ kind: 'query', param: 'directory' }),
    requests: objectFreeze({
      prompt: objectFreeze({ textShape: 'parts' }),
      modelOnPrompt: true,
      modelOnCreate: false,
      modelRef: objectFreeze({ id: 'modelID', provider: 'providerID' }),
      permissionRules: objectFreeze({
        bodyKey: 'permission',
        keyMap: objectFreeze({ action: 'permission', resource: 'pattern', effect: 'action' })
      }),
      permissionReply: objectFreeze({ bodyKey: 'reply' }),
      abortBody: true
    }),
    probe: objectFreeze({
      healthOk: (body) => Boolean(body && typeof body === 'object' && body.healthy === true),
      versionField: 'version'
    })
  }),
  objectFreeze({
    id: 'v2',
    supported: true,
    auth: 'basic',
    authUser: 'opencode',
    envelope: 'data',
    eventShape: 'data',
    routes: objectFreeze({
      health: '/api/info',
      session: '/api/session/:sessionId',
      createSession: '/api/session',
      prompt: '/api/session/:sessionId/prompt',
      model: '/api/session/:sessionId/model',
      permissionReply: '/api/session/:sessionId/permission/:requestId/reply',
      permissionList: '/api/session/:sessionId/permission',
      eventStream: '/api/event',
      abort: '/api/session/:sessionId/interrupt'
    }),
    // directory 作用域：会话路由按 sessionId 自带 location；只有 create 需要显式 location.directory。
    scope: objectFreeze({ kind: 'create-location' }),
    requests: objectFreeze({
      prompt: objectFreeze({ textShape: 'text' }),
      modelOnPrompt: false,
      modelOnCreate: true,
      modelRoute: 'model',
      modelRef: objectFreeze({ id: 'id', provider: 'providerID' }),
      permissionRules: objectFreeze({
        bodyKey: 'permissions',
        keyMap: objectFreeze({ action: 'action', resource: 'resource', effect: 'effect' })
      }),
      permissionReply: objectFreeze({ bodyKey: 'decision' }),
      abortBody: false
    }),
    // 真机实测（opencode 2.0.29）：`GET /api/info` → {version, pid, urls, paths, capabilities}
    // （需 Basic 鉴权；旧探测路径 /global/health 在这里返回 Web UI HTML）。判据必须与 v1 的
    // {healthy,version} 互斥——v1 响应也带 version，只用 version 形状会让 v1 同时命中 v2。
    probe: objectFreeze({
      healthOk: (body) => Boolean(
        body
        && typeof body === 'object'
        && typeof body.version === 'string'
        && typeof body.pid === 'number'
      ),
      versionField: 'version'
    })
  })
]);

const LAYOUT_BY_ID = new Map(LAYOUTS.map((layout) => [layout.id, layout]));

function serveApiLayout(id) {
  return LAYOUT_BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

function supportedServeApiLayouts() {
  return LAYOUTS.filter((layout) => layout.supported).map((layout) => layout.id);
}

/** 路由模板填充：`/session/:sessionId/prompt` + {sessionId:'ses_x'} → 实际路径。 */
function serveApiRoute(layout, name, params = {}) {
  const template = layout && layout.routes && layout.routes[name];
  if (!template) return '';
  return template.replace(/:([A-Za-z]+)/g, (_match, key) => encodeURIComponent(String(params[key] || '')));
}

function parseServePassword(logTail) {
  // 日志是追加写的：同一账号多次启动会有多行 password，只有**最后一行**属于当前进程。
  const matches = [...String(logTail || '').matchAll(/server password (\S+)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : '';
}

module.exports = {
  LAYOUTS,
  parseServePassword,
  serveApiLayout,
  serveApiRoute,
  supportedServeApiLayouts
};
