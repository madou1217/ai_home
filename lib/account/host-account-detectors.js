'use strict';

const { detectHostFamilyAccounts } = require('./codebuddy-credential-sync');
const { detectHostClineAccounts } = require('./cline-native-credential-sync');
const { FAMILY_PROVIDERS: CODEBUDDY_FAMILY_PROVIDERS } = require('../runtime/codebuddy-family-layouts');
const genericDetectors = require('./host-generic-detectors');

/**
 * 「本机已登录账号」发现（WebUI 的「扫描本机账号」按钮 / `aih <cli> detect`）的**检测器注册表**。
 *
 * 每个检测器声明自己覆盖哪些 provider，并把扫描结果归一成同一份形状
 * （`{ ok, scanned, updated, reloaded, registered, skipped, accounts }`）。于是新增一个
 * 「宿主登录态能自动入库」的 provider 只需在这里加一条，而不是在 WebUI 路由和 CLI 命令里
 * 各长一个 `if (provider === 'x')`——两边读的是同一份能力表。
 *
 * 与检测器一一对应的后台周期同步在 `token-refresh-daemon` 里启动（自动入库的主链路）；
 * 这里的按需扫描只是「不等下一轮、当场看结果」的同一个 scan()。
 */
const HOST_ACCOUNT_DETECTORS = Object.freeze([
  Object.freeze({
    id: 'codebuddy-family',
    providers: CODEBUDDY_FAMILY_PROVIDERS,
    detect: options => detectHostFamilyAccounts(options)
  }),
  Object.freeze({
    id: 'cline',
    providers: Object.freeze(['cline']),
    detect: options => detectHostClineAccounts(options)
  }),
  // 通用检测器：覆盖面由注册表倒排（认证来源的 scan 钩子 / 凭据端口的 hostApiKeySlots），
  // 新增 provider 只要声明就自动进扫描，这里不改。
  Object.freeze({
    id: 'host-auth-projection',
    get providers() { return genericDetectors.listProjectionProviders(); },
    detect: options => genericDetectors.detectHostProjectionAccounts(options)
  }),
  Object.freeze({
    id: 'host-api-key',
    get providers() { return genericDetectors.listApiKeyProviders(); },
    detect: options => genericDetectors.detectHostApiKeyAccounts(options)
  })
]);

/** 支持本机账号扫描的 provider 列表（界面/命令的提示文案用它，不写死字符串）。 */
function hostAccountDetectionProviders() {
  return [...new Set(HOST_ACCOUNT_DETECTORS.flatMap(detector => detector.providers))];
}

function isHostAccountDetectionSupported(provider) {
  const normalized = String(provider || '').trim();
  return HOST_ACCOUNT_DETECTORS.some(detector => detector.providers.includes(normalized));
}

/**
 * 逐个跑检测器并合并结果（`detectors` 可注入：测试用它覆盖部分失败 / 异常形状）。
 *
 * - 单个检测器抛错/不可用 → 记一条 skip，其它检测器照常出结果（一个 provider 的宿主
 *   文件损坏不该让整次扫描失败），失败原因保持可观察。
 * - 全部检测器都跑不起来（缺 fs / aiHomeDir / hostHomeDir）→ `ok: false`，由调用方
 *   转成错误，而不是伪装成「扫过了但什么都没发现」。
 */
function runHostAccountDetectors(detectors, options = {}) {
  const merged = {
    ok: true,
    scanned: 0,
    updated: 0,
    reloaded: false,
    registered: [],
    skipped: [],
    accounts: {}
  };
  let completed = 0;
  for (const detector of detectors) {
    let result = null;
    try {
      result = detector.detect(options);
    } catch (_) {
      merged.skipped.push({ reason: 'host_account_detector_failed', provider: detector.providers[0], source: detector.id });
      continue;
    }
    if (!result || result.ok !== true) {
      merged.skipped.push({
        reason: (result && result.error) || 'host_account_detector_unavailable',
        provider: detector.providers[0],
        source: detector.id
      });
      continue;
    }
    completed += 1;
    merged.scanned += Number(result.scanned || 0);
    merged.updated += Number(result.updated || 0);
    merged.reloaded = merged.reloaded || result.reloaded === true;
    merged.registered.push(...(result.registered || []));
    merged.skipped.push(...(result.skipped || []));
    for (const [provider, count] of Object.entries(result.accounts || {})) {
      merged.accounts[provider] = Number(count || 0);
    }
  }
  if (!completed) return { ...merged, ok: false, error: 'detect_host_accounts_unavailable' };
  return merged;
}

function detectHostAccounts(options = {}) {
  return runHostAccountDetectors(HOST_ACCOUNT_DETECTORS, options);
}

module.exports = {
  HOST_ACCOUNT_DETECTORS,
  detectHostAccounts,
  hostAccountDetectionProviders,
  isHostAccountDetectionSupported,
  runHostAccountDetectors
};
