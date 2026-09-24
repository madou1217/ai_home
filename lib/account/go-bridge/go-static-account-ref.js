'use strict';

// Go 静态凭据（API Key / Claude Auth Token）的身份种子与 accountRef，逐条复刻
// core/accounts/codex/api_key.go 与 core/accounts/claude/static.go，
// 由 contracts/go-bridge/static-account-ref-vectors.json 与 Go 测试共同守卫。
//
// Go 与 Node 旧种子的差异正是迁移账本需要 old -> new 映射的原因：
//   Node: api_key:<p>:<去尾斜杠 baseUrl>:<sha256(key) 前 16 位>（baseUrl 可为空）
//   Go:   api_key:<p>:<规范化 baseUrl，缺省官方地址>:<sha256(key) 全 64 位>

const crypto = require('node:crypto');

const GO_DEFAULT_BASE_URLS = Object.freeze({
  codex: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com'
});

const STATIC_KINDS = Object.freeze({
  codex: new Set(['api_key']),
  claude: new Set(['api_key', 'auth_token'])
});

function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

// Go strings.TrimSpace 的 ASCII + Unicode 空白集合。
function goTrimSpace(value) {
  return String(value).replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
}

// Go normalizeAPIBaseURL：只接受 http(s)、无 userinfo/query/fragment/zone，host 小写，
// 省略默认端口，去掉路径末尾斜杠。WHATWG URL 会改写 Go 保留的输入（点段、百分号编码、IDN），
// 这些情况返回 null，由调用方以 Go 实际返回的 accountRef 为准。
function normalizeGoApiBaseUrl(provider, raw) {
  const text = typeof raw === 'string' ? raw : '';
  const value = goTrimSpace(text);
  if (value === '') return GO_DEFAULT_BASE_URLS[provider];
  if (provider === 'claude' && text !== value) return null;
  if (hasControlCharacter(value) || value.includes('#') || value.includes('?')) return null;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(value);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  const authority = match[2];
  if (!authority || authority.includes('@') || authority.includes('%')) return null;
  let hostname;
  let port = '';
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    hostname = authority.slice(1, end).toLowerCase();
    const rest = authority.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      port = rest.slice(1);
      if (port === '') return null;
    }
  } else {
    const colon = authority.lastIndexOf(':');
    hostname = (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();
    if (colon >= 0) {
      port = authority.slice(colon + 1);
      if (port === '') return null;
    }
    if (hostname.includes(':')) return null;
  }
  if (!hostname || !/^[a-z0-9.\-_:]+$/.test(hostname)) return null;
  if (port) {
    if (!/^\d+$/.test(port)) return null;
    const portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65535) return null;
    port = String(portNumber);
  }
  if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')) port = '';
  const path = match[3] || '';
  // Go 使用 EscapedPath：只接受无需重新编码的路径字符，避免两端编码分歧。
  if (path && !/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(path)) return null;
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return null;
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `${scheme}://${host}${port ? `:${port}` : ''}${path.replace(/\/+$/, '')}`;
}

// Go requireSecret：非空、已修剪、无控制字符。
function isValidGoSecret(secret) {
  return typeof secret === 'string' && secret !== '' && secret === goTrimSpace(secret) && !hasControlCharacter(secret);
}

function goAccountRefFromSeed(seed) {
  return `acct_${crypto.createHash('sha256').update(`unique:${seed}`).digest('hex').slice(0, 20)}`;
}

/**
 * @returns {{seed: string, accountRef: string, baseUrl: string} | null} null 表示 Go 会拒绝或本端无法精确复刻。
 */
function goStaticAccountIdentity(provider, kind, secret, baseUrl) {
  if (!STATIC_KINDS[provider] || !STATIC_KINDS[provider].has(kind)) return null;
  if (!isValidGoSecret(secret)) return null;
  const normalized = normalizeGoApiBaseUrl(provider, baseUrl);
  if (!normalized) return null;
  const fingerprint = crypto.createHash('sha256').update(secret).digest('hex');
  const seed = `${kind}:${provider}:${normalized}:${fingerprint}`;
  return { seed, accountRef: goAccountRefFromSeed(seed), baseUrl: normalized };
}

module.exports = {
  GO_DEFAULT_BASE_URLS,
  goAccountRefFromSeed,
  goStaticAccountIdentity,
  normalizeGoApiBaseUrl
};
