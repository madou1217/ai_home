'use strict';

const nodePath = require('node:path');
const {
  findExistingAccountByNativeAuthIdentity,
  readProviderAuthProjection
} = require('../account/native-auth-projection');
const { hasUsableKimiOAuth } = require('../account/kimi-auth');

// Scanned wire.jsonl files carry no account identity of their own; the owning
// .kimi-code home's OAuth credentials expose a stable user_id, so attribution
// reuses registration-time identity matching. Deriving the ref directly from
// the identity seed is not possible because legacy accounts predate stable
// user identity seeds and keep their token-hash accountRef.
function createKimiUsageAccountRefResolver({ fs, path: pathImpl, aiHomeDir } = {}) {
  const path = pathImpl || nodePath;
  const homeDir = String(aiHomeDir || '').trim();
  if (!fs || !homeDir) return null;
  const cache = new Map();
  return function resolveKimiUsageAccountRef(runtimeDir) {
    const dir = String(runtimeDir || '').trim();
    if (!dir) return '';
    let credentialsMtimeMs = 0;
    try {
      credentialsMtimeMs = Number(
        fs.statSync(path.join(dir, '.kimi-code', 'credentials', 'kimi-code.json')).mtimeMs
      ) || 0;
    } catch (_error) {}
    const cacheKey = `${dir}:${credentialsMtimeMs}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let accountRef = '';
    try {
      const projection = readProviderAuthProjection(fs, dir, 'kimi', { path });
      const credentials = projection && projection.credentials;
      if (hasUsableKimiOAuth(credentials)) {
        const match = findExistingAccountByNativeAuthIdentity(fs, homeDir, 'kimi', { credentials });
        accountRef = match ? String(match.accountRef || '').trim() : '';
      }
    } catch (_error) {
      accountRef = '';
    }
    cache.set(cacheKey, accountRef);
    return accountRef;
  };
}

module.exports = {
  createKimiUsageAccountRefResolver
};
