'use strict';

// CodeBuddy 家族的**余额/积分**端点与商品码口径（Remaining 探测用）。
//
// 来源：WorkBuddy / CodeBuddy 桌面端（Electron `app.asar`）与内嵌 CLI 的实测结果，
// 见 docs/architecture/codebuddy-family-credential-model.md §14。
//
// 端点（桌面端与官网同款）：
//   POST {endpoint}/billing/meter/get-user-resource-summary
//   Body: {}   Headers: Authorization: Bearer <accessToken>
//                       X-User-Id:  <account.uid>
//                       X-Domain:   <auth.domain>（如 www.workbuddy.cn）
//                       Accept-Language: zh|en（决定 PackageName 语言）
//
// ⚠️ 两个实测坑，错了就静默 403：
//   1. **不带 `/v2` 前缀**。老接口 `get-user-resource` 才需要 `/v2`；#97550 的三个新
//      接口（summary / paid-packages / free-packages）的网关路由声明的是**无前缀**路径。
//      带 `/v2` 会得到 404 Route Not Found。
//   2. **必须带真实 User-Agent**。国内站网关（copilot.tencent.com）对脚本默认 UA
//      （如 `Python-urllib/3.x`）返回 HTTP 403 + `{"code":10085,"msg":"请求不合法"}`；
//      换成任意真实客户端 UA 即 200。这不是鉴权失败，是 WAF 拦脚本 UA。
//
// 响应形状（`{code:0,msg:'OK',data}`）：
//   { Packages:[{ PackageCode, CycleTotalCapacity, CycleRemainCapacity,
//                 CycleUsedCapacity, CycleFrozenCapacity, CapacityUnit }],
//     SubscriptionPackageCode, IsPaidUser, IsProtectedPriceUser, ProTrialStatus? }
// 四个 Capacity 字段都是**字符串**（可能带小数），CapacityUnit 实测为 `credit(s)`。

const {
  CODEBUDDY_AI_SHARED_AUTH_PATH,
  CODEBUDDY_CN_SHARED_AUTH_PATH,
  CODEBUDDY_INTL_SHARED_AUTH_PATH
} = require('../runtime/provider-storage-policy');

// 余额接口路径（无 `/v2` 前缀，见上文坑 1）。
const CODEBUDDY_RESOURCE_SUMMARY_PATH = '/billing/meter/get-user-resource-summary';

// 发行版级 endpoint：国内站两支共用一个网关，国际站两支各用自己站点的域名。
const CODEBUDDY_FAMILY_BILLING_ENDPOINTS = Object.freeze({
  codebuddy: 'https://www.codebuddy.ai',
  workbuddy: 'https://www.workbuddy.ai',
  codebuddycn: 'https://copilot.tencent.com',
  workbuddycn: 'https://copilot.tencent.com'
});

// 四支客户端各自的共享凭据文件（HOME 相对路径），与 storage policy 的 authArtifact
// 同源——国内站两支共用 `workbuddy-desktop.info`，国际站两支各一份。
const CODEBUDDY_FAMILY_AUTH_PATHS = Object.freeze({
  codebuddy: CODEBUDDY_INTL_SHARED_AUTH_PATH,
  workbuddy: CODEBUDDY_AI_SHARED_AUTH_PATH,
  codebuddycn: CODEBUDDY_CN_SHARED_AUTH_PATH,
  workbuddycn: CODEBUDDY_CN_SHARED_AUTH_PATH
});

const CODEBUDDY_FAMILY_PROVIDERS = Object.freeze([
  'codebuddy',
  'codebuddycn',
  'workbuddy',
  'workbuddycn'
]);

