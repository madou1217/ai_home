'use strict';

// zcode OAuth 计划账号推理端点（zcode.z.ai/api/v1/zcode-plan/anthropic）每请求强制
// 阿里云 Captcha 2.0 验证：缺 X-Aliyun-Captcha-Verify-Param 头时返回
// 400 {"code":3007,"msg":"captcha verify failed"}。网关本身没有浏览器，无法跑阿里
// Captcha SDK，因此这里把验证码挑战桥接到 WebUI：
//   1. 推理转发（upstream-endpoints.js）收到 3007 → requestVerification()；
//   2. 本模块经 accounts watch SSE 广播 zcode-captcha 事件（state: 'required'）；
//   3. WebUI 的 ZcodeCaptchaBridge 组件加载阿里 SDK、跑无感/弹窗验证，拿到一次性
//      verify param 后 POST /v0/webui/zcode-captcha/:id/complete；
//   4. complete() resolve 等待中的推理请求，后者带验证码头重发一次。
// verify param 一次性消费，不跨请求复用；每个 3007 都会创建新的挑战。
//
// 桌面端同款配置来源：GET ZCODE_CLIENT_CONFIGS_URL（lib/account/provider-api-base-url.js）
// → data.configs.captcha = { enabled, region, prefix, sceneId }，内存缓存 1 小时。

const crypto = require('node:crypto');
const { ZCODE_CLIENT_CONFIGS_URL } = require('../account/provider-api-base-url');

const CAPTCHA_CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
// 与桌面端实测请求一致的 query（app_version=3.7.7&platform=win32-x64）。
const CLIENT_CONFIGS_QUERY = 'app_version=3.7.7&platform=win32-x64';

function readCaptchaConfig(json) {
  const configs = json && typeof json === 'object' ? json.data && json.data.configs : null;
  const captcha = configs && typeof configs === 'object' ? configs.captcha : null;
  if (!captcha || typeof captcha !== 'object') return null;
  if (captcha.enabled === false) return null;
  const region = String(captcha.region || '').trim();
  const prefix = String(captcha.prefix || '').trim();
  const sceneId = String(captcha.sceneId || '').trim();
  if (!region || !prefix || !sceneId) return null;
  return { region, prefix, sceneId };
}

function toPublicChallenge(challenge) {
  return {
    id: challenge.id,
    accountRef: challenge.accountRef,
    sceneId: challenge.sceneId,
    region: challenge.region,
    prefix: challenge.prefix,
    language: challenge.language,
    createdAt: challenge.createdAt
  };
}

// 3007 = zcode 计划端点的「缺验证码」业务错误（HTTP 400 {"code":3007,
// "msg":"captcha verify failed"}）。它是请求级拦截而非账号失效，不能按普通
// 失败记账/熔断。
function isZcodeCaptchaRequiredErrorBody(text) {
  const raw = String(text || '');
  if (!raw) return false;
  try {
    const json = JSON.parse(raw);
    if (json && typeof json === 'object') {
      if (Number(json.code) === 3007) return true;
      if (String(json.msg || '').toLowerCase().includes('captcha verify failed')) return true;
    }
  } catch (_error) {
    // fall through to raw-text matching
  }
  return /"code"\s*:\s*3007/.test(raw) || /captcha verify failed/i.test(raw);
}

