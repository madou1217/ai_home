'use strict';

// kiro 的 **profileArn 解析**（纯 HTTP）—— IAM Identity Center / social 账号调 GetUsageLimits 需要它。
//
// 事实（2026-10-15 取证 + 社区同口径）：
//   * Kiro IDE 的 `~/.aws/sso/cache/kiro-auth-token.json` 直接带 profileArn（winusage docs/providers/kiro.md）；
//   * 没带时可以从上游列出来：AmazonCodeWhispererService.ListAvailableProfiles，
//     与 ListAvailableModels 同一个端点、同一套头（codewhisperer.<region>.amazonaws.com + x-amz-target + Bearer），
//     body `{"origin":"CLI"}`（见 lib/account/kiro-model-catalog.js 的实测形态）。
//
// 为什么必须补：Builder ID 账号不需要 profileArn，IdC / social 账号不给就会 400/403 —— 而 403 恰好会被
// 读成「权限不足」，与「token 过期」同一种误判。这里只负责拿到它，**多个 profile 时绝不替用户选**。

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10000;

function profileError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeProfileRow(row) {
  if (!row || typeof row !== 'object') return null;
  const arn = String(row.arn || row.profileArn || row.profile_arn || '').trim();
  if (!arn) return null;
  return { arn, name: String(row.profileName || row.profile_name || row.name || '').trim() };
}

function collectProfiles(document) {
  const list = Array.isArray(document && (document.profiles || document.profileList))
    ? (document.profiles || document.profileList)
    : [];
  const seen = new Set();
  const profiles = [];
  for (const row of list) {
    const profile = normalizeProfileRow(row);
    if (!profile || seen.has(profile.arn)) continue;
    seen.add(profile.arn);
    profiles.push(profile);
  }
  return profiles;
}

/** 该账号已知的 profileArn（凭据里带的优先）。 */
function readKiroProfileArn(nativeAuth) {
  const auth = nativeAuth && nativeAuth.auth;
  return String(
    nativeAuth && (nativeAuth.profileArn || nativeAuth.profile_arn)
    || auth && (auth.profileArn || auth.profile_arn)
    || ''
  ).trim();
}

/**
 * 列出该账号可用的 CodeWhisperer profile（纯 HTTP）。
 * @returns {Promise<{profiles: Array<{arn: string, name: string}>, status: number}>}
 */
async function fetchKiroProfiles(auth, options = {}) {
  const accessToken = String(auth && (auth.access_token || auth.accessToken) || '').trim();
  if (!accessToken) throw profileError('kiro_profiles_missing_access_token');
  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw profileError('kiro_profiles_transport_unavailable');
  const region = /^[a-z]{2}-[a-z]+-\d$/.test(String(auth && auth.region || '')) ? String(auth.region) : 'us-east-1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await request(`https://codewhisperer.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererService.ListAvailableProfiles'
      },
      body: JSON.stringify({ origin: 'CLI' }),
      redirect: 'error',
      signal: controller.signal
    });
    if (!response || response.status !== 200) {
      throw profileError(`kiro_profiles_http_${response && response.status ? response.status : 'failed'}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw profileError('kiro_profiles_response_too_large');
    let document = null;
    try {
      document = JSON.parse(text);
    } catch (_error) {
      throw profileError('kiro_profiles_invalid_json');
    }
    return { profiles: collectProfiles(document), status: response.status };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('kiro_profiles_')) throw error;
    throw profileError(controller.signal.aborted ? 'kiro_profiles_timeout' : 'kiro_profiles_transport_failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析该账号应该用的 profileArn：凭据里带了就用，没带就列一次；**唯一**时自动选用。
 *
 * @returns {Promise<{profileArn: string, source: string}|{error: string, profiles?: Array}>}
 */
async function resolveKiroProfileArn(nativeAuth, options = {}) {
  const known = readKiroProfileArn(nativeAuth);
  if (known) return { profileArn: known, source: 'credential' };

  const fetchProfiles = options.fetchKiroProfiles || fetchKiroProfiles;
  const { profiles } = await fetchProfiles(nativeAuth && nativeAuth.auth, {
    request: options.request,
    timeoutMs: options.timeoutMs
  });
  if (profiles.length === 0) return { error: 'kiro_profile_missing' };
  if (profiles.length === 1) return { profileArn: profiles[0].arn, source: 'listed' };
  // 多个 profile（企业多账号）时不替用户猜：把清单交回调用方，由人选择。
  return { error: 'kiro_profile_ambiguous', profiles };
}

module.exports = {
  collectProfiles,
  fetchKiroProfiles,
  readKiroProfileArn,
  resolveKiroProfileArn
};
