'use strict';

// CodeBuddy 家族配额探测：Remaining 抽象（lib/account/usage-remaining.js）的家族实现。
//
// 端点、鉴权头与两个实测坑的完整说明见 lib/account/codebuddy-billing.js 头部注释；
// 这里只负责「读共享凭据 → 发一次 POST → 把 Packages[] 映射成 entries[]」。
//
// 本探针不实施 refresh；原生 App/CLI 会自行续期并回写（并非家族没有刷新协议）。
// accessToken 是桌面端/CLI 自己维护的
// Keycloak token（`workbuddy-desktop.info` 等）；到期由原生客户端续期，失效才需要重登。
// 本探针不另造 refresh；401 与 WAF/权限 403 必须分别呈现。
//
// 产出的快照复用 entries[] 形状，由家族 credits 展示分支消费。家族没有「重置时间」概念（额度按 cycle 结算但不暴露 cycle 边界），
// 因此 resetIn/resetAtMs 恒为空，不要臆造。

const nodePath = require('node:path');
const { readAccountCredentialRecord: readCredentialRecord } = require('../../../server/account-credential-store');
const { inspectCodebuddyCredential, selectCodebuddyCredential, compareCodebuddyCredentials } = require('../../../account/codebuddy-credential-source');

const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_CODEBUDDY } = require('../../../account/usage-remaining');
const {
  CODEBUDDY_RESOURCE_SUMMARY_PATH,
  resolveCodebuddyCommodityLabel,
  resolveCodebuddyFamilyAuthPath,
  resolveCodebuddyFamilyBillingEndpoint,
  resolveCodebuddyPaidPlanLabel,
  isCodebuddyFamilyProvider
} = require('../../../account/codebuddy-billing');
const { resolveAccountRuntimeDir } = require('../../../runtime/aih-storage-layout');
const {
  resolveAccountRef: defaultResolveAccountRef
} = require('../../../server/account-ref-store');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('../../../server/account-egress-request-options');

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

// 国内站网关会拦脚本默认 UA（Python-urllib / undici / curl 之类）并回 HTTP 403 +
// code 10085「请求不合法」。带一个真实客户端形态的 UA 即可，UA 本身不参与鉴权。
// 见 lib/account/codebuddy-billing.js 坑 2。
const CODEBUDDY_PROBE_USER_AGENT = 'CodeBuddy/1.0 (ai-home)';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Capacity 字段是字符串且可能带小数；空串/缺字段一律当 null（不是 0——0 代表真用尽）。
function readCapacity(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function clampPct(value) {
  return Math.max(0, Math.min(100, value));
}

// remainingPct 的取值口径：**只在能算出来的时候才算**。
//   - 有 CycleRemainCapacity → remain/total（上游权威值）；
//   - 没有 remain 但有 CycleUsedCapacity → (total-used)/total；
//   - 两者都没有 → null（未知），**不要**回退成 total-0=100%。
// 最后一条是有意的：把「字段缺失」显示成「额度满格」会掩盖真实状态，也会让账号级
// 聚合虚高。宁可 Unknown。
function computeRemainingPct(total, remain, used) {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (Number.isFinite(remain)) return clampPct((remain * 100) / total);
  if (Number.isFinite(used)) return clampPct(((total - used) * 100) / total);
  return null;
}

// PackageCode 的尾缀是随机短串，但 `TCACA_code_<NNN>` 段稳定；拿不到人可读名时
// 用 `code_<NNN>`，保证 bucket 稳定可聚合（不要把随机尾缀带进 bucket）。
function resolvePackageBucket(packageCode) {
  const code = normalizeString(packageCode);
  if (!code) return '';
  return resolveCodebuddyCommodityLabel(code) || code;
}

function toUsageEntry(pkg, capturedAt) {
  if (!pkg || typeof pkg !== 'object') return null;
  const total = readCapacity(pkg.CycleTotalCapacity);
  const remain = readCapacity(pkg.CycleRemainCapacity);
  const used = readCapacity(pkg.CycleUsedCapacity);
  if (!Number.isFinite(total) && !Number.isFinite(remain) && !Number.isFinite(used)) return null;
  return {
    bucket: resolvePackageBucket(pkg.PackageCode),
    // 家族额度按 cycle 结算但不暴露 cycle 边界，因此没有时间窗信息。
    windowMinutes: 0,
    window: '',
    remainingPct: computeRemainingPct(total, remain, used),
    // 绝对额度原样透传，WebUI hover 进度条时展示「总/剩余/已用」。
    totalUnits: Number.isFinite(total) ? total : null,
    usedUnits: Number.isFinite(used) ? used : null,
    remainingUnits: Number.isFinite(remain) ? remain : null,
    unitType: normalizeString(pkg.CapacityUnit).toLowerCase() || 'credits',
    resetIn: '',
    resetAtMs: 0
  };
}

// 账号级额度 = **所有包求和**，不是包之间取 min。
//
// 为什么：积分在多包之间是**可通用消耗**的（活动赠送包用尽 ≠ 账号不可用，计划包还在）。
// 若只发每包一条，框架的账号级口径是 min(remainingPct)，一个用尽的赠送包会把健康账号
// 拖成 0%（进而在调度里被判 exhausted 而轮换掉）。所以这里发**一条聚合条目**作为权威值
// （sum(remain)/sum(total)），每包再各发一条 `category:'detail'` 的明细供展示——
// usage-remaining 的账号级提取会跳过 detail（与 kimi 跳过 gift 同理）。
function buildAggregateEntry(entries, complete = true) {
  // Missing fields in any package make that dimension unknown. Never divide
  // the remainder of one package by the total of a different package.
  const sumComplete = key => complete && entries.every(entry => Number.isFinite(entry[key]))
    ? entries.reduce((total, entry) => total + entry[key], 0) : null;
  const total = sumComplete('totalUnits');
  const used = sumComplete('usedUnits');
  const remaining = entries.map(entry => Number.isFinite(entry.remainingUnits)
    ? entry.remainingUnits
    : Number.isFinite(entry.totalUnits) && Number.isFinite(entry.usedUnits)
      && entry.usedUnits <= entry.totalUnits ? entry.totalUnits - entry.usedUnits : null);
  const remain = complete && remaining.every(Number.isFinite)
    ? remaining.reduce((sum, value) => sum + value, 0) : null;
  const creditUnits = entries.every(entry => ['credit', 'credits'].includes(entry.unitType));
  return {
    bucket: 'credits', windowMinutes: 0, window: '',
    remainingPct: creditUnits ? computeRemainingPct(total, remain, null) : null,
    totalUnits: creditUnits ? total : null,
    usedUnits: creditUnits ? used : null,
    remainingUnits: creditUnits ? remain : null,
    unitType: 'credits', resetIn: '', resetAtMs: 0
  };
}

function parseCodebuddyResourceSummary(payload, capturedAt) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  if (!data) return null;
  const packages = Array.isArray(data.Packages) ? data.Packages : null;
  if (!packages) return null;
  const details = [];
  for (const pkg of packages) {
    const entry = toUsageEntry(pkg, capturedAt);
    if (entry) details.push({ ...entry, category: 'detail' });
  }
  if (details.length === 0) return null;
  const aggregate = buildAggregateEntry(details, details.length === packages.length);
  if (!aggregate) return null;
  const snapshot = {
    kind: USAGE_SNAPSHOT_KINDS.codebuddy,
    capturedAt: capturedAt || Date.now(),
    source: USAGE_SOURCE_CODEBUDDY,
    // 聚合值在前（权威、参与账号级计算），明细在后（category:'detail'，仅展示）。
    entries: [aggregate, ...details]
  };
  // 付费档位名只在国际站的 SubscriptionPackageCode 上出现；体验/试用包刻意不映射成
  // "Pro"（它们对应 IsPaidUser:false，展示成付费档位会误导）。
  const planType = normalizeString(resolveCodebuddyPaidPlanLabel(data.SubscriptionPackageCode));
  if (planType && data.IsPaidUser === true) snapshot.account = { planType };
  return snapshot;
}

