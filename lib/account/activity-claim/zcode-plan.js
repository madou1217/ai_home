'use strict';

// ZCode「周末活动 / 试用套餐」（Start Plan）领取。
//
// 事实来源（2026-10-20 从本机 ZCode 客户端 app.asar 的 claimManualPlan 取证，
// 并用真实账号跑通验证码链路）：
//   GET  /api/v1/zcode-plan/billing/preview?app_version=<v>&platform=<os>-<arch>
//     → { code:0, data:{ server_time, plans:[{ plan_id, name, description, priority,
//          status, starts_at, ends_at, entitlements:[…] }] } }
//     → 非活动窗口返回 `plans: []`（这是「当前没有可领套餐」的结论，不是错误）。
//     → **data 整个缺席是常态**（2026-10-30/31 两轮真机 + §4.2 的版本×平台矩阵：
//        3.16.3/3.17.1/3.18.0/3.20.0 × darwin-arm64/win32-x64 全部只回 { code:0 }）。
//        因此它**不是**「不可判定」的故障信号，判读要靠下面第三条通道 balance。
//   GET  /api/v1/zcode-plan/billing/balance?app_version=<v>
//     → { code:0, data:{ plans:[{ plan_id, name, status:'active', … }], balances:[…] } }
//       账号**当前持有什么**。投放只在「还没领」时下发，preview 又恒空，
//       所以「两条发现通道都空」的唯一正确判读来自这里：有套餐 = already_claimed，
//       明确没有 = nothing_claimable，连它都问不到才判失败。
//   POST /api/v1/zcode-plan/billing/claim  body {"plan_id":"<plan_id>"}
//     带：Authorization: Bearer <zcodeJwtToken>
//         X-ZCode-App-Version / X-Platform
//         （可选）X-Aliyun-Captcha-Verify-Param / -Region
//   **验证码已不是前置条件**（2026-10-30 真机取证）：带正确 plan_id 的 claim 不带任何
//   X-Aliyun-Captcha-* 头直接成功，7 个账号逐个验证。旧实现每次领取都先拉起本机
//   Chrome 解一次阿里云无痕验证，解算失败即整体失败 —— 这正是「WebUI 领不到、
//   桌面端点两下就成」的直接原因。现在改为「先裸领，只有上游回 3007 才解一次重试」。
//   业务错误是 HTTP 200 + { code, msg, data:{ message } }：
//     1001 target not found（套餐不存在/已下架）
//     3007 captcha verify failed（验证码参数缺失/过期）
//
// 只有真实的 plan_id 才可能在 claim 时命中（产品常量
// `zcode-v3-start-plan` 不是活动 plan_id，直接 claim 必得 1001）。
//
// 发现通道有两条，**plan_id 不一定来自 preview**：
//   GET /api/v1/marketing/touch?seq=<n>
//     → data.deliveries[]，`resource_position: banner|popup`，
//       `buttons[].action = { type:'claim_zcode_plan', args:{ plan_id } }`
//   2026-10-30 真机：preview 对 7 个账号全部只回 { code:0 }（无 data），
//   而投放大厅照样下发 `zcode-v3-start-plan-1030-wk`，桌面端点横幅就领到了。
//   所以 preview 空/缺 data 时必须再拉一次投放，否则 WebUI 永远「暂无可领」。
//   **投放是「还没领」才有的**：领到之后上游撤下横幅（deliveries 0），
//   于是「已领到」和「没活动」在发现侧长得一模一样 —— 由 balance 区分。

