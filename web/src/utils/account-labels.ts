import type { Account, Provider } from '@/types';

// 内部合成展示名（例如 codex-1、claude-2）不出现在 UI 上，展示层统一回落为
// 真实的身份标签；这里按 Provider 前缀枚举，新增 Provider 需同步补进来。
const INTERNAL_ACCOUNT_LABEL_RE = /^(agy|codex|gemini|claude|opencode|grok|qoder|qodercn|kimi|kiro|zcode|codebuddy|codebuddycn|workbuddy)-\d+$/i;
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
  return INTERNAL_ACCOUNT_LABEL_RE.test(String(value || '').trim());
}

// 手机号类身份（z.ai 合成的 <phone>@phone.local、裸手机号/带区号手机号）在展示层
// 脱敏为 189****1630 形式，避免截图泄露；复制等逻辑仍使用原始值。
const PHONE_LOCAL_EMAIL_RE = /^\+?[\d\s-]{5,}@phone\.local$/i;
const BARE_PHONE_RE = /^\+?\d[\d\s-]{6,}\d$/;

export function maskPhoneIdentity(value?: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!PHONE_LOCAL_EMAIL_RE.test(raw) && !BARE_PHONE_RE.test(raw)) return raw;
  return raw.replace(/\d{7,}/g, (digits) =>
    digits.length > 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : `${digits.slice(0, 3)}****`
  );
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
  if (email) return maskPhoneIdentity(email);

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

  if (!displayName || displayName === email) return '';
  return maskPhoneIdentity(displayName);
}