// CommodityCode（桌面端 `app.asar` 的枚举，2026-09-15 实测 v1.0.0）——商品码的尾缀
// 是随机短串（`TCACA_code_007_nzdH5h4Nl0`），但 `TCACA_code_<NNN>` 段是稳定的，
// 所以按**前缀**匹配，不写死整串。用于把 Packages[].PackageCode 翻成人可读的桶名。
//
// 不必求全：未登记的码原样回退成 `code_<NNN>`，不影响 remainingPct 计算。
const CODEBUDDY_COMMODITY_LABELS = Object.freeze([
  ['TCACA_code_001_', 'free'],
  ['TCACA_code_002_', 'proMon'],
  ['TCACA_code_003_', 'proYear'],
  ['TCACA_code_005_', 'proMonPlus'],
  ['TCACA_code_006_', 'gift'],
  ['TCACA_code_007_', 'activity'],
  ['TCACA_code_008_', 'freeMon'],
  ['TCACA_code_009_', 'extra'],
  ['TCACA_code_023_', 'youth'],
  ['TCACA_code_026_', 'advanced'],
  ['TCACA_code_027_', 'flagship'],
  ['TCACA_code_028_', 'bonus28'],
  ['TCACA_code_029_', 'bonus29'],
  ['TCACA_code_030_', 'bonus30'],
  ['TCACA_code_035_', 'freeMonIntl'],
  ['TCACA_code_036_', 'extraIntl'],
  ['TCACA_code_037_', 'bonusIntl'],
  ['TCACA_code_038_', 'extra38'],
  ['TCACA_code_039_', 'proTrialMon'],
  ['TCACA_code_040_', 'proTrialYear']
]);

// 档位（付费套餐）商品码 → 展示名。用于快照的 planType（WebUI/CLI 的 plan badge）。
// 体验/试用包（proTrialMon / proTrialYear）刻意不当作付费档位——它们对应
// `IsPaidUser:false`，展示成 "Pro" 会误导。
const CODEBUDDY_PAID_PLAN_LABELS = Object.freeze([
  ['TCACA_code_002_', 'Pro'],
  ['TCACA_code_003_', 'Pro'],
  ['TCACA_code_005_', 'Pro Plus'],
  ['TCACA_code_023_', 'Youth'],
  ['TCACA_code_026_', 'Advanced'],
  ['TCACA_code_027_', 'Flagship']
]);

function normalizeCodebuddyProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function isCodebuddyFamilyProvider(provider) {
  return CODEBUDDY_FAMILY_PROVIDERS.includes(normalizeCodebuddyProvider(provider));
}

// '' when the provider is not part of the CodeBuddy family.
function resolveCodebuddyFamilyBillingEndpoint(provider) {
  return CODEBUDDY_FAMILY_BILLING_ENDPOINTS[normalizeCodebuddyProvider(provider)] || '';
}

// 共享凭据文件的 HOME 相对路径段；'' when not a family provider.
function resolveCodebuddyFamilyAuthPath(provider) {
  return CODEBUDDY_FAMILY_AUTH_PATHS[normalizeCodebuddyProvider(provider)] || null;
}

function matchPrefixLabel(table, packageCode) {
  const code = String(packageCode || '').trim();
  if (!code) return '';
  for (const [prefix, label] of table) {
    if (code.startsWith(prefix)) return label;
  }
  return '';
}

// Packages[].PackageCode → 人可读桶名；未登记时回退 `code_<NNN>`，再不行原样返回。
function resolveCodebuddyCommodityLabel(packageCode) {
  const code = String(packageCode || '').trim();
  if (!code) return '';
  const known = matchPrefixLabel(CODEBUDDY_COMMODITY_LABELS, code);
  if (known) return known;
  const numbered = /^TCACA_code_(\d{3})_/.exec(code);
  return numbered ? `code_${numbered[1]}` : code;
}

// SubscriptionPackageCode → 付费档位名；体验/试用/未登记一律返回 ''。
function resolveCodebuddyPaidPlanLabel(subscriptionPackageCode) {
  return matchPrefixLabel(CODEBUDDY_PAID_PLAN_LABELS, subscriptionPackageCode);
}

module.exports = {
  CODEBUDDY_FAMILY_AUTH_PATHS,
  CODEBUDDY_FAMILY_BILLING_ENDPOINTS,
  CODEBUDDY_FAMILY_PROVIDERS,
  CODEBUDDY_COMMODITY_LABELS,
  CODEBUDDY_PAID_PLAN_LABELS,
  CODEBUDDY_RESOURCE_SUMMARY_PATH,
  isCodebuddyFamilyProvider,
  resolveCodebuddyFamilyAuthPath,
  resolveCodebuddyFamilyBillingEndpoint,
  resolveCodebuddyCommodityLabel,
  resolveCodebuddyPaidPlanLabel
};
