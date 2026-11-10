'use strict';

// WebUI 管理面的统一 Go 代理。
//
// 每个路由都重复过同一段样板：取 goHost、判方法存在、try/catch、成功透传 data、
// 400/404/409 原样回、其余 503。这里收敛成一处，路由只声明「调哪个方法、传什么参数、
// 成功时怎么变换」。新增能力不再复制错误处理。

const DEFAULT_PASS_STATUSES = Object.freeze([400, 404, 409]);

function resolveGoHost(ctx) {
  return ctx && ctx.deps && ctx.deps.goCoreSync;
}

/**
 * 调用 goHost 上的一个方法；宿主缺失/抛错都归一成 { response:null }，
 * 调用方不需要区分「没接线」与「调用炸了」。
 */
async function callGoHost(ctx, method, args = []) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost[method] !== 'function') {
    return { available: false, response: null };
  }
  try {
    return { available: true, response: await goHost[method](...args) };
  } catch (_error) {
    return { available: true, response: null };
  }
}

/**
 * 把 Go 失败写成浏览器响应。
 *
 * passStatuses 内的状态与 data 原样透传；其余统一 503（或调用方指定的 fallback）。
 * 返回 true 便于路由直接返回该调用。
 */
function writeGoFailure(ctx, response, options = {}) {
  const passStatuses = Array.isArray(options.passStatuses) ? options.passStatuses : DEFAULT_PASS_STATUSES;
  const status = Number(response && response.status) || 0;
  if (passStatuses.includes(status) && response && response.data) {
    ctx.writeJson(ctx.res, status, response.data);
    return true;
  }
  const fallbackStatus = Number(options.fallbackStatus) || 503;
  ctx.writeJson(ctx.res, fallbackStatus, {
    ok: false,
    error: String(
      (response && response.data && response.data.error)
      || (response && response.errorCode)
      || options.fallbackCode
      || 'go_core_unavailable'
    ),
    message: String(options.message || options.fallbackMessage || '')
  });
  return true;
}

/**
 * 通用代理：成功时默认原样返回 data，可用 transform(data, response) 改写。
 * 恒返回 true，路由可直接 return proxyGo(...)。
 */
async function proxyGo(ctx, options = {}) {
  const method = String(options.method || '').trim();
  if (!method) throw new Error('proxyGo requires method');
  const message = String(options.message || 'Go Core 未就绪').trim();
  const { available, response } = await callGoHost(ctx, method, options.args || []);
  if (!available) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message });
    return true;
  }
  if (response && response.ok === true && response.data) {
    const payload = typeof options.transform === 'function'
      ? options.transform(response.data, response)
      : response.data;
    ctx.writeJson(ctx.res, Number(options.status) || 200, payload);
    return true;
  }
  return writeGoFailure(ctx, response, {
    message,
    passStatuses: options.passStatuses,
    fallbackStatus: options.fallbackStatus,
    fallbackCode: options.fallbackCode
  });
}

module.exports = {
  DEFAULT_PASS_STATUSES,
  callGoHost,
  proxyGo,
  resolveGoHost,
  writeGoFailure
};