// 读账号投影里的共享凭据文件（`<runtimeDir>/Library/.../auth/<file>.info`）。
// 返回 { accessToken, uid, domain } 或 null。凭据文件缺失/损坏一律当 null，
// 由调用方翻译成 error code。
function readCodebuddySharedCredential(fs, aiHomeDir, provider, accountRef, options = {}) {
  const record = options.record === undefined ? readCredentialRecord(fs, aiHomeDir, accountRef) : options.record;
  let credential = record?.nativeAuth?.credentials;
  const stored = inspectCodebuddyCredential(credential, provider);
  if (credential && !stored.ok) return null;
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  // No projection is required to probe an imported/native App account. DB is
  // authoritative; a newer same-scope native file may supply the live revision.
  const roots = [runtimeDir, ...(stored.ok && options.hostHomeDir ? [options.hostHomeDir] : [])];
  for (const home of roots.filter(Boolean)) {
    const selected = selectCodebuddyCredential(fs, home, provider, { expected: credential });
    if (!selected.ok) continue;
    const decision = compareCodebuddyCredentials(credential, selected.credential, provider);
    if (decision.adopt) credential = selected.credential;
  }
  if (!inspectCodebuddyCredential(credential, provider).ok) return null;
  return { accessToken: normalizeString(credential.auth.accessToken), uid: normalizeString(credential.account.uid),
    domain: normalizeString(credential.auth.domain) };
}

