'use strict';

// Qoder / Qoder CN 每日签到（campaign「每天领 100 Credits」）。
//
// 事实来源（2026-10-20 真机取证，两个站点各领一次）：
//   GET  <base>/sash/api/v1/me/campaigns?forceRefresh=true
//     → { claimable, campaigns:[{ campaignId, actionType, claimStatus, benefit:{kind,amount,...} }] }
//   POST <base>/sash/api/v1/me/campaigns/<campaignId>/claim   body {}
//     → 幂等：已领过的活动 claimStatus 变 CLAIMED，重复 POST 不会重复发币。
//   base = openapi.qoder.sh（国际）/ openapi.qoder.com.cn（国内）。
//
// 必需设备头（缺任何一个都会返回 `campaigns: []`，看起来像「没有活动」——这是
// 最容易被误判成「不需签到」的坑，所以这里 fail-closed，不再静默返回空结论）：
//   Cosy-ClientType / Cosy-Version / Cosy-MachineOS / Cosy-MachineHostname /
//   Cosy-MachineId（账号 nativeAuth.machineId）/ Cosy-MachineToken / Cosy-MachineCode /
//   Cosy-MachineType（后三个来自 qoder CLI 写下的 umid-cache.json）。
// POST 还带 `origin: <base>`（与客户端一致；缺失时服务端返回 403）。

const nodePath = require('node:path');
const { __private: qoderProbe } = require('../../usage/quota/probes/qoder-family');
const {
  QODER_ACCOUNT_ROUTES,
  resolveQoderClientLayout
} = require('../../runtime/qoder-client-layouts');
const { resolveAccountRuntimeDir } = require('../../runtime/aih-storage-layout');
const {
  fetchClaimJson,
  normalizeText,
  readEnvelopeMessage,
  resolveClaimEgressOptions
} = require('./http');

const DEFAULT_TIMEOUT_MS = 15_000;
const QODER_UMID_CACHE_DIRS = Object.freeze({
  qoder: '.qoder',
  qodercn: '.qoder-cn'
});

