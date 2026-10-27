import type { Account, Provider } from '@/types';

// 内部合成展示名（例如 codex-1、claude-2）不出现在 UI 上，展示层统一回落为
// 真实的身份标签；这里按 Provider 前缀枚举，新增 Provider 需同步补进来。
const INTERNAL_ACCOUNT_LABEL_RE = /^(agy|codex|gemini|claude|opencode|grok|qoder|qodercn|kimi|kiro|zcode|codebuddy|codebuddycn|workbuddy)-\d+$/i;
const OPAQUE_UUID_LABEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// API Key 账号缺少 baseUrl 时的展示回落（裸域名，与 getBaseDomain 的输出口径一致）。
// 该映射是 Record<Provider, string>，必须覆盖全部 Provider，否则会在全量 TS
// 编译（npm run build）中报 TS2739；zcode / codebuddy 之前缺失，且因为 Umi 构建
// 走 transpile-only 才没有暴露。
const DEFAULT_API_KEY_DOMAINS: Record<Provider, string> = {
  codex: 'api.openai.com',
  claude: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com',
  agy: 'daily-cloudcode-pa.googleapis.com',
  opencode: 'opencode.ai',
  grok: 'api.x.ai',
  qoder: 'qoder.com',
  qodercn: 'qoder.com.cn',
  kimi: 'api.moonshot.cn',
  kiro: 'kiro.dev',
  zcode: 'z.ai',
  // CodeBuddy Code 的接口默认指向平台自身；未设置 CODEBUDDY_INTERNET_ENVIRONMENT
  // 时官方默认是海外站（www.codebuddy.ai），国内站/内网 iOA 由账号 env 覆盖。
  codebuddy: 'codebuddy.ai',
  // 国内站是独立 Provider（账号体系不互通），官方入口是 copilot.tencent.com；
  // 同族的 WorkBuddy 走 workbuddy.cn。
  codebuddycn: 'copilot.tencent.com',
  workbuddy: 'workbuddy.cn'
};

export function isInternalAccountLabel(value?: string) {
  const normalized = String(value || '').trim();
  return INTERNAL_ACCOUNT_LABEL_RE.test(normalized) || OPAQUE_UUID_LABEL_RE.test(normalized);
}

// z.ai 给手机号账号合成的**内部邮箱后缀**：`<phone>@phone.local`。
// 它在界面上一无意义（不是真实可收信的域名），展示时整段去掉，只留手机号本身。
const PHONE_LOCAL_SUFFIX_RE = /@phone\.local$/i;
// 手机号类身份（`<phone>@phone.local`、裸手机号、带区号手机号）。
const PHONE_LOCAL_EMAIL_RE = /^\+?[\d\s-]{5,}@phone\.local$/i;
const BARE_PHONE_RE = /^\+?\d[\d\s-]{6,}\d$/;

/** 手机号脱敏：`18997991630` → `189****1630`。 */
function maskPhoneDigits(digits: string) {
  return digits.length > 7
    ? `${digits.slice(0, 3)}****${digits.slice(-4)}`
    : `${digits.slice(0, 3)}****`;
}

/**
 * **展示用**身份脱敏。目的：账号列表会被截图分享，原始邮箱/手机号不应直接暴露；
 * 而复制按钮（onCopy）读的是账号记录里的**原始值**，不受这里影响。
 *
 * 规则：
 *   * 手机号类（含 `@phone.local` 合成邮箱）→ `189****1630`，并**去掉
 *     `@phone.local` 后缀**（它没有意义，留着只是噪音）；
 *   * 普通邮箱 → 本地部分脱敏（`madou1217@126.com` → `ma****17@126.com`），
 *     域名保留（域名是服务商信息，不是隐私，且有助于辨认）；
 *   * 其它值原样返回。
 */
