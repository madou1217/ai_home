'use strict';

const path = require('node:path');
const {
  readAccountCredentialRecord,
  compareAndSwapAccountNativeAuth
} = require('../../../server/account-credential-store');
const { readKiroTokenFromDatabase } = require('../../../account/kiro-auth-metadata');
const { fetchKiroUsageLimits } = require('../../../account/kiro-usage-client');
const { createKiroIdentityEvidence, kiroTokenBinding } = require('../../../account/kiro-identity');
const { captureKiroNativeLogin } = require('../../../account/kiro-native-login');
const { ensureFreshKiroGrant, persistKiroIdentityEvidence } = require('../../../account/kiro-grant-store');
const { resolveKiroProfileArn, readKiroProfileArn } = require('../../../account/kiro-profile');
const { resolveAccountRuntimeDir } = require('../../../runtime/aih-storage-layout');
const { resolveProviderAccountEgressRequestOptions } = require('../../../server/account-egress-request-options');
const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_KIRO } = require('../../../account/usage-remaining');

// 凭据来源（策略链据此声明 clientDependent，见 lib/providers/defs/kiro.js）：
//   * http-refresh —— **纯 API**：用内嵌 device-registration + refresh_token 走 AWS SSO OIDC CreateToken
//     刷新，再打 GetUsageLimits。不需要本地 CLI / 桌面 App。
//   * cli-capture  —— 兜底：从本地 CLI 的 sqlite 抄它刚刷新的 grant（旧行为）。
const CREDENTIAL_SOURCES = Object.freeze({ HTTP_REFRESH: 'http-refresh', CLI_CAPTURE: 'cli-capture' });