const {
  ZCODE_CLIENT_CONFIGS_URL,
  ZCODE_MARKETING_TOUCH_URL,
  ZCODE_PLAN_BALANCE_URL,
  ZCODE_PLAN_CLAIM_URL,
  ZCODE_PLAN_PREVIEW_URL
} = require('../provider-api-base-url');
const {
  appendZcodeAppVersion,
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
const { classifyPlan, describePlanKinds } = require('./plans');

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

/**
 * 从营销投放里读出可领取的 plan_id。
 *
 * 投放契约（app.asar 3.17.1 的 parseMarketingTouchResponse）：
 *   { code:0, data:{ server_time, language, deliveries:[
 *       { campaign_id, priority, resource_position:'banner', banner:{ buttons:[{ text, action }] } } |
 *       { campaign_id, priority, resource_position:'popup',  popup:{  buttons:[{ text, action }] } } ] } }
 *   action = { type:'claim_zcode_plan', args:{ plan_id } }
 * 同一 resource_position 只取第一条（桌面端同样按位置去重），非法条目直接跳过。
 */
function collectMarketingClaimPlans(deliveries) {
  const plans = [];
  const seenPlanIds = new Set();
  const seenPositions = new Set();
  for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
    const entry = delivery && typeof delivery === 'object' ? delivery : null;
    if (!entry) continue;
    const position = normalizeText(entry.resource_position);
    const container = position === 'popup'
      ? entry.popup
      : (position === 'banner' ? entry.banner : null);
    if (!container || typeof container !== 'object') continue;
    if (seenPositions.has(position)) continue;
    seenPositions.add(position);
    const buttons = Array.isArray(container.buttons) ? container.buttons : [];
    for (const button of buttons) {
      const action = button && typeof button === 'object' ? button.action : null;
      if (!action || action.type !== 'claim_zcode_plan') continue;
      const planId = normalizeText(action.args && action.args.plan_id);
      if (!planId || seenPlanIds.has(planId)) continue;
      seenPlanIds.add(planId);
      plans.push({
        planId,
        name: planId,
        description: '',
        priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : 0,
        status: '',
        startsAt: null,
        endsAt: null,
        entitlements: 0,
        campaignId: normalizeText(entry.campaign_id),
        position,
        source: 'marketing_touch'
      });
    }
  }
  return plans;
}

/**
 * 拉一次投放（GET /api/v1/marketing/touch?seq=0）。不抛异常，失败只回 error。
 * seq 是桌面端的去重游标，新进程从 0 开始；这里每次调用都用 0，
 * 因为我们只关心「此刻有没有可领的投放」，不做增量。
 */
async function fetchMarketingTouchPlans(input, headers, timeoutMs, egressOptions) {
  const url = new URL(ZCODE_MARKETING_TOUCH_URL);
  url.searchParams.set('seq', '0');
  const response = await fetchClaimJson(input.fetchWithTimeout, url.toString(), {
    method: 'GET',
    headers
  }, timeoutMs, egressOptions);
  if (response.error) return { plans: [], deliveryCount: 0, error: response.error };
  if (!response.ok || !response.json) {
    return {
      plans: [],
      deliveryCount: 0,
      error: 'zcode_marketing_touch_failed:' + (response.status || 0)
    };
  }
  const deliveries = response.json.data && Array.isArray(response.json.data.deliveries)
    ? response.json.data.deliveries
    : [];
  return { plans: collectMarketingClaimPlans(deliveries), deliveryCount: deliveries.length };
}

function isBusinessSuccess(json) {
  if (!json || typeof json !== 'object') return false;
  return ZCODE_BUSINESS_SUCCESS_CODES.has(Number(json.code));
}

/**
 * 第三条只读通道：账号**当前持有什么**（GET /billing/balance，桌面端同款）。
 *
 * 为什么需要它：preview 恒空（§4.2 的版本×平台矩阵），而投放只在「还没领」时下发 ——
 * 于是「已领到」的账号在两条发现通道上都是空的，单看发现通道永远分不清
 * 「活动结束 / 本来就没活动」和「早就领过了」。balance 是唯一能回答这个问题的端点。
 *
 * 不抛异常：失败只回 `{ ok:false, error }`，由调用方决定还能不能下结论。
 */
