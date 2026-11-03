'use strict';

// WebUI 数据面：会话框「大段粘贴自动转文本附件」的阈值。
//
// 唯一持久化位置是 server config 的 `largePasteChars`（`aih server config set
// --large-paste-chars <n>` 写的是同一个键），WebUI 设置页与 CLI 改的是同一份配置；
// 默认值 / 下限 / 上限取自 contracts/chat-attachments.json，前后端同源。

const {
  PASTE_LIMITS,
  normalizeLargePasteChars,
  readServerConfig,
  resolveLargePasteChars,
  writeServerConfig
} = require('./server-config-store');
const { readRequestBody } = require('./http-utils');

const ROUTE = '/v0/webui/chat/paste-settings';

function matchChatPasteRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return pathname === ROUTE && (verb === 'GET' || verb === 'POST');
}

function present(config) {
  return {
    ok: true,
    largePasteChars: resolveLargePasteChars(config),
    custom: normalizeLargePasteChars(config.largePasteChars) > 0,
    limits: { ...PASTE_LIMITS }
  };
}

async function handleChatPasteRequest(ctx) {
  const deps = { fs: ctx.fs, aiHomeDir: ctx.aiHomeDir || (ctx.state && ctx.state.aiHomeDir) };
  if (String(ctx.req.method || '').toUpperCase() === 'GET') {
    ctx.writeJson(ctx.res, 200, present(readServerConfig(deps)));
    return true;
  }
  let body = null;
  try {
    const buffer = await readRequestBody(ctx.req, { maxBytes: 4 * 1024 });
    body = buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
  } catch (_error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json' });
    return true;
  }
  // null / 0 = 恢复默认；其余必须是 [min, max] 内的整数，越界明确拒绝而不是静默夹紧。
  const raw = body && body.largePasteChars;
  const reset = raw === null || raw === 0;
  const value = Number(raw);
  if (!reset && (!Number.isInteger(value) || value < PASTE_LIMITS.min || value > PASTE_LIMITS.max)) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_large_paste_chars',
      message: `粘贴阈值只接受 ${PASTE_LIMITS.min}..${PASTE_LIMITS.max} 的整数`,
      limits: { ...PASTE_LIMITS }
    });
    return true;
  }
  // 只写这一个键：writeServerConfig 在事务内与当前存储合并，不会把其它设置（含密钥）写回旧值。
  const next = writeServerConfig({ largePasteChars: reset ? 0 : value }, deps);
  ctx.writeJson(ctx.res, 200, present(next));
  return true;
}

module.exports = {
  handleChatPasteRequest,
  matchChatPasteRoute
};
