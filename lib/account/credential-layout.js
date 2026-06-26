'use strict';

function collectCredentialRelativePaths(provider) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider) return [];
  const hiddenDir = normalizedProvider === 'agy' ? '.gemini' : `.${normalizedProvider}`;
  const paths = [
    '.aih_env.json',
    '.aih_transfer.json',
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
  return Array.from(new Set(paths));
}

module.exports = {
  collectCredentialRelativePaths
};
