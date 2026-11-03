'use strict';

const { readGrokAuthProfile } = require('../../../account/grok-auth-profile');
const { readProviderApiCredential } = require('../../../account/provider-credential-env');
const { GROK_BILLING_URL, GROK_BILLING_LEGACY_URL, GROK_USER_URL, GROK_BILLING_GRPC_URL } = require('../../../account/grok-endpoints');
const { parseGrokBillingGrpcResponse } = require('./grok-billing-grpc');
const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_GROK } = require('../../../account/usage-remaining');
const { readAccountCredentialRecord: readCredentialRecord } = require('../../../server/account-credential-store');
const { refreshGrokAccessToken: refreshTokenDefault } = require('../../../server/grok-token-refresh');
const { resolveProviderAccountEgressRequestOptions } = require('../../../server/account-egress-request-options');

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

function readBillingUnits(value) {
  const raw = value && typeof value === 'object' ? value.val : value;
  if (!['number', 'string'].includes(typeof raw) || typeof raw === 'string' && !raw.trim()) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function createBillingSnapshot(entry, capturedAt, user) {
  const planName = String(user && user.subscriptionTier || '').trim();
  return {
    kind: USAGE_SNAPSHOT_KINDS.grok,
    capturedAt,
    source: USAGE_SOURCE_GROK,
    account: { planType: planName.toLowerCase(), planName, email: String(user && user.email || '').trim() },
    entries: [entry]
  };
}

function parseGrokBillingPayload(payload, capturedAt, user) {
  const config = payload && payload.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const period = config.currentPeriod || {};
  const startAtMs = Date.parse(String(period.start || config.billingPeriodStart || ''));
  const resetAtMs = Date.parse(String(period.end || config.billingPeriodEnd || ''));
  const windowMinutes = Number.isFinite(startAtMs) && Number.isFinite(resetAtMs) && resetAtMs > startAtMs
    ? Math.round((resetAtMs - startAtMs) / 60_000) : 0;
  let usedPct = typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
    && config.creditUsagePercent >= 0 && config.creditUsagePercent <= 100
    ? config.creditUsagePercent : null;
  // OpenUsage 的旧账单格式只用 included limit 计算，不混入 onDemand 上限或钱包余额。
  // https://github.com/mesomya/openusage-windows/blob/main/docs/providers/grok.md
  if (usedPct == null) {
    const limit = readBillingUnits(config.monthlyLimit);
    const used = readBillingUnits(config.used);
    if (limit > 0 && used != null) usedPct = Math.min(100, used / limit * 100);
  }
  // onDemand/prepaid 是旁路金额，不能当作订阅配额或据此判定账号已耗尽。
  // 没有 creditUsagePercent 的响应仍携带真实周期，额度必须保持未知。
  if (usedPct == null && !windowMinutes && !(resetAtMs > 0)) return null;
  return createBillingSnapshot({
    bucket: 'credits',
    windowMinutes,
    window: windowMinutes ? `${windowMinutes}m` : '',
    remainingPct: usedPct == null ? null : 100 - usedPct,
    resetIn: '',
    resetAtMs: resetAtMs > 0 ? resetAtMs : 0
  }, capturedAt, user);
}

function createGrokQuotaProbe(options = {}) {
  const {
    fs,
    aiHomeDir,
    fetchWithTimeout,
    accountArtifactHooks,
    processObj,
    accountEgressDeps,
    resolveAccountEgressRequestOptions,
    usageSnapshotSchemaVersion,
    now = () => Date.now()
  } = options;
  const readRecord = options.readAccountCredentialRecord || readCredentialRecord;
  const refreshToken = options.refreshGrokAccessToken || refreshTokenDefault;
  const proxyOptions = { proxyUrl: String(options.proxyUrl || '').trim(), noProxy: String(options.noProxy || '').trim() };

  async function probe(accountRef, probeTimeoutMs) {
    const timeoutMs = Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
    const record = readRecord(fs, aiHomeDir, accountRef);
    if (!record || record.provider !== 'grok') return { error: 'credential_record_missing' };
    if (readProviderApiCredential('grok', record.env)) return { error: 'api_key_mode_not_applicable' };
    const profile = readGrokAuthProfile(record.nativeAuth && record.nativeAuth.auth);
    if (!profile.accessToken && !profile.refreshToken) return { error: 'missing_oauth_credentials', auth: true };
    const account = { ...profile, accountRef, provider: 'grok' };
    const deps = { fs, aiHomeDir, processObj, fetchWithTimeout, accountArtifactHooks,
      accountEgressDeps, resolveAccountEgressRequestOptions };
    const egress = await resolveProviderAccountEgressRequestOptions({ account, options: proxyOptions, deps });
    if (!egress?.ok || !egress.options) return { error: egress?.error || 'account_egress_unavailable' };
    const requestOptions = egress.options;
    let refreshAttempted = false;

    async function refresh() {
      refreshAttempted = true;
      const result = await refreshToken(account, { ...requestOptions, force: true, timeoutMs, nowMs: now() }, deps);
      return result?.ok && account.accessToken ? '' : `token_refresh_failed:${result?.reason || 'unknown'}`;
    }

    const request = (url, budgetMs = timeoutMs) => fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${account.accessToken}`, Accept: 'application/json',
        'x-xai-token-auth': 'xai-grok-cli' }
    }, budgetMs, requestOptions);

    async function requestPrimaryBilling() {
      try {
        return await request(GROK_BILLING_URL);
      } catch (_error) {
        return null;
      }
    }

    async function readLegacyBilling(user) {
      try {
        const response = await request(GROK_BILLING_LEGACY_URL, Math.min(timeoutMs, 6_000));
        if (!response.ok) return null;
        const snapshot = parseGrokBillingPayload(await response.json(), now(), user);
        return snapshot?.entries[0].remainingPct != null ? snapshot : null;
      } catch (_error) {
        return null;
      }
    }

    async function readGrpcRemaining() {
      try {
        const response = await fetchWithTimeout(GROK_BILLING_GRPC_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${account.accessToken}`,
            'Content-Type': 'application/grpc-web+proto',
            'x-grpc-web': '1', 'x-user-agent': 'connect-es/2.1.1',
            Origin: 'https://grok.com', Referer: 'https://grok.com/?_s=usage'
          },
          body: Buffer.from([0, 0, 0, 0, 2, 8, 0])
        }, Math.min(timeoutMs, 6_000), requestOptions);
        const status = response.headers && response.headers.get('grpc-status');
        if (!response.ok || status && status !== '0') return null;
        return parseGrokBillingGrpcResponse(await response.arrayBuffer(), now());
      } catch (_error) {
        // 补充接口失败不能抹掉已取得的周期，也不能把有效 REST 凭据误标成失效。
        return null;
      }
    }

    try {
      if (!account.accessToken || (profile.tokenExpiresAt && profile.tokenExpiresAt - now() <= 30_000)) {
        const error = await refresh();
        if (error) return { error, auth: true };
      }
      let response = await requestPrimaryBilling();
      if (response?.status === 401 && !refreshAttempted) {
        const error = await refresh();
        if (error) return { error, auth: true };
        response = await requestPrimaryBilling();
      }
      const primaryError = response?.ok ? '' : response
        ? `grok_billing_http_${response.status}` : 'grok_billing_probe_failed';
      if (response && !response.ok && response.status !== 408 && response.status < 500) {
        return { error: primaryError, auth: response.status === 401 };
      }
      // REST 超时或服务暂时不可用时，仍尝试独立的官方账单接口。
      // 认证拒绝与限流保留原错误，不继续请求其他端点。
      const payload = response?.ok ? await response.json().catch(() => null) : null;
      let user = null;
      try {
        const identityResponse = await request(GROK_USER_URL);
        if (identityResponse.ok) user = await identityResponse.json().catch(() => null);
      } catch (_error) {
        // 身份探测失败不影响已取得的账单周期和额度。
      }
      let snapshot = parseGrokBillingPayload(payload, now(), user);
      if (!snapshot || snapshot.entries[0].remainingPct == null) {
        const remaining = await readGrpcRemaining();
        if (remaining) {
          // 数值与周期必须来自同一笔账单，不能保留另一接口的旧周期。
          snapshot = createBillingSnapshot({
            bucket: 'credits', ...remaining, resetIn: '',
            window: remaining.windowMinutes ? `${remaining.windowMinutes}m` : ''
          }, now(), user);
        } else {
          // 旧账单的月度百分比必须带它自己的周期，不能套到 credits 的周窗口上。
          snapshot = await readLegacyBilling(user) || snapshot;
        }
      }
      if (!snapshot) return { error: primaryError || 'empty_parsed_snapshot' };
      const latest = readRecord(fs, aiHomeDir, accountRef);
      const latestProfile = readGrokAuthProfile(latest?.nativeAuth?.auth);
      if (!latest || latest.provider !== 'grok' || readProviderApiCredential('grok', latest.env)
        || latestProfile.accessToken !== account.accessToken) {
        return { error: 'credential_changed_during_probe' };
      }
      snapshot.account.email ||= profile.email;
      if (usageSnapshotSchemaVersion != null) snapshot.schemaVersion = usageSnapshotSchemaVersion;
      return { snapshot };
    } catch (_error) {
      return { error: 'grok_billing_probe_failed' };
    }
  }

  return { probe };
}

module.exports = { createGrokQuotaProbe, parseGrokBillingPayload };