async function fetchZcodeBalancePlans(input, headers, timeoutMs, egressOptions, appVersion) {
  const response = await fetchClaimJson(
    input.fetchWithTimeout,
    appendZcodeAppVersion(ZCODE_PLAN_BALANCE_URL, appVersion),
    { method: 'GET', headers },
    timeoutMs,
    egressOptions
  );
  if (response.error) return { ok: false, status: 0, plans: [], error: response.error };
  if (!response.ok || !response.json || !isBusinessSuccess(response.json)) {
    const status = response.status || 0;
    return { ok: false, status, plans: [], error: `zcode_balance_failed:${status}` };
  }
  const plans = response.json.data && Array.isArray(response.json.data.plans)
    ? response.json.data.plans
    : [];
  return { ok: true, status: response.status || 200, plans, error: '' };
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
  if (preview.status === 401 || preview.status === 403) {
    result.error = `zcode_auth_invalid:${preview.status}`;
    result.auth = true;
    return result;
  }

  // preview 只是**两条发现通道之一**，它的失败不再直接终止流程：
  // 桌面端的 plan_id 来自投放大厅（marketing/touch），preview 回空/缺 data 时照样能领。
  let previewPlans = [];
  let previewFailure = null;
  if (preview.error) {
    previewFailure = { error: preview.error };
  } else if (!preview.ok || !preview.json || !isBusinessSuccess(preview.json)) {
    previewFailure = {
      error: `zcode_preview_failed:${preview.status || 0}`,
      code: preview.json && preview.json.code,
      message: readEnvelopeMessage(preview.json)
    };
  } else {
    // data 缺席 = 不可判定（可重试），不是「当前没有活动」。
    const previewData = preview.json.data && typeof preview.json.data === 'object'
      ? preview.json.data
      : null;
    if (previewData) {
      previewPlans = Array.isArray(previewData.plans) ? previewData.plans : [];
    } else {
      previewFailure = {
        error: 'zcode_preview_missing_data',
        code: preview.json.code,
        message: readEnvelopeMessage(preview.json)
      };
    }
  }

  let plans = previewPlans;
  result.discovery = 'preview';
  if (plans.length === 0) {
    const touch = await fetchMarketingTouchPlans(input, headers, timeoutMs, egress.options);
    result.marketingTouch = {
      deliveries: touch.deliveryCount,
      claimable: touch.plans.length,
      ...(touch.error ? { error: touch.error } : {})
    };
    if (touch.plans.length > 0) {
      plans = touch.plans;
      result.discovery = 'marketing_touch';
    }
  }

  // 分类：服务端没有 type 字段，类型由描述符声明的规则从 plan_id/name 派生。
  // 必须在「选一个来领」之前做 —— 用户要的可能是某一类，而不是 priority 最高的那个。
  const kinds = Array.isArray(input.actionKinds) ? input.actionKinds : [];
  const wantedKind = normalizeText(input.params && input.params.planKind);
  const classified = plans.map((plan) => {
    const summary = summarizePlan(plan);
    const kind = classifyPlan(summary, kinds);
    return { summary: kind ? { ...summary, planKind: kind } : summary, kind };
  });
  result.plans = classified.map((item) => item.summary);
  if (kinds.length > 0) {
    // 声明了类型就给出类型目录（本次探测/领取里哪些类型有货），UI 与记录都用它。
    result.availableKinds = describePlanKinds(kinds, result.plans);
  }
  if (plans.length === 0) {
    // 两条发现通道都空。**不能**就此判故障：preview 恒空，投放只在「还没领」时下发，
    // 所以先问 balance —— 账号手上已经有这个套餐时，空投放正是「已领取过」的证据。
    // （2026-10-31 真机：7 个账号全部报 zcode_preview_missing_data ×5 /
    //   zcode_preview_failed ×2，而 4 个可解密账号的 balance 全是
    //   `zcode-v3-start-plan-1030-wk/active` —— 它们早就领到了。）
    const balance = await fetchZcodeBalancePlans(input, headers, timeoutMs, egress.options, appVersion);
    const held = balance.plans.map((plan) => {
      const summary = summarizePlan(plan);
      const kind = classifyPlan(summary, kinds);
      return { summary: kind ? { ...summary, planKind: kind } : summary, kind };
    });
    result.balance = {
      ok: balance.ok,
      plans: held.length,
      ...(balance.error ? { error: balance.error } : {})
    };
    if (held.length > 0) {
      result.heldPlans = held.map((item) => item.summary);
      const heldForKind = wantedKind ? held.filter((item) => item.kind === wantedKind) : held;
      if (heldForKind.length > 0) {
        // 已有该套餐 = 正常结束（不是失败），定时任务不该因此报警。
        result.status = 'already_claimed';
        result.planKind = heldForKind[0].kind || wantedKind;
        result.plan = heldForKind[0].summary;
        return result;
      }
      // 手上有套餐，但不是要的那一类：结论是「这一类没货」。
      result.status = 'nothing_claimable';
      result.planKind = wantedKind;
      if (wantedKind) result.reason = `plan_kind_unavailable:${wantedKind}`;
      return result;
    }
    if (balance.ok) {
      // balance 明确回答「没有任何套餐」：preview 缺 data 是常态，空投放就是没活动。
      result.status = 'nothing_claimable';
      return result;
    }
    // 三条通道都不可用才判失败（可重试）：此时确实「看不到」，不能假装没有活动。
    // 「preview 缺 data」不算不可用（那是常态），只有真发不出去 / 非 2xx 才算。
    const previewUnreadable = previewFailure && previewFailure.error !== 'zcode_preview_missing_data';
    if (previewUnreadable) {
      result.error = previewFailure.error;
      result.code = previewFailure.code;
      result.message = previewFailure.message;
      return result;
    }
    result.error = balance.error || 'zcode_balance_unavailable';
    return result;
  }
  if (input.dryRun === true) {
    result.status = 'dry_run';
    return result;
  }

  // 服务端一次只接受当前活动的 plan_id；多个 plan 按 priority 取最高的一个。
  // 领到即停（试用套餐通常只允许持有一个）。
  const candidates = wantedKind
    ? classified.filter((item) => item.kind === wantedKind)
    : classified;
  if (candidates.length === 0) {
    // 「这个类型当前没得领」是结论不是故障：定时任务不该因为活动换代而报警。
    result.status = 'nothing_claimable';
    result.planKind = wantedKind;
    result.reason = `plan_kind_unavailable:${wantedKind}`;
    return result;
  }
  const target = [...candidates].sort((left, right) => (
    (Number(right.summary && right.summary.priority) || 0) - (Number(left.summary && left.summary.priority) || 0)
  ))[0];
  const plan = target.summary;
  // 「领的是哪一类蛋」随结果返回：任务记录与队列据此区分两次领取。
  if (plan.planKind) result.planKind = plan.planKind;
  if (!plan.planId) {
    result.error = 'zcode_plan_id_missing';
    return result;
  }

  // **验证码是兜底，不是前置**（2026-10-30 真机取证）：带正确 plan_id 的 claim 不带
  // 任何 X-Aliyun-Captcha-* 头直接成功（7 个账号逐个验证过），服务端当前不校验。
  // 旧实现每次都先拉起本机 Chrome 解一次无痕验证（10–20s + 一个浏览器进程），解算
  // 失败即整体失败 —— 这就是「WebUI 领不到、桌面端点两下就成」的直接原因。
  // 现在先裸领；只有上游真的回 3007（captcha verify failed）才解一次并重试一次。
  const postClaim = (captchaParam, captchaRegion) => fetchClaimJson(
    input.fetchWithTimeout,
    ZCODE_PLAN_CLAIM_URL,
    {
      method: 'POST',
      headers: {
        ...buildZcodeClaimHeaders({ metadata, jwtToken, appVersion, captchaParam, captchaRegion }),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ plan_id: plan.planId })
    },
    timeoutMs,
    egress.options
  );

  let claimResponse = await postClaim('', '');
  if (!claimResponse.error && isCaptchaRejectedResponse(claimResponse)) {
    const solved = await solveCaptchaForClaim(input, headers, timeoutMs, egress.options);
    if (solved.captchaParam) {
      result.captcha = 'solved';
      claimResponse = await postClaim(solved.captchaParam, solved.region);
    } else {
      // 解不出来也要让下面按 3007 如实报错，而不是掩盖成 solve_failed 以外的状态。
      result.captcha = 'unavailable';
      result.captchaError = solved.error;
    }
  }
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

