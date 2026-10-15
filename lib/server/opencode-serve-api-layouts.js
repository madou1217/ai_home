'use strict';

// opencode serve API 布局表（OpenCode API Layout Table）。
//
// `opencode serve` 存在两代 API，**布局完全不同**，差异是数据不是 if/else：
//   v1（≤1.x）：无前缀、无鉴权、事件体 `{type, properties}`、裸 JSON 响应
//   v2（≥2.0）：`/api/*` 前缀 + HTTP Basic（用户 opencode，密码启动时打印在日志里）、
//               事件体 `{id, type, data}`、响应统一 `{data: …}` 信封、prompt 体用 `text`
//
// 本表是唯一事实来源：路由模板、鉴权、信封形状、是否已实现（`adapter`）。新增一代 =
// 加一行 + 写一个 adapter，派发代码不动；已识别但未实现的布局会**立即**给出明确原因，
// 而不是让就绪探测空转到超时（2026-10-15 实测：v2 下旧的 25s「就绪超时」完全指不到病因）。

const LAYOUTS = Object.freeze([
  Object.freeze({
    id: 'v1',
    supported: true,
    auth: 'none',
    envelope: 'bare',
    eventShape: 'properties',
    routes: Object.freeze({
      health: '/global/health',
      session: '/session/:sessionId',
      createSession: '/session',
      prompt: '/session/:sessionId/prompt_async',
      permissionReply: '/permission/:requestId/reply',
      sessionPermissions: '/session/:sessionId/permissions',
      eventStream: '/event'
    })
  }),
  Object.freeze({
    id: 'v2',
    supported: false,
    unsupportedReason: 'opencode_serve_api_layout_v2_not_implemented',
    auth: 'basic',
    authUser: 'opencode',
    envelope: 'data',
    eventShape: 'data',
    routes: Object.freeze({
      health: '/api/info',
      session: '/api/session/:sessionId',
      createSession: '/api/session',
      prompt: '/api/session/:sessionId/prompt',
      permissionReply: '/api/session/:sessionId/permission/:requestId/reply',
      permissionList: '/api/session/:sessionId/permission',
      eventStream: '/api/event'
    }),
    // 实测（opencode 2.0.29）：prompt 体 = {model:{providerID,modelID}, text}（不是 v1 的 parts[]）；
    // 事件流 `GET /api/event` 首帧 `{id, type:'server.connected', data:{}}`；
    // `/api/info` 返回 {version, pid, urls, capabilities} —— 就绪探测用它。
    probe: Object.freeze({ passwordPattern: /server password (\S+)/, versionField: 'version' })
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

/**
 * 探测「已识别但未实现」的 serve 布局：拿日志里的密码打候选布局的健康端点。
 * 命中返回 { layout, version }；无法判定返回 null（调用方按原路径报错）。
 */
async function detectUnsupportedServeApiLayout(input = {}) {
  const baseUrl = String(input.baseUrl || '').trim();
  if (!baseUrl) return null;
  const password = parseServePassword(input.logTail);
  if (!password) return null;
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  for (const layout of LAYOUTS) {
    if (layout.supported) continue;
    const url = `${baseUrl}${serveApiRoute(layout, 'health')}`;
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`${layout.authUser}:${password}`).toString('base64')}`
        },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 2000)
          : undefined
      });
      if (!response.ok) continue;
      const body = await response.json().catch(() => null);
      const version = body && typeof body === 'object'
        ? String(body[layout.probe && layout.probe.versionField || 'version'] || '')
        : '';
      return { layout, version };
    } catch (_error) { /* 该布局不匹配，继续试下一个 */ }
  }
  return null;
}

module.exports = {
  LAYOUTS,
  detectUnsupportedServeApiLayout,
  parseServePassword,
  serveApiLayout,
  serveApiRoute,
  supportedServeApiLayouts
};