function createZcodeCaptchaBridge(deps = {}) {
  const fetchWithTimeoutImpl = deps.fetchWithTimeout;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const pendingByAccount = new Map();
  const pendingById = new Map();
  let configCache = null;
  let configInFlight = null;

  // GET client configs → data.configs.captcha，1h 内存缓存 + 并发单飞。
  // enabled===false 或缺 region/prefix/sceneId 视为不可用（返回 null，不缓存失败）。
  async function getCaptchaConfig() {
    if (configCache && now() < configCache.expiresAt) return configCache.value;
    if (configInFlight) return configInFlight;
    configInFlight = (async () => {
      if (typeof fetchWithTimeoutImpl !== 'function') return null;
      let res;
      try {
        res = await fetchWithTimeoutImpl(`${ZCODE_CLIENT_CONFIGS_URL}?${CLIENT_CONFIGS_QUERY}`, {
          method: 'GET',
          headers: { accept: 'application/json' }
        }, 8000, {
          proxyUrl: deps.proxyUrl,
          noProxy: deps.noProxy
        });
      } catch (_error) {
        return null;
      }
      if (!res || !res.ok) return null;
      const json = await res.json().catch(() => null);
      return readCaptchaConfig(json);
    })();
    try {
      const value = await configInFlight;
      if (value) {
        configCache = { value, expiresAt: now() + CAPTCHA_CONFIG_CACHE_TTL_MS };
      }
      return value;
    } finally {
      configInFlight = null;
    }
  }

  function emit(state, challenge) {
    if (!broadcast) return 0;
    return broadcast({
      type: 'zcode-captcha',
      state,
      challenge: challenge ? toPublicChallenge(challenge) : null
    });
  }

  function dropChallenge(challenge) {
    if (!challenge) return;
    pendingById.delete(challenge.id);
    if (pendingByAccount.get(challenge.accountRef) === challenge) {
      pendingByAccount.delete(challenge.accountRef);
    }
  }

  function settleChallenge(challenge, firstResult, restResult) {
    const waiters = challenge.waiters.splice(0, challenge.waiters.length);
    waiters.forEach((waiter, index) => {
      clearTimeout(waiter.timer);
      waiter.resolve(index === 0 ? firstResult : restResult);
    });
    dropChallenge(challenge);
  }

  async function requestVerification(accountRef, options = {}) {
    const ref = String(accountRef || '').trim();
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_VERIFY_TIMEOUT_MS);
    if (!ref) return { ok: false, reason: 'missing_account_ref' };

    // 同账号并发共享同一 challenge；verify param 一次性，complete 只喂最早等待者。
    const existing = pendingByAccount.get(ref);
    if (existing) {
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            existing.waiters = existing.waiters.filter((item) => item !== waiter);
            if (existing.waiters.length === 0) {
              dropChallenge(existing);
              emit('expired', existing);
            }
            resolve({ ok: false, reason: 'captcha_timeout' });
          }, timeoutMs)
        };
        existing.waiters.push(waiter);
      });
    }

    const config = await getCaptchaConfig();
    if (!config) {
      console.log(`[aih:zcode-captcha] captcha config unavailable (account: ${ref}, at: ${new Date(now()).toISOString()})`);
      return { ok: false, reason: 'captcha_config_unavailable' };
    }

    const challenge = {
      id: `zc_${crypto.randomBytes(8).toString('hex')}`,
      accountRef: ref,
      sceneId: config.sceneId,
      region: config.region,
      prefix: config.prefix,
      language: 'cn',
      createdAt: now(),
      waiters: []
    };

    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          challenge.waiters = challenge.waiters.filter((item) => item !== waiter);
          if (challenge.waiters.length === 0) {
            dropChallenge(challenge);
            emit('expired', challenge);
          }
          console.log(`[aih:zcode-captcha] verification timed out (account: ${ref}, challenge: ${challenge.id}, at: ${new Date(now()).toISOString()})`);
          resolve({ ok: false, reason: 'captcha_timeout' });
        }, timeoutMs)
      };
      challenge.waiters.push(waiter);
      pendingByAccount.set(ref, challenge);
      pendingById.set(challenge.id, challenge);

      // 广播即探测：没有 WebUI 监听者时立即失败，不让客户端挂到超时。
      const delivered = emit('required', challenge);
      console.log(`[aih:zcode-captcha] verification required (account: ${ref}, challenge: ${challenge.id}, listeners: ${delivered}, at: ${new Date(now()).toISOString()})`);
      if (!delivered) {
        settleChallenge(challenge, { ok: false, reason: 'no_webui_listener' }, { ok: false, reason: 'no_webui_listener' });
      }
    });
  }

  function complete(id, input = {}) {
    const challenge = pendingById.get(String(id || '').trim());
    if (!challenge) return { ok: false, reason: 'unknown_challenge' };
    const verifyParam = String(input.verifyParam || '').trim();
    if (!verifyParam) return { ok: false, reason: 'missing_verify_param' };
    const region = String(input.region || challenge.region || '').trim();
    console.log(`[aih:zcode-captcha] verification completed (account: ${challenge.accountRef}, challenge: ${challenge.id}, at: ${new Date(now()).toISOString()})`);
    // verify param 一次性：只有最早等待者拿到它，其余并发等待者按 captcha_consumed
    // 返回，由上游当下一次 3007 重新走完整流程。
    settleChallenge(
      challenge,
      { ok: true, verifyParam, region },
      { ok: false, reason: 'captcha_consumed' }
    );
    emit('resolved', challenge);
    return { ok: true };
  }

  function dismiss(id) {
    const challenge = pendingById.get(String(id || '').trim());
    if (!challenge) return { ok: false, reason: 'unknown_challenge' };
    console.log(`[aih:zcode-captcha] verification dismissed (account: ${challenge.accountRef}, challenge: ${challenge.id}, at: ${new Date(now()).toISOString()})`);
    settleChallenge(
      challenge,
      { ok: false, reason: 'dismissed' },
      { ok: false, reason: 'dismissed' }
    );
    emit('resolved', challenge);
    return { ok: true };
  }

  function listPending() {
    return Array.from(pendingById.values()).map(toPublicChallenge);
  }

  return {
    getCaptchaConfig,
    requestVerification,
    complete,
    dismiss,
    listPending
  };
}

module.exports = {
  createZcodeCaptchaBridge,
  isZcodeCaptchaRequiredErrorBody,
  DEFAULT_VERIFY_TIMEOUT_MS,
  __private: {
    readCaptchaConfig
  }
};
