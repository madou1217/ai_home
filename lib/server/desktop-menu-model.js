'use strict';

const { isDefaultAccountEligible } = require('./account-default-eligibility');
const {
  getProviderFamily,
  getProviderSite,
  getProviderSiteLabel,
  listProviderFamilies
} = require('../provider-catalog');

const HIDDEN_MENU_PROVIDERS = new Set(['gemini']);
const PROVIDER_LABELS = Object.freeze({
  agy: 'Antigravity',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode'
});

// ---------------------------------------------------------------------------
// 产品族聚合
//
// 国内站与国际站是账号体系互不通的两个 Provider（各自发凭据、各自算默认账号），
// 所以快照里**一个 Provider 一个条目**的开关语义必须原样保留——托盘点击切换时
// 用的就是这里每条的 id。
//
// 但同一产品族在菜单里不应该出现两个平级入口。所以每条额外携带 family 元数据，
// 由托盘把同族条目收进同一个子菜单、用站点标记区分行，而**切换目标仍然是条目
// 自身的 provider id**。这样"展示合并"和"身份隔离"互不干扰。
//
// 兼容性：新增字段是纯附加的，版本号保持 1。旧托盘忽略这些字段，行为与今天完全
// 一致（同族两个条目、按 provider 切换，结果正确）；新托盘才会合并展示。
// ---------------------------------------------------------------------------

/** 产品族聚合信息表：family -> { label, multiSite }。 */
const FAMILY_GROUPS = new Map(
  listProviderFamilies().map((family) => [family.family, family])
);

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(provider) ? provider : '';
}

function normalizeAccountRef(value) {
  const accountRef = String(value || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(accountRef) ? accountRef : '';
}

function normalizeText(value, maxLength = 160) {
  return String(value || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, maxLength);
}

function providerLabel(provider) {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

// familyPresentation 归一化单个 Provider 的族/站点展示元数据。
// 未注册的 Provider（合同里没有）按"单站产品"处理，回退为自身 id。
function familyPresentation(provider) {
  const family = getProviderFamily(provider);
  const group = FAMILY_GROUPS.get(family);
  const multiSite = Boolean(group && group.multiSite);
  const site = getProviderSite(provider);
  return {
    family,
    // 族名取国际站成员的标签（无后缀 = 产品本名）；未知 Provider 无族名。
    familyLabel: group ? group.label : '',
    site,
    // 单站产品不带站点标记：菜单里出现"Codex · 国际站"是零信息量的噪音。
    siteLabel: multiSite ? getProviderSiteLabel(site) : '',
    multiSite
  };
}

function formatRemainingPct(value) {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const clamped = Math.max(0, Math.min(100, numeric));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function buildUsageLabel(account) {
  if (!account || typeof account !== 'object') return '用量未知';
  if (account.authPending === true) return '等待授权';
  if (account.configured !== true) return '未配置';
  if (account.status === 'down') return '已停用';
  const runtimeStatus = normalizeText(account.runtimeStatus, 48);
  if (runtimeStatus && runtimeStatus !== 'healthy') return '账号异常';
  if (account.apiKeyMode === true) return 'API Key';
  const remainingPct = formatRemainingPct(account.remainingPct);
  if (remainingPct) return `剩余 ${remainingPct}%`;
  return '用量未知';
}

function buildAccountLabel(account, accountRef) {
  const label = normalizeText(account && account.displayName)
    || normalizeText(account && account.email);
  return label || `账号 ${accountRef.slice(-6)}`;
}

function buildMenuAccount(account) {
  const provider = normalizeProvider(account && account.provider);
  const accountRef = normalizeAccountRef(account && account.accountRef);
  if (!provider || !accountRef || HIDDEN_MENU_PROVIDERS.has(provider)) return null;
  return {
    accountRef,
    label: buildAccountLabel(account, accountRef),
    usageLabel: buildUsageLabel(account),
    isDefault: account.isDefault === true,
    switchable: isDefaultAccountEligible(account),
    status: account.status === 'down' ? 'down' : 'up'
  };
}

function buildDesktopMenuSnapshot(accounts, options = {}) {
  const providers = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const provider = normalizeProvider(account && account.provider);
    const menuAccount = buildMenuAccount(account);
    if (!provider || !menuAccount) continue;
    if (!providers.has(provider)) {
      const presentation = familyPresentation(provider);
      providers.set(provider, {
        id: provider,
        label: providerLabel(provider),
        family: presentation.family,
        familyLabel: presentation.familyLabel,
        site: presentation.site,
        siteLabel: presentation.siteLabel,
        multiSite: presentation.multiSite,
        accounts: []
      });
    }
    providers.get(provider).accounts.push(menuAccount);
  }

  return {
    version: 1,
    generatedAt: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    providers: Array.from(providers.values())
  };
}

module.exports = {
  buildDesktopMenuSnapshot,
  __private: {
    buildUsageLabel,
    familyPresentation,
    formatRemainingPct,
    normalizeProvider,
    providerLabel
  }
};
