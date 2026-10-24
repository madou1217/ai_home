'use strict';

// ZCode「周末活动 / 试用套餐」（Start Plan）领取。
//
// 事实来源（2026-10-20 从本机 ZCode 客户端 app.asar 的 claimManualPlan 取证，
// 并用真实账号跑通验证码链路）：
//   GET  /api/v1/zcode-plan/billing/preview?app_version=<v>&platform=<os>-<arch>
//     → { code:0, data:{ server_time, plans:[{ plan_id, name, description, priority,
//          status, starts_at, ends_at, entitlements:[…] }] } }
//     → 非活动窗口返回 `plans: []`（这是「当前没有可领套餐」的结论，不是错误）。
//   GET  /api/v1/client/configs → data.configs.captcha = { enabled, prefix, region, sceneId }
//   POST /api/v1/zcode-plan/billing/claim  body {"plan_id":"<plan_id>"}
//     必须带：Authorization: Bearer <zcodeJwtToken>
//             X-Aliyun-Captcha-Verify-Param: <280 字符无痕验证参数>
//             X-Aliyun-Captcha-Verify-Region: cn
//             X-ZCode-App-Version / X-Platform
//   业务错误是 HTTP 200 + { code, msg, data:{ message } }：
//     1001 target not found（套餐不存在/已下架）
//     3007 captcha verify failed（验证码参数缺失/过期）
//
// 关键顺序：服务端先校验验证码、再校验 plan_id。所以 3007 不代表活动状态；
// 反过来，只有 preview 返回的 plan_id 才可能在 claim 时命中（产品常量
// `zcode-v3-start-plan` 不是活动 plan_id，直接 claim 必得 1001）。

const {
  ZCODE_CLIENT_CONFIGS_URL,
  ZCODE_PLAN_CLAIM_URL,
  ZCODE_PLAN_PREVIEW_URL
} = require('../provider-api-base-url');
const {
  buildZcodeClientRequestMetadata
} = require('../zcode-client-metadata');
const {
  SEED_ZCODE_APP_VERSION,
  refreshZcodeAppVersion
} = require('../zcode-app-version');
const {
  readZcodeLiveOAuthCredential
} = require('../zcode-credential');
const {
  fetchClaimJson,
  normalizeText,
  readEnvelopeMessage,
  resolveClaimEgressOptions
} = require('./http');

// app_version 的解析与优先级链统一在 lib/account/zcode-app-version.js
// （本机安装版 → 缓存 → 官方最新版 → 种子）。**这里不许再写死版本号**：
// preview 对版本做门槛，写旧了不报错，只会把真实存在的套餐变成空列表
// （实测 3.15.3 → plans:[]，3.16.3 → 有套餐）。允许 `--app-version` 显式覆盖。
const DEFAULT_ZCODE_APP_VERSION = SEED_ZCODE_APP_VERSION;
const DEFAULT_TIMEOUT_MS = 20_000;
const ZCODE_BUSINESS_SUCCESS_CODES = new Set([0, 200]);
const ZCODE_CAPTCHA_FAILED_CODE = 3007;
const ZCODE_TARGET_NOT_FOUND_CODE = 1001;

function buildZcodeClaimHeaders(input = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const headers = {
    ...(metadata.headers && typeof metadata.headers === 'object' ? metadata.headers : {}),
    Accept: 'application/json',
    Authorization: `Bearer ${normalizeText(input.jwtToken)}`,
    'X-ZCode-App-Version': normalizeText(input.appVersion)
  };
  const captchaParam = normalizeText(input.captchaParam);
  if (captchaParam) headers['X-Aliyun-Captcha-Verify-Param'] = captchaParam;
  const captchaRegion = normalizeText(input.captchaRegion);
  if (captchaRegion) headers['X-Aliyun-Captcha-Verify-Region'] = captchaRegion;
  return headers;
}

function buildZcodePlanUrl(baseUrl, appVersion, platform, arch) {
  const url = new URL(baseUrl);
  if (appVersion) url.searchParams.set('app_version', appVersion);
  if (platform && arch) url.searchParams.set('platform', `${platform}-${arch}`);
  return url.toString();
}

function summarizePlan(plan) {
  return {
    planId: normalizeText(plan && (plan.plan_id || plan.planId)),
    name: normalizeText(plan && plan.name),
    description: normalizeText(plan && plan.description),
    priority: Number.isFinite(Number(plan && plan.priority)) ? Number(plan.priority) : 0,
    status: normalizeText(plan && plan.status),
    startsAt: plan && plan.starts_at ? plan.starts_at : null,
    endsAt: plan && plan.ends_at ? plan.ends_at : null,
    entitlements: Array.isArray(plan && plan.entitlements) ? plan.entitlements.length : 0
  };
}

