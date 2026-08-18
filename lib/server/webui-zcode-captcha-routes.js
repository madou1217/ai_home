'use strict';

// zcode 验证码桥（lib/server/zcode-captcha-bridge.js）的 WebUI 数据面：
// WebUI 的 ZcodeCaptchaBridge 组件经这三个端点恢复/喂回一次性 verify param。
// 鉴权由 server.js 的 /v0/webui/* Management Key 门统一覆盖，这里不再重复。

const PENDING_PATH = '/v0/webui/zcode-captcha/pending';
const CHALLENGE_PATH_PREFIX = '/v0/webui/zcode-captcha/';

function resolveBridge(ctx = {}) {
  const bridge = ctx.deps && ctx.deps.zcodeCaptchaBridge;
  return bridge && typeof bridge.listPending === 'function' ? bridge : null;
}

async function handleWebUiZcodeCaptchaRoutes(ctx) {
  const { method, pathname, req, res, writeJson, readRequestBody } = ctx;
  const json = writeJson || (ctx.deps && ctx.deps.writeJson);
  const bridge = resolveBridge(ctx);
  if (!bridge) {
    if (pathname === PENDING_PATH || pathname.startsWith(CHALLENGE_PATH_PREFIX)) {
      json(res, 503, { ok: false, error: 'zcode_captcha_bridge_unavailable' });
      return true;
    }
    return false;
  }

  if (method === 'GET' && pathname === PENDING_PATH) {
    json(res, 200, { ok: true, challenges: bridge.listPending() });
    return true;
  }

  if (method === 'POST' && pathname.startsWith(CHALLENGE_PATH_PREFIX)) {
    const rest = pathname.slice(CHALLENGE_PATH_PREFIX.length);
    const actionIndex = rest.lastIndexOf('/');
    if (actionIndex <= 0) return false;
    const id = rest.slice(0, actionIndex);
    const action = rest.slice(actionIndex + 1);
    if (action === 'complete') {
      const body = await readRequestBody(req, { maxBytes: 1024 * 1024 }).catch(() => null);
      let payload = {};
      try {
        payload = body ? JSON.parse(body.toString('utf8')) : {};
      } catch (_error) {
        json(res, 400, { ok: false, error: 'invalid_json' });
        return true;
      }
      const result = bridge.complete(id, {
        verifyParam: payload && payload.verifyParam,
        region: payload && payload.region
      });
      if (!result.ok) {
        const statusCode = result.reason === 'missing_verify_param' ? 400 : 404;
        json(res, statusCode, { ok: false, error: result.reason });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }
    if (action === 'dismiss') {
      const result = bridge.dismiss(id);
      if (!result.ok) {
        json(res, 404, { ok: false, error: result.reason });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return false;
}

module.exports = {
  handleWebUiZcodeCaptchaRoutes
};