function createCodebuddyQuotaProbe(options = {}) {
  const {
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    resolveAccountRef,
    fetchWithTimeout,
    proxyUrl,
    noProxy,
    processObj,
    accountEgressDeps,
    resolveAccountEgressRequestOptions,
    usageSnapshotSchemaVersion,
    now = () => Date.now()
  } = options;
  const proxyOptions = {
    proxyUrl: normalizeString(proxyUrl),
    noProxy: normalizeString(noProxy)
  };

  // 返回 { snapshot } 或 { error, auth }；不抛异常，由调用方决定缓存回退策略。
  async function probe(accountRef, probeTimeoutMs) {
    const timeoutMs = Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
    const ref = normalizeString(accountRef);
    // provider 从 **account_refs** 取（只要账号存在就一定有这一行），不依赖
    // credentials 行——后者只有写过 env/nativeAuth 才存在，而家族的凭据在共享
    // `.info` 文件里，不该因为"没写过 DB 凭据"就把探测判成账号不存在。
    const resolveRefFn = typeof resolveAccountRef === 'function' ? resolveAccountRef : defaultResolveAccountRef;
    let refRecord = null;
    try {
      refRecord = resolveRefFn(fs, aiHomeDir, ref);
    } catch (_error) {
      refRecord = null;
    }
    if (!refRecord || typeof refRecord !== 'object') return { error: 'credential_record_missing' };
    const provider = normalizeString(refRecord.provider);
    if (!isCodebuddyFamilyProvider(provider)) return { error: 'credential_record_missing' };
    // API Key 模式没有积分/套餐概念，Remaining 对这类账号不适用——与 zcode 同口径。
    const readRecord = typeof readAccountCredentialRecord === 'function' ? readAccountCredentialRecord : readCredentialRecord;
    const record = readRecord(fs, aiHomeDir, ref);
    if (normalizeString(record && record.env && record.env.CODEBUDDY_API_KEY)) {
      return { error: 'api_key_mode_not_applicable' };
    }

    const credential = readCodebuddySharedCredential(fs, aiHomeDir, provider, ref, { record,
      hostHomeDir: processObj?.env?.AIH_HOST_HOME || processObj?.env?.HOME || '' });
    if (!credential) return { error: 'missing_shared_credential', auth: true };
    if (!credential.accessToken) return { error: 'missing_oauth_credentials', auth: true };

    const endpoint = resolveCodebuddyFamilyBillingEndpoint(provider);
    if (!endpoint) return { error: 'endpoint_unresolved' };

    const resolveRequestOptions = typeof resolveAccountEgressRequestOptions === 'function'
      ? resolveAccountEgressRequestOptions
      : resolveAccountEgressRequestOptionsDefault;
    let accountRequestOptions;
    try {
      accountRequestOptions = await resolveRequestOptions({
        fs,
        aiHomeDir,
        processObj,
        provider,
        accountRef: ref,
        options: proxyOptions,
        deps: accountEgressDeps || {}
      });
    } catch (error) {
      return { error: `account_egress_unavailable:${String(error?.message || error || 'unknown')}` };
    }
    if (!accountRequestOptions?.ok || !accountRequestOptions.options) {
      return {
        error: [
          String(accountRequestOptions?.error || 'account_egress_unavailable'),
          String(accountRequestOptions?.egressError || '')
        ].filter(Boolean).join(':')
      };
    }

    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
      // 两个头缺一个都会被服务端判「请求不合法」：X-User-Id 是账号身份，
      // X-Domain 是发行版归属（由凭据文件里的 auth.domain 提供）。
      'X-User-Id': credential.uid,
      'User-Agent': CODEBUDDY_PROBE_USER_AGENT
    };
    if (credential.domain) headers['X-Domain'] = credential.domain;

    try {
      const res = await fetchWithTimeout(`${endpoint}${CODEBUDDY_RESOURCE_SUMMARY_PATH}`, {
        method: 'POST',
        headers,
        body: '{}'
      }, timeoutMs, accountRequestOptions.options);
      const payload = await res.json().catch(() => null);
      if (record) {
        const latest = readRecord(fs, aiHomeDir, ref);
        if (!latest || latest.nativeAuthUpdatedAt !== record.nativeAuthUpdatedAt || latest.envUpdatedAt !== record.envUpdatedAt) {
          return { error: 'credential_changed_during_probe' };
        }
      }
      if (!res.ok) {
        const waf = res.status === 403 && String(payload && payload.code) === '10085';
        return {
          error: waf ? 'codebuddy_resource_waf_rejected' : `codebuddy_resource_http_${res.status}`,
          // A generic permission/WAF rejection is not proof of an expired grant.
          auth: res.status === 401
        };
      }
      if (!payload || typeof payload !== 'object') return { error: 'codebuddy_resource_business_error' };
      // 业务错误是 HTTP 200 + { code != 0 }。
      if (payload.code !== undefined && payload.code !== 0 && payload.code !== '0' && payload.code !== 200 && payload.code !== '200') {
        return { error: `codebuddy_resource_business_error:${String(payload.code)}` };
      }
      const snapshot = parseCodebuddyResourceSummary(payload, now());
      if (!snapshot) return { error: 'empty_parsed_snapshot' };
      if (usageSnapshotSchemaVersion != null) snapshot.schemaVersion = usageSnapshotSchemaVersion;
      return { snapshot };
    } catch (error) {
      return { error: `probe_exception:${String(error && error.message || error).slice(0, 120)}` };
    }
  }

  return { probe };
}

module.exports = {
  createCodebuddyQuotaProbe,
  CODEBUDDY_PROBE_USER_AGENT,
  readCodebuddySharedCredential,
  __private: {
    readCapacity,
    resolvePackageBucket,
    toUsageEntry,
    parseCodebuddyResourceSummary
  }
};