function isBusinessSuccess(json) {
  if (!json || typeof json !== 'object') return false;
  return ZCODE_BUSINESS_SUCCESS_CODES.has(Number(json.code));
}

function readCaptchaConfig(json) {
  const configs = json && json.data && json.data.configs && typeof json.data.configs === 'object'
    ? json.data.configs
    : {};
  const captcha = configs.captcha && typeof configs.captcha === 'object' ? configs.captcha : null;
  if (!captcha) return null;
  return {
    enabled: captcha.enabled !== false,
    prefix: normalizeText(captcha.prefix),
    region: normalizeText(captcha.region) || 'cn',
    sceneId: normalizeText(captcha.sceneId || captcha.scene_id)
  };
}

/**
 * 跑一次 ZCode 套餐领取。deps：
 *   record / fs / aiHomeDir / hostHomeDir / processObj / fetchWithTimeout /
 *   resolveAccountEgressRequestOptions / accountEgressDeps /
 *   solveCaptcha（可注入；默认 ./aliyun-captcha）/ dryRun / timeoutMs /
 *   appVersion / captchaBrowser
 * 返回结构化结论，不抛异常。
 */
async function runZcodePlanClaim(input = {}) {
  const record = input.record && typeof input.record === 'object' ? input.record : {};
  const accountRef = normalizeText(record.accountRef || input.accountRef);
  const timeoutMs = Math.max(1_000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const result = {
    provider: 'zcode',
    accountRef,
    action: 'zcode_plan_claim',
    status: 'error',
    plans: [],
    claimed: []
  };

  const env = record.env && typeof record.env === 'object' ? record.env : {};
  const jwt = readZcodeLiveOAuthCredential(input.fs, input.aiHomeDir, accountRef, record);
  const jwtToken = normalizeText(jwt && jwt.oauth && jwt.oauth.jwtToken);
  if (!jwtToken) {
    if (normalizeText(env.ZCODE_API_KEY)) {
      // API Key 账号没有套餐概念，也没有 jwt；不是失败。
      result.status = 'not_applicable';
      return result;
    }
    result.error = 'zcode_jwt_missing';
    return result;
  }
  result.credentialSource = jwt.source;

  // 先异步把「官方最新版」刷进缓存（失败静默），再同步解析；
  // 这样即使本机没装桌面端，也能拿到不低于种子值的真实版本。
  const explicitAppVersion = normalizeText(input.appVersion);
  if (!explicitAppVersion) {
    try {
      await refreshZcodeAppVersion({
        fs: input.fs, aiHomeDir: input.aiHomeDir,
        fetchImpl: input.fetchImpl || (typeof fetch === 'function' ? fetch : null)
      });
    } catch (_error) { /* 刷新失败不影响主流程 */ }
  }
  const metadata = buildZcodeClientRequestMetadata(input.fs, {
    aiHomeDir: input.aiHomeDir,
    hostHomeDir: input.hostHomeDir,
    accountRef,
    processObj: input.processObj,
    // 只有显式传入时才覆盖；否则交给解析链，**别用写死值压掉真实版本**。
    ...(explicitAppVersion ? { appVersion: explicitAppVersion } : {}),
    allowSystemApplications: true
  });
  const appVersion = normalizeText(metadata.appVersion) || DEFAULT_ZCODE_APP_VERSION;
  const platform = normalizeText(input.platform) || (input.processObj && input.processObj.platform) || process.platform;
  const arch = normalizeText(input.arch) || (input.processObj && input.processObj.arch) || process.arch;
  const headers = {
    ...metadata.headers,
    Accept: 'application/json',
    Authorization: `Bearer ${jwtToken}`,
    'X-ZCode-App-Version': appVersion
  };

  const egress = await resolveClaimEgressOptions({
    fs: input.fs,
    aiHomeDir: input.aiHomeDir,
    processObj: input.processObj,
    provider: 'zcode',
    accountRef,
    accountEgressDeps: input.accountEgressDeps,
    resolveAccountEgressRequestOptions: input.resolveAccountEgressRequestOptions
  });
  if (egress.error) {
    result.error = egress.error;
    return result;
  }

  const previewUrl = buildZcodePlanUrl(ZCODE_PLAN_PREVIEW_URL, appVersion, platform, arch);
  const preview = await fetchClaimJson(input.fetchWithTimeout, previewUrl, {
    method: 'GET',
    headers
  }, timeoutMs, egress.options);
  if (preview.error) {
    result.error = preview.error;
    return result;
  }
  if (preview.status === 401 || preview.status === 403) {
    result.error = `zcode_auth_invalid:${preview.status}`;
    result.auth = true;
    return result;
  }
  if (!preview.ok || !preview.json || !isBusinessSuccess(preview.json)) {
    result.error = `zcode_preview_failed:${preview.status || 0}`;
    result.code = preview.json && preview.json.code;
    result.message = readEnvelopeMessage(preview.json);
    return result;
  }

  const plans = Array.isArray(preview.json.data && preview.json.data.plans)
    ? preview.json.data.plans
    : [];
  result.plans = plans.map(summarizePlan);
  if (plans.length === 0) {
    result.status = 'nothing_claimable';
    return result;
  }
  if (input.dryRun === true) {
    result.status = 'dry_run';
    return result;
  }

  // 服务端一次只接受当前活动的 plan_id；多个 plan 按 priority 取最高的一个。
  // 领到即停（试用套餐通常只允许持有一个）。
  const target = [...plans].sort((left, right) => (
    (Number(right && right.priority) || 0) - (Number(left && left.priority) || 0)
  ))[0];
  const plan = summarizePlan(target);
  if (!plan.planId) {
    result.error = 'zcode_plan_id_missing';
    return result;
  }

  const captchaConfig = await loadZcodeCaptchaConfig(input, headers, timeoutMs, egress.options);
  if (captchaConfig.error) {
    result.error = captchaConfig.error;
    result.message = captchaConfig.message;
    return result;
  }
  const captcha = captchaConfig.captcha || { enabled: true, prefix: '', region: 'cn', sceneId: '' };

  let captchaParam = '';
  if (captcha.enabled) {
    const solveCaptcha = typeof input.solveCaptcha === 'function'
      ? input.solveCaptcha
      : require('./aliyun-captcha').solveAliyunCaptcha;
    try {
      captchaParam = await solveCaptcha({
        sceneId: captcha.sceneId,
        prefix: captcha.prefix,
        region: captcha.region,
        executablePath: input.captchaBrowser,
        fs: input.fs,
        hostHomeDir: input.hostHomeDir,
        timeoutMs: Math.max(timeoutMs, 60_000)
      });
    } catch (error) {
      result.error = `zcode_captcha_solve_failed:${normalizeText(error && error.message) || 'unknown'}`;
      return result;
    }
  }

  const claimResponse = await fetchClaimJson(input.fetchWithTimeout, ZCODE_PLAN_CLAIM_URL, {
    method: 'POST',
    headers: {
      ...buildZcodeClaimHeaders({
        metadata,
        jwtToken,
        appVersion,
        captchaParam,
        captchaRegion: captcha.region
      }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ plan_id: plan.planId })
  }, timeoutMs, egress.options);
  if (claimResponse.error) {
    result.error = claimResponse.error;
    return result;
  }
  const businessCode = claimResponse.json && typeof claimResponse.json.code !== 'undefined'
    ? Number(claimResponse.json.code)
    : NaN;
  if (!claimResponse.ok || !isBusinessSuccess(claimResponse.json)) {
    result.code = Number.isFinite(businessCode) ? businessCode : null;
    result.message = readEnvelopeMessage(claimResponse.json);
    if (businessCode === ZCODE_CAPTCHA_FAILED_CODE) {
      result.error = 'zcode_captcha_rejected';
    } else if (businessCode === ZCODE_TARGET_NOT_FOUND_CODE) {
      result.error = 'zcode_plan_not_found';
    } else {
      result.error = `zcode_claim_failed:${claimResponse.status || 0}`;
    }
    // 已领取是「正常结束」而不是故障：让定时任务不要因为重复运行而报警。
    if (/已领取|already\s*claimed/i.test(result.message)) {
      result.status = 'already_claimed';
      delete result.error;
    }
    return result;
  }

  result.status = 'claimed';
  result.claimed = [{ ...plan }];
  result.plan = plan;
  return result;
}

async function loadZcodeCaptchaConfig(input, headers, timeoutMs, egressOptions) {
  const configUrl = new URL(ZCODE_CLIENT_CONFIGS_URL);
  const url = configUrl.toString();
  const response = await fetchClaimJson(input.fetchWithTimeout, url, {
    method: 'GET',
    headers
  }, timeoutMs, egressOptions);
  if (response.error) return { error: `zcode_captcha_config_unavailable:${response.error}` };
  if (!response.ok || !response.json) {
    return {
      error: `zcode_captcha_config_unavailable:${response.status || 0}`,
      message: readEnvelopeMessage(response.json)
    };
  }
  const captcha = readCaptchaConfig(response.json);
  if (!captcha) return { error: 'zcode_captcha_config_unavailable:missing_captcha' };
  if (captcha.enabled && (!captcha.sceneId || !captcha.prefix)) {
    return { error: 'zcode_captcha_config_unavailable:incomplete_captcha' };
  }
  return { captcha };
}

module.exports = {
  DEFAULT_ZCODE_APP_VERSION,
  ZCODE_CAPTCHA_FAILED_CODE,
  buildZcodeClaimHeaders,
  buildZcodePlanUrl,
  readCaptchaConfig,
  runZcodePlanClaim,
  summarizePlan
};
