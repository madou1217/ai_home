'use strict';

function collectCredentialRelativePaths(provider) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider) return [];
  const hiddenDir = normalizedProvider === 'agy' ? '.gemini' : `.${normalizedProvider}`;
  const paths = [
    `${hiddenDir}/auth.json`,
    `${hiddenDir}/oauth_creds.json`,
    `${hiddenDir}/oauth.json`,
    `${hiddenDir}/token.json`,
    `${hiddenDir}/tokens.json`,
    `${hiddenDir}/credentials.json`,
    `${hiddenDir}/.credentials.json`,
    `${hiddenDir}/settings.json`,
    `${hiddenDir}/google_accounts.json`
  ];
  if (normalizedProvider === 'agy') {
    paths.push(`${hiddenDir}/antigravity-cli/antigravity-oauth-token`);
    paths.push(`${hiddenDir}/antigravity-cli/email.cache`);
  }
  if (normalizedProvider === 'opencode') {
    paths.push('.local/share/opencode/auth.json');
  }
  if (normalizedProvider === 'kimi') {
    paths.push('.kimi-code/credentials/kimi-code.json');
    // Also accept Kimi's native home itself as an import source. The normal
    // AIH account layout keeps the same file below <account>/.kimi-code/.
    paths.push('credentials/kimi-code.json');
  }
  if (normalizedProvider === 'qoder') {
    paths.push('qoder-cli-credentials.json');
    paths.push('.keychain-salt');
  }
  if (normalizedProvider === 'qodercn') {
    paths.push('qoder-cli-cn-credentials.json');
    paths.push('.keychain-salt');
  }
  if (normalizedProvider === 'zcode') {
    paths.push('.zcode/v2/credentials.json');
    paths.push('.zcode/v2/config.json');
    // Also accept the provider native root itself (~/.zcode), matching the
    // AIH account layout <account>/.zcode/v2/....
    paths.push('v2/credentials.json');
    paths.push('v2/config.json');
  }
  return Array.from(new Set(paths));
}

module.exports = {
  collectCredentialRelativePaths
};