function readJsonFile(fs, file) {
  if (!file || !fs || typeof fs.readFileSync !== 'function') return null;
  try {
    const parsed = JSON.parse(String(fs.readFileSync(file, 'utf8') || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 读取设备身份（UMID）。优先账号沙箱里的副本，其次宿主 qoder CLI 的缓存。
 * 返回 { machineToken, machineCode, machineType, source } 或 null。
 */
function readQoderDeviceIdentity(fs, input = {}) {
  const provider = normalizeText(input.provider).toLowerCase();
  const runtimeDir = resolveAccountRuntimeDir(input.aiHomeDir, provider, input.accountRef);
  const hostDir = normalizeText(input.hostHomeDir);
  const cacheDir = QODER_UMID_CACHE_DIRS[provider];
  const candidates = [
    runtimeDir ? nodePath.join(runtimeDir, 'umid-cache.json') : '',
    runtimeDir && cacheDir ? nodePath.join(runtimeDir, cacheDir, 'umid-cache.json') : '',
    hostDir && cacheDir ? nodePath.join(hostDir, cacheDir, 'umid-cache.json') : ''
  ].filter(Boolean);
  for (const file of candidates) {
    const parsed = readJsonFile(fs, file);
    const info = parsed && parsed.info && typeof parsed.info === 'object' ? parsed.info : null;
    if (!info) continue;
    const machineToken = normalizeText(info.machineToken);
    const machineCode = normalizeText(info.machineCode);
    if (!machineToken && !machineCode) continue;
    return {
      machineToken,
      machineCode,
      machineType: normalizeText(info.machineType),
      source: file
    };
  }
  return null;
}

/** 与 qoder CLI 的账号面请求头同形；不包含 token（token 单独放 Authorization）。 */
function buildQoderCampaignHeaders(input = {}) {
  const provider = normalizeText(input.provider).toLowerCase();
  const layout = resolveQoderClientLayout({ provider });
  const version = normalizeText(layout && layout.cliVersion) || '1.1.73';
  const nativeAuth = input.record && input.record.nativeAuth && typeof input.record.nativeAuth === 'object'
    ? input.record.nativeAuth
    : {};
  const identity = input.identity || {};
  const headers = {
    Accept: 'application/json',
    'User-Agent': `Qoder/${version}`,
    'Cosy-ClientType': '10',
    'Cosy-Version': version,
    'Cosy-MachineOS': `${normalizeText(input.arch) || process.arch}_${normalizeText(input.platform) || process.platform}`,
    'Cosy-MachineHostname': normalizeText(input.hostname),
    'Cosy-MachineId': normalizeText(nativeAuth.machineId),
    'Cosy-MachineToken': normalizeText(identity.machineToken),
    'Cosy-MachineCode': normalizeText(identity.machineCode),
    'Cosy-MachineType': normalizeText(identity.machineType)
  };
  return headers;
}

function summarizeCampaign(campaign) {
  const benefit = campaign && campaign.benefit && typeof campaign.benefit === 'object'
    ? campaign.benefit
    : {};
  return {
    campaignId: normalizeText(campaign && campaign.campaignId),
    campaignKey: normalizeText(campaign && campaign.campaignKey),
    actionType: normalizeText(campaign && campaign.actionType),
    claimStatus: normalizeText(campaign && campaign.claimStatus),
    benefitKind: normalizeText(benefit.kind),
    credits: Number.isFinite(Number(benefit.amount)) ? Number(benefit.amount) : null,
    validDays: Number.isFinite(Number(benefit.validity && benefit.validity.days))
      ? Number(benefit.validity.days)
      : null
  };
}

function buildClaimPath(campaignId) {
  const template = normalizeText(QODER_ACCOUNT_ROUTES.campaignClaim);
  return template.replace('{campaignId}', encodeURIComponent(campaignId));
}

/**
 * 跑一次签到。deps：
 *   record / provider / fs / aiHomeDir / hostHomeDir / processObj /
 *   fetchWithTimeout / resolveAccountEgressRequestOptions / accountEgressDeps /
 *   dryRun / timeoutMs
 * 返回结构化结论，不抛异常。
 */
async function runQoderDailyClaim(input = {}) {
  const record = input.record && typeof input.record === 'object' ? input.record : {};
  const provider = normalizeText(input.provider || record.provider).toLowerCase();
  const accountRef = normalizeText(record.accountRef || input.accountRef);
  const timeoutMs = Math.max(1_000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const base = qoderProbe.resolveQoderApiBase(provider);
  const result = {
    provider,
    accountRef,
    action: 'qoder_daily_checkin',
    status: 'error',
    claimed: [],
    campaigns: []
  };

  if (!base) {
    result.error = 'qoder_api_base_unknown';
    return result;
  }
  const tokenInfo = qoderProbe.resolveQoderAccessToken(provider, record);
  if (!tokenInfo.token) {
    result.error = 'qoder_token_missing';
    return result;
  }
  const identity = readQoderDeviceIdentity(input.fs, {
    aiHomeDir: input.aiHomeDir,
    hostHomeDir: input.hostHomeDir,
    provider,
    accountRef
  });
  const machineId = normalizeText(record.nativeAuth && record.nativeAuth.machineId);
  if (!identity || !machineId) {
    // 没有设备身份时上游会返回 campaigns: []，无法区分「今天没活动」和「头不完整」。
    // 明确报错，并提示补一次本机 CLI 登录（它会写下 umid-cache.json）。
    result.error = 'qoder_device_identity_missing';
    result.message = 'Run `qoder` once on this host (or login this account) so umid-cache.json exists.';
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

  const headers = {
    ...buildQoderCampaignHeaders({
      provider,
      record,
      identity,
      hostname: input.hostname,
      platform: input.platform,
      arch: input.arch
    }),
    Authorization: `Bearer ${tokenInfo.token}`
  };
  result.tokenSource = tokenInfo.tokenSource;

  const listUrl = `${base}${QODER_ACCOUNT_ROUTES.campaigns}?forceRefresh=true`;
  const list = await fetchClaimJson(input.fetchWithTimeout, listUrl, {
    method: 'GET',
    headers
  }, timeoutMs, egress.options);
  if (list.error) {
    result.error = list.error;
    return result;
  }
  if (list.status === 401 || list.status === 403) {
    result.error = `qoder_auth_invalid:${list.status}`;
    result.auth = true;
    return result;
  }
  if (!list.ok || !list.json || typeof list.json !== 'object') {
    result.error = `qoder_campaigns_http_${list.status || 0}`;
    result.message = readEnvelopeMessage(list.json);
    return result;
  }

  const campaigns = Array.isArray(list.json.campaigns) ? list.json.campaigns : [];
  const benefits = campaigns
    .filter((campaign) => normalizeText(campaign && campaign.actionType) === 'CLAIM_BENEFIT')
    .map((campaign) => ({ raw: campaign, summary: summarizeCampaign(campaign) }));
  result.campaigns = benefits.map((entry) => entry.summary);

  const claimable = benefits.filter((entry) => entry.summary.claimStatus === 'CLAIMABLE');
  if (claimable.length === 0) {
    result.status = benefits.length > 0 ? 'already_claimed' : 'nothing_claimable';
    return result;
  }
  if (input.dryRun === true) {
    result.status = 'dry_run';
    result.claimable = claimable.map((entry) => entry.summary);
    return result;
  }

  for (const entry of claimable) {
    const campaignId = entry.summary.campaignId;
    const response = await fetchClaimJson(input.fetchWithTimeout, `${base}${buildClaimPath(campaignId)}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        origin: base
      },
      body: '{}'
    }, timeoutMs, egress.options);
    if (response.error) {
      result.claimed.push({ campaignId, ok: false, error: response.error });
      continue;
    }
    const businessCode = response.json && typeof response.json.code !== 'undefined'
      ? Number(response.json.code)
      : 0;
    const explicitFailure = response.json
      && (response.json.success === false || (Number.isFinite(businessCode) && businessCode !== 0));
    if (!response.ok || explicitFailure) {
      result.claimed.push({
        campaignId,
        ok: false,
        error: `qoder_claim_http_${response.status || 0}`,
        message: readEnvelopeMessage(response.json)
      });
      continue;
    }
    result.claimed.push({
      campaignId,
      ok: true,
      credits: entry.summary.credits,
      validDays: entry.summary.validDays
    });
  }

  const successful = result.claimed.filter((entry) => entry.ok);
  if (successful.length > 0) {
    result.status = 'claimed';
    result.credits = successful.reduce((sum, entry) => sum + (Number(entry.credits) || 0), 0);
  } else {
    result.status = 'error';
    result.error = 'qoder_claim_failed';
    result.message = result.claimed.map((entry) => entry.message).filter(Boolean)[0] || '';
  }
  return result;
}

module.exports = {
  buildClaimPath,
  buildQoderCampaignHeaders,
  readQoderDeviceIdentity,
  runQoderDailyClaim,
  summarizeCampaign
};
