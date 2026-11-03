'use strict';

// WorkBuddy / WorkBuddy CN 每日签到（桌面端「Buddy加油站」活动的「立即领取」）。
//
// 事实来源：WorkBuddy.app v1.0.0 的 app.asar（CloudAccountRepo / DesktopAccountRepo /
// AuthService）。桌面端两条路径的 billingPrefix 不同（Cloud 为 ''、Desktop 为 '/v2'），
// 实测网关两者都收；这里跟桌面端一致用 '/v2'：
//   POST {base}/v2/billing/meter/checkin-activity-status   body {}  → 活动状态（只读）
//   POST {base}/v2/billing/meter/daily-checkin             body {}  → 领取
//
// 信封一律是 { code, msg, data }：
//   checkin-activity-status → data.active / today_checked_in / daily_credit / streak_days /
//                             checkin_dates / start_time / end_time / activity_name ...
//   daily-checkin           → data.credit / streak_days / is_streak_day
// 业务码（桌面端 mapCheckinStatus）：1001 已领过、1002 不符合条件、1003 活动已结束，
// 其余归 unknown_biz_error。1001 不是失败 —— 一天里多跑几次定时任务就会反复命中它。
//
// 必需头（与家族额度探针同源，缺一个就被网关判「请求不合法」）：
//   Authorization / X-User-Id / X-Domain / User-Agent（脚本 UA 会被 WAF 403）
// 企业账号还要 X-Enterprise-Id + X-Tenant-Id（桌面端 buildHeaders 的同一分支）。
// 桌面端额外带 X-Device-Token（Turing 风控 token）与 X-Request-ID，实测不带也能领到。
//
// 安全边界：dryRun 只打只读接口；真领之前**先查一次活动状态**，不活跃 / 今天已领
// 直接返回结论，绝不盲发领取请求（领取会消耗当天的一次机会）。

const {
  CODEBUDDY_PROBE_USER_AGENT,
  readCodebuddySharedCredential
} = require('../../cli/services/usage/codebuddy-quota-probe');
const {
  isCodebuddyFamilyProvider,
  resolveCodebuddyFamilyBillingEndpoint
} = require('../codebuddy-billing');
const {
  fetchClaimJson,
  normalizeText,
  readEnvelopeMessage,
  resolveClaimEgressOptions
} = require('./http');

const DEFAULT_TIMEOUT_MS = 15_000;
const CHECKIN_ACTIVITY_PATH = '/v2/billing/meter/checkin-activity-status';
const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin';

// 业务码 → 本仓库的活动状态词汇表（lib/account/activity-claim/outcomes.js）。
// 1002/1003 都落 nothing_claimable：对调用方都是「今天没什么可领」，文案由 message 带出。
const CHECKIN_BIZ_STATUS = Object.freeze({
  1001: Object.freeze({ status: 'already_claimed', message: '今天已经签到过了' }),
  1002: Object.freeze({ status: 'nothing_claimable', message: '账号不符合签到条件' }),
  1003: Object.freeze({ status: 'nothing_claimable', message: '签到活动已结束' })
});

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readCheckinState(json) {
  const data = json && typeof json.data === 'object' && json.data ? json.data : {};
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: toNumber(data.streak_days),
    dailyCredit: toNumber(data.daily_credit),
    todayCredit: toNumber(data.today_credit),
    isStreakDay: data.is_streak_day === true,
    totalCredits: toNumber(data.total_credits),
    activityName: normalizeText(data.activity_name),
    themeName: normalizeText(data.theme_name),
    startTime: normalizeText(data.start_time),
    endTime: normalizeText(data.end_time),
    claimButtonText: normalizeText(data.claim_button_text),
    checkinDates: Array.isArray(data.checkin_dates)
      ? data.checkin_dates.filter((item) => typeof item === 'string')
      : []
  };
}