function isCaptchaRejectedResponse(response) {
  const code = response && response.json && typeof response.json.code !== 'undefined'
    ? Number(response.json.code)
    : NaN;
  return code === ZCODE_CAPTCHA_FAILED_CODE;
}

/**
 * 3007 兜底：解一次阿里云无痕验证。返回 `{ captchaParam, region }` 或 `{ error }`，
 * 不抛异常 —— 调用方要把「解不出来」当成 3007 的上下文，而不是新的失败类型。
 */
async function solveCaptchaForClaim(input, headers, timeoutMs, egressOptions) {
  const captchaConfig = await loadZcodeCaptchaConfig(input, headers, timeoutMs, egressOptions);
  if (captchaConfig.error) {
    return { error: captchaConfig.error, message: captchaConfig.message };
  }
  const captcha = captchaConfig.captcha || { enabled: true, prefix: '', region: 'cn', sceneId: '' };
  if (!captcha.enabled) return { error: 'zcode_captcha_disabled_by_upstream' };
  const solveCaptcha = typeof input.solveCaptcha === 'function'
    ? input.solveCaptcha
    : require('./aliyun-captcha').solveAliyunCaptcha;
  try {
    const captchaParam = await solveCaptcha({
      sceneId: captcha.sceneId,
      prefix: captcha.prefix,
      region: captcha.region,
      executablePath: input.captchaBrowser,
      fs: input.fs,
      hostHomeDir: input.hostHomeDir,
      timeoutMs: Math.max(timeoutMs, 60_000)
    });
    return captchaParam
      ? { captchaParam, region: captcha.region }
      : { error: 'zcode_captcha_solve_failed:empty_param' };
  } catch (error) {
    return { error: `zcode_captcha_solve_failed:${normalizeText(error && error.message) || 'unknown'}` };
  }
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
  collectMarketingClaimPlans,
  fetchMarketingTouchPlans,
  buildZcodePlanUrl,
  isCaptchaRejectedResponse,
  readCaptchaConfig,
  runZcodePlanClaim,
  solveCaptchaForClaim,
  summarizePlan
};