function amount(precise, fallback) {
  const value = precise ?? fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseKiroUsagePayload(document, capturedAt) {
  const resource = Array.isArray(document?.usageBreakdownList)
    ? document.usageBreakdownList.find(row => row?.resourceType === 'CREDIT') : null;
  if (!resource) return null;
  const usedUnits = amount(resource.currentUsageWithPrecision, resource.currentUsage);
  const totalUnits = amount(resource.usageLimitWithPrecision, resource.usageLimit);
  if (usedUnits == null || !(totalUnits > 0)) return null;
  const remainingUnits = Math.max(0, totalUnits - usedUnits);
  const reset = resource.nextDateReset ?? document.nextDateReset;
  const resetAtMs = typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;
  const planName = String(document.subscriptionInfo?.subscriptionTitle || '').trim();
  const planType = String(document.subscriptionInfo?.type || '').replace(/^Q_DEVELOPER_STANDALONE_/, '').toLowerCase();
  return { kind: USAGE_SNAPSHOT_KINDS.kiro, capturedAt, source: USAGE_SOURCE_KIRO,
    account: { email: String(document.userInfo?.email || '').trim(), planName, planType },
    entries: [{ bucket: 'credits', totalUnits, usedUnits, remainingUnits, unitType: 'credits',
      remainingPct: remainingUnits / totalUnits * 100,
      windowMinutes: 0, window: '', resetIn: '', resetAtMs }] };
}

function createKiroQuotaProbe(options = {}) {
  const readRecord = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const readToken = options.readKiroTokenFromDatabase || readKiroTokenFromDatabase;
  const capture = options.captureKiroNativeLogin || captureKiroNativeLogin;
  const fetchUsage = options.fetchKiroUsageLimits || fetchKiroUsageLimits;
  // 纯 API 刷新与 evidence 落库由共享模块提供（额度探针与模型发现共用同一份实现）。
  const ensureFresh = options.ensureFreshKiroGrant || ensureFreshKiroGrant;
  const persistEvidence = options.persistKiroIdentityEvidence || persistKiroIdentityEvidence;
  const now = options.now || Date.now;
  const credentialSource = String(options.credentialSource || CREDENTIAL_SOURCES.HTTP_REFRESH);
  const resolveProfile = options.resolveKiroProfileArn || resolveKiroProfileArn;
  const casWrite = options.compareAndSwapAccountNativeAuth
    || require('../../../server/account-credential-store').compareAndSwapAccountNativeAuth;

  /**
   * GetUsageLimits 带 profileArn 重试一次 —— **只在本地没有 profileArn 且上游回 400/403 时**发生。
   *
   * Builder ID 账号不需要 profileArn，因此 happy path 一次网络调用都不多付；IdC / social 账号缺它会
   * 得到 403，而 403 会被读成「权限不足」。拿到后 best-effort 落库，下次探测不必再列。
   */
  async function fetchUsageResolvingProfile(current, request) {
    try {
      return { document: await fetchUsage(current.nativeAuth, { request }), record: current };
    } catch (error) {
      const code = error && error.code;
      const profileMissing = code === 'kiro_identity_access_denied' || code === 'kiro_identity_request_failed';
      if (!profileMissing || readKiroProfileArn(current.nativeAuth)) throw error;
      const resolved = await resolveProfile(current.nativeAuth, { request }).catch(() => null);
      if (!resolved || !resolved.profileArn) throw error;
      const nativeAuth = { ...current.nativeAuth, profileArn: resolved.profileArn };
      try {
        casWrite(options.fs, options.aiHomeDir, current.accountRef, current,
          { ...current.nativeAuth, profileArn: resolved.profileArn });
      } catch (_error) { /* best-effort：落库失败也用这次解析结果重试 */ }
      const next = { ...current, nativeAuth };
      return { document: await fetchUsage(next.nativeAuth, { request }), record: next };
    }
  }

  async function probe(accountRef, probeTimeoutMs) {
    let record = readRecord(options.fs, options.aiHomeDir, accountRef);
    if (record?.provider !== 'kiro' || !record.nativeAuth?.identityEvidence) return { error: 'credential_record_missing' };
    const runtimeDir = resolveAccountRuntimeDir(options.aiHomeDir, 'kiro', accountRef);
    const egress = await resolveProviderAccountEgressRequestOptions({
      account: { provider: 'kiro', accountRef },
      options: { proxyUrl: options.proxyUrl, noProxy: options.noProxy }, deps: options
    });
    if (!egress?.ok || !egress.options) return { error: egress?.error || 'account_egress_unavailable' };
    const request = (url, init) => options.fetchWithTimeout(url, init,
      Math.max(1000, Number(probeTimeoutMs) || 10000), egress.options);
    try {
      if (credentialSource === CREDENTIAL_SOURCES.HTTP_REFRESH) {
        // 纯 API：token 快过期/已过期就自己刷新，不依赖本地 CLI。
        const refreshed = await ensureFresh(record, {
          fs: options.fs,
          aiHomeDir: options.aiHomeDir,
          accountRef,
          request,
          timeoutMs: probeTimeoutMs
        });
        if (refreshed.error) return { error: refreshed.error, auth: Boolean(refreshed.auth) };
        record = refreshed.record;
      } else {
        const nativeToken = readToken(path.join(runtimeDir, 'data.sqlite3'));
        if (nativeToken && kiroTokenBinding(nativeToken) !== kiroTokenBinding(record.nativeAuth.auth)) {
          // An active CLI owns renewal. Verify its user before CAS adoption;
          // never copy a foreign grant into the selected account.
          const result = await capture(options.fs, runtimeDir, { aiHomeDir: options.aiHomeDir, accountRef, request });
          if (!result.captured && result.reason !== 'unchanged') return { error: result.reason || 'credential_sync_failed' };
          record = readRecord(options.fs, options.aiHomeDir, accountRef);
        }
      }
      const usage = await fetchUsageResolvingProfile(record, request);
      const document = usage.document;
      record = usage.record;
      const evidence = createKiroIdentityEvidence(record.nativeAuth.auth, document, now());
      if (!evidence || evidence.subject !== record.nativeAuth.identityEvidence.subject
        || evidence.endpoint !== record.nativeAuth.identityEvidence.endpoint) return { error: 'account_identity_mismatch' };
      // 探测期间凭据被改（CLI 同时刷新 / 用户重登）时不产出快照：这次的数字对应的不是库里的 grant。
      const latest = readRecord(options.fs, options.aiHomeDir, accountRef);
      if (kiroTokenBinding(latest?.nativeAuth?.auth) !== kiroTokenBinding(record.nativeAuth.auth)) {
        return { error: 'credential_changed_during_probe' };
      }
      // 刷新后的 tokenBinding 与旧 evidence 不再匹配：把新 evidence 连同新 grant 一起 CAS 落库。
      persistEvidence(record, evidence, { fs: options.fs, aiHomeDir: options.aiHomeDir });
      const snapshot = parseKiroUsagePayload(document, now());
      if (!snapshot) return { error: 'kiro_credit_usage_missing' };
      snapshot.schemaVersion = options.usageSnapshotSchemaVersion;
      return { snapshot };
    } catch (error) {
      return { error: error.code || 'kiro_usage_probe_failed',
        auth: ['kiro_identity_authentication_failed', 'kiro_identity_access_denied'].includes(error.code) };
    }
  }
  return { probe };
}

module.exports = { CREDENTIAL_SOURCES, createKiroQuotaProbe, parseKiroUsagePayload };