/** 与桌面端 AuthService.buildHeaders 同形；企业账号补两个归属头。 */
function buildWorkbuddyCheckinHeaders(input = {}) {
  const credential = input.credential || {};
  const account = (input.record && input.record.nativeAuth && input.record.nativeAuth.credentials
    && input.record.nativeAuth.credentials.account) || {};
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${normalizeText(credential.accessToken)}`,
    'Content-Type': 'application/json',
    'X-User-Id': normalizeText(credential.uid),
    'User-Agent': CODEBUDDY_PROBE_USER_AGENT
  };
  if (credential.domain) headers['X-Domain'] = normalizeText(credential.domain);
  const enterpriseId = normalizeText(account.enterpriseId);
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = enterpriseId;
    headers['X-Tenant-Id'] = enterpriseId;
  }
  return headers;
}

/**
 * 跑一次签到。deps 与 qoder/zcode 的 handler 同形：
 *   record / provider / fs / aiHomeDir / hostHomeDir / processObj /
 *   fetchWithTimeout / resolveAccountEgressRequestOptions / accountEgressDeps /
 *   dryRun / timeoutMs
 * 返回结构化结论，不抛异常。
 */
async function runWorkbuddyDailyClaim(input = {}) {
  const record = input.record && typeof input.record === 'object' ? input.record : {};
  const provider = normalizeText(input.provider || record.provider).toLowerCase();
  const accountRef = normalizeText(record.accountRef || input.accountRef);
  const timeoutMs = Math.max(1_000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const result = {
    provider,
    accountRef,
    action: 'workbuddy_daily_checkin',
    status: 'error'
  };

  if (!isCodebuddyFamilyProvider(provider)) {
    result.error = `workbuddy_provider_unsupported:${provider || 'unknown'}`;
    return result;
  }
  const endpoint = resolveCodebuddyFamilyBillingEndpoint(provider);
  if (!endpoint) {
    result.error = 'workbuddy_endpoint_unresolved';
    return result;
  }
  const credential = readCodebuddySharedCredential(input.fs, input.aiHomeDir, provider, accountRef, {
    record,
    hostHomeDir: normalizeText(input.hostHomeDir)
  });
  if (!credential) {
    result.error = 'workbuddy_credential_missing';
    result.auth = true;
    return result;
  }
  if (!credential.accessToken) {
    result.error = 'workbuddy_token_missing';
    result.auth = true;
    return result;
  }

  const egress = await resolveClaimEgressOptions({
    fs: input.fs,
    aiHomeDir: input.aiHomeDir,
    processObj: input.processObj,
    provider,
    accountRef,
    accountEgressDeps: input.accountEgressDeps,
    resolveAccountEgressRequestOptions: input.resolveAccountEgressRequestOptions
  });
  if (egress.error) {
    result.error = egress.error;
    return result;
  }

  const headers = buildWorkbuddyCheckinHeaders({ credential, record });

  // 第一步永远是只读的活动状态：它同时回答「活动在不在」「今天领没领」「能领多少」。
  const statusResponse = await fetchClaimJson(input.fetchWithTimeout, `${endpoint}${CHECKIN_ACTIVITY_PATH}`, {
    method: 'POST',
    headers,
    body: '{}'
  }, timeoutMs, egress.options);
  if (statusResponse.error) {
    result.error = statusResponse.error;
    return result;
  }
  if (statusResponse.status === 401 || statusResponse.status === 403) {
    result.error = `workbuddy_auth_invalid:${statusResponse.status}`;
    result.auth = true;
    return result;
  }
  const statusCode = statusResponse.json && typeof statusResponse.json.code !== 'undefined'
    ? Number(statusResponse.json.code)
    : NaN;
  if (!statusResponse.ok || statusCode !== 0) {
    result.error = `workbuddy_checkin_status_failed:${statusResponse.status || 0}`;
    result.message = readEnvelopeMessage(statusResponse.json);
    return result;
  }

  const state = readCheckinState(statusResponse.json);
  result.activity = {
    name: state.activityName,
    theme: state.themeName,
    dailyCredit: state.dailyCredit,
    streakDays: state.streakDays,
    totalCredits: state.totalCredits,
    startTime: state.startTime,
    endTime: state.endTime,
    checkinDates: state.checkinDates
  };

  if (!state.active) {
    result.status = 'nothing_claimable';
    result.message = '签到活动未开启';
    return result;
  }
  if (state.todayCheckedIn) {
    result.status = 'already_claimed';
    result.message = '今天已经签到过了';
    result.streakDays = state.streakDays;
    return result;
  }
  if (input.dryRun === true) {
    result.status = 'dry_run';
    result.claimable = [{
      name: state.activityName || '每日签到',
      credits: state.dailyCredit,
      streakDays: state.streakDays
    }];
    return result;
  }

  const claimResponse = await fetchClaimJson(input.fetchWithTimeout, `${endpoint}${DAILY_CHECKIN_PATH}`, {
    method: 'POST',
    headers,
    body: '{}'
  }, timeoutMs, egress.options);
  if (claimResponse.error) {
    result.error = claimResponse.error;
    return result;
  }
  if (claimResponse.status === 401 || claimResponse.status === 403) {
    result.error = `workbuddy_auth_invalid:${claimResponse.status}`;
    result.auth = true;
    return result;
  }

  const claimJson = claimResponse.json && typeof claimResponse.json === 'object' ? claimResponse.json : {};
  const claimCode = typeof claimJson.code === 'undefined' ? NaN : Number(claimJson.code);
  if (!claimResponse.ok || !Number.isFinite(claimCode)) {
    result.error = `workbuddy_checkin_http_${claimResponse.status || 0}`;
    result.message = readEnvelopeMessage(claimJson);
    return result;
  }
  if (claimCode !== 0) {
    const mapped = CHECKIN_BIZ_STATUS[claimCode];
    if (mapped) {
      result.status = mapped.status;
      result.message = readEnvelopeMessage(claimJson) || mapped.message;
      return result;
    }
    result.error = `workbuddy_checkin_biz_${claimCode}`;
    result.message = readEnvelopeMessage(claimJson);
    return result;
  }

  // 领取结果在信封的 data 里（桌面端 AuthService 取 t.data.data；CloudAccountRepo
  // 读 e.credit 是它自己的 bug，实测拿不到值，所以这里以 data 为准）。
  const claimed = claimJson.data && typeof claimJson.data === 'object' ? claimJson.data : claimJson;
  result.status = 'claimed';
  result.credits = toNumber(claimed.credit) || state.dailyCredit;
  result.streakDays = toNumber(claimed.streak_days) || state.streakDays;
  result.isStreakDay = claimed.is_streak_day === true;
  return result;
}

module.exports = {
  CHECKIN_ACTIVITY_PATH,
  DAILY_CHECKIN_PATH,
  buildWorkbuddyCheckinHeaders,
  readCheckinState,
  runWorkbuddyDailyClaim
};
