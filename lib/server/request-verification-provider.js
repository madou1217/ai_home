'use strict';

// start-plan 套餐的**请求验证参数提供者**。
//
// 为什么需要（逆向 ZCode Desktop 3.16.3，chunk-5YNPFY3L.js @614954）：
//   function requiresRequestVerification(access, captcha) {
//     return access?.mode === 'start-plan'
//       && captcha?.enabled !== false
//       && captcha?.skipModelRequest !== true;
//   }
//   function requestVerificationClaimHeaders(t) {
//     return { 'X-Aliyun-Captcha-Verify-Param': t.captchaVerifyParam,
//              ...(t.captchaRegion ? { 'X-Aliyun-Captcha-Verify-Region': t.captchaRegion } : {}) };
//   }
// 即：**start-plan 的模型请求必须带阿里云无痕验证参数**，否则上游返回
// 405 `{"code":3012,"msg":"request has been blocked due to unusual activity."}`。
// 那个 3012 不是风控封禁，是「缺验证参数」。
//
// 与「领臭鸡蛋」共用同一个解算器（lib/account/activity-claim/aliyun-captcha.js，
// 真机 successCount>0），差别只在这里是给推理请求供参数。
//
// **为什么必须缓存**：解算要 spawn 一个 Chrome（CDP 驱动，秒级开销），
// 放在 relay 热路径上会让每个请求都慢数秒且并发拉起多个浏览器。
// 因此：命中缓存直接用；未命中时按需解算一次并缓存；解算失败不阻断主流程
// （照常发请求，让上游按它自己的判断拒绝）。
//
// 本模块只负责「拿到可用的验证参数」，不认识 provider 名 —— 谁需要由描述符声明
// （capabilities.relay.auth.requestVerification），由调用方按能力倒排决定。

const nodeFs = require('node:fs');

// 参数缓存：同一账号同一时刻只保留一份。解算昂贵，且并发解算会拉起多个浏览器。
// 单飞（inFlight）保证并发请求共用同一次解算。
const cachedByAccount = new Map();
const inFlightByAccount = new Map();

// 参数时效未知（上游未公开 TTL），采取保守策略：成功用一次后即失效，
// 下次重新解算。宁可贵一点，也不要用过期参数换来一个难定位的 3012。
const PARAM_TTL_MS = 5 * 60 * 1000;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 判断该账号是否需要请求验证参数。
 * 判定面是描述符声明的 planKinds 与账号 plan_id（事实），不是展示名。
 */
function needsRequestVerification(account, auth) {
  const planKinds = Array.isArray(auth && auth.requestVerification && auth.requestVerification.planKinds)
    ? auth.requestVerification.planKinds
    : [];
  if (planKinds.length === 0) return false;
  const planIds = Array.isArray(account && account.planIds) ? account.planIds : [];
  const haystack = planIds.map((id) => String(id || '').toLowerCase()).join(' ');
  if (!haystack) return false;
  return planKinds.some((kind) => {
    const needle = String(kind || '').trim().toLowerCase();
    return needle ? haystack.includes(needle) : false;
  });
}

/** 读缓存（未过期才返回）。 */
function readCachedVerification(accountRef, nowMs) {
  const entry = cachedByAccount.get(accountRef);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs) {
    cachedByAccount.delete(accountRef);
    return null;
  }
  return entry.value;
}

/**
 * 取得该账号的请求验证头（形如 { 'X-Aliyun-Captcha-Verify-Param': ..., 'X-Aliyun-Captcha-Verify-Region': ... }）。
 *
 * @returns {Promise<object>} 头对象；不需要验证或解算失败时返回 {}（不阻断主流程）。
 */
async function resolveRequestVerificationHeaders(account, auth, deps = {}) {
  if (!needsRequestVerification(account, auth)) return {};
  const accountRef = normalizeText(account && account.accountRef);
  if (!accountRef) return {};
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();

  const cached = readCachedVerification(accountRef, nowMs);
  if (cached) return cached;

  const running = inFlightByAccount.get(accountRef);
  if (running) return running;

  const promise = (async () => {
    try {
      const solve = typeof deps.solveCaptcha === 'function'
        ? deps.solveCaptcha
        : require('../account/activity-claim/aliyun-captcha').solveAliyunCaptcha;
      const config = await resolveCaptchaConfig(account, auth, deps);
      if (!config || config.enabled === false || config.skipModelRequest === true) return {};
      if (!config.sceneId || !config.prefix) return {};
      const param = await solve({
        sceneId: config.sceneId,
        prefix: config.prefix,
        region: config.region,
        executablePath: deps.captchaBrowser,
        fs: deps.fs || nodeFs,
        hostHomeDir: deps.hostHomeDir,
        timeoutMs: deps.timeoutMs
      });
      const value = normalizeText(param);
      if (!value) return {};
      const headers = { 'X-Aliyun-Captcha-Verify-Param': value };
      if (config.region) headers['X-Aliyun-Captcha-Verify-Region'] = config.region;
      cachedByAccount.set(accountRef, { value: headers, expiresAt: nowMs + PARAM_TTL_MS });
      return headers;
    } catch (_error) {
      // 解算失败不阻断：照常发请求，由上游判断。失败不缓存，下次重试。
      return {};
    } finally {
      inFlightByAccount.delete(accountRef);
    }
  })();
  inFlightByAccount.set(accountRef, promise);
  return promise;
}

/**
 * 读验证配置（sceneId / prefix / region / enabled / skipModelRequest）。
 * 来源是 client/configs 的 data.configs.captcha（与领臭鸡蛋同一处）。
 */
async function resolveCaptchaConfig(account, auth, deps = {}) {
  const request = deps.request;
  if (typeof request !== 'function') return null;
  const url = normalizeText(auth && auth.requestVerification && auth.requestVerification.configUrl);
  if (!url) return null;
  try {
    const response = await request(url, { method: 'GET', headers: { accept: 'application/json' } }, deps.timeoutMs);
    if (!response || response.ok === false) return null;
    const payload = await response.json().catch(() => null);
    const configs = payload && payload.data && payload.data.configs;
    const captcha = configs && typeof configs.captcha === 'object' ? configs.captcha : null;
    if (!captcha) return null;
    return {
      enabled: captcha.enabled !== false,
      prefix: normalizeText(captcha.prefix),
      region: normalizeText(captcha.region) || 'cn',
      sceneId: normalizeText(captcha.sceneId || captcha.scene_id),
      skipModelRequest: captcha.skip_model_request === true
    };
  } catch (_error) {
    return null;
  }
}

/** 清缓存（账号凭据变更 / 测试用）。 */
function resetRequestVerificationCache() {
  cachedByAccount.clear();
  inFlightByAccount.clear();
}

module.exports = {
  PARAM_TTL_MS,
  needsRequestVerification,
  resolveRequestVerificationHeaders,
  resetRequestVerificationCache
};