export function maskPhoneIdentity(value?: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  // 1) 手机号类：`18997991630@phone.local` / 裸手机号。
  if (PHONE_LOCAL_EMAIL_RE.test(raw) || BARE_PHONE_RE.test(raw)) {
    const digits = raw.replace(PHONE_LOCAL_SUFFIX_RE, '');
    return digits.replace(/\d{7,}/g, maskPhoneDigits);
  }

  // 2) 上游**已经打码**的邮箱（bigmodel 侧返回 `ma****17@126.com`）原样保留：
  //    再打一次会变成 `ma****26@126.com`，比原文更难辨认。
  if (isMaskedEmail(raw)) return raw;

  // 3) 普通邮箱：本地部分脱敏，域名保留��
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const local = raw.slice(0, at);
    const domain = raw.slice(at + 1);
    if (local && domain) return `${maskLocalPart(local)}@${domain}`;
  }

  return raw;
}

/**
 * 邮箱本地部分脱敏：保留首 2 位与末 2 位，中间打码。
 * 太短（≤4）时只保留首位，避免打码后长度反而暴露原文。
 */
function maskLocalPart(local: string) {
  const value = String(local || '');
  if (value.length <= 2) return `${value.slice(0, 1)}****`;
  if (value.length <= 4) return `${value.slice(0, 1)}****${value.slice(-1)}`;
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/**
 * 上游已打码的邮箱原样保留（例如 bigmodel 侧返回的 `ma****17@126.com`）：
 * 再打一次会变成 `ma****26@126.com` 这种更难认的形式。识别方式是本地部分已含 `*`。
 */
export function isMaskedEmail(value?: string) {
  const raw = String(value || '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return false;
  return raw.slice(0, at).includes('*');
}

export function getBaseDomain(value?: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.host.replace(/^www\./i, '');
  } catch (_error) {
    return raw
      .replace(/^[a-z]+:\/\//i, '')
      .split(/[/?#]/, 1)[0]
      .replace(/^www\./i, '');
  }
}

function getCleanDisplayName(account: Pick<Account, 'displayName'>) {
  const displayName = String(account.displayName || '').trim();
  if (!displayName || displayName === 'Unknown') return '';
  if (isInternalAccountLabel(displayName)) return '';
  if (/^api key/i.test(displayName)) return '';
  if (/^access token/i.test(displayName)) return '';
  return displayName;
}

export function getAccountIdentityLabel(account: Pick<Account, 'provider' | 'email' | 'displayName' | 'configured' | 'apiKeyMode' | 'baseUrl' | 'authPendingStale'>) {
  const displayName = getCleanDisplayName(account);

  if (account.apiKeyMode) {
    // 若存在带指纹的 displayName（例如 "OpenCode Go API (...K9sw)" 或自定义名称），优先展示该名称
    if (displayName) {
      return displayName;
    }
    return getBaseDomain(account.baseUrl) || DEFAULT_API_KEY_DOMAINS[account.provider] || 'API Key';
  }

  const email = String(account.email || '').trim();
  if (email && !isInternalAccountLabel(email)) return maskPhoneIdentity(email);

  if (displayName) return maskPhoneIdentity(displayName);

  if (!account.configured && account.authPendingStale) return 'OAuth 授权超时';
  return account.configured ? '账号待识别' : 'OAuth 授权中';
}

export function getAccountSecondaryIdentity(account: Pick<Account, 'provider' | 'email' | 'displayName' | 'apiKeyMode' | 'baseUrl'>) {
  const email = String(account.email || '').trim();
  const displayName = getCleanDisplayName(account);

  if (account.apiKeyMode) {
    // API Key 模式下，主标题若显示了名称，副标题展示其端点域名/URL
    if (displayName) {
      const domain = getBaseDomain(account.baseUrl) || (account.provider ? DEFAULT_API_KEY_DOMAINS[account.provider as Provider] : '');
      return domain && domain !== displayName ? domain : '';
    }
    return '';
  }

  // 副标题只在主标题显示邮箱时补充名称；没有邮箱时主标题本身就是名称，再显示一遍就重复了。
  if (!email || isInternalAccountLabel(email) || !displayName || displayName === email) return '';
  return maskPhoneIdentity(displayName);
}
