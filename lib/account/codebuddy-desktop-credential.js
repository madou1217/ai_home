'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// IDE 的 SecretStorage 会独立续期，不保证同时更新独立 CLI 的共享 .info。
// 只读官方 Electron 登录仓；站点与身份校验仍由 credential-source 统一负责。
const DESKTOP_NAMES = Object.freeze({ codebuddy: 'CodeBuddy', codebuddycn: 'CodeBuddy CN' });
const AUTH_SECRET_KEY = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessToken"}';
const MAX_SECRET_BYTES = 1024 * 1024;
const decryptedCredentials = new Map();

function readEncryptedCredential(fs, file, DatabaseSync) {
  let db;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ? AND length(value) <= ?')
      .get(AUTH_SECRET_KEY, MAX_SECRET_BYTES);
    const value = row && JSON.parse(String(row.value));
    if (value?.type !== 'Buffer' || !Array.isArray(value.data) || value.data.length > MAX_SECRET_BYTES) return null;
    if (!value.data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return null;
    const encrypted = Buffer.from(value.data);
    return encrypted.length > 3 && encrypted.subarray(0, 3).equals(Buffer.from('v10')) ? encrypted : null;
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

function decryptCredential(encrypted, service, run) {
  let output, password, key, plaintext;
  try {
    output = run('/usr/bin/security', ['find-generic-password', '-w', '-s', service], {
      encoding: null, timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
    output = Buffer.isBuffer(output) ? output : Buffer.from(output || '');
    let end = output.length;
    while (end > 0 && (output[end - 1] === 10 || output[end - 1] === 13)) end -= 1;
    if (!end) return null;
    password = Buffer.from(output.subarray(0, end));
    key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8'));
    if (!value?.account || !value?.auth) return null;
    return { account: value.account, auth: value.auth, ...(Array.isArray(value.accounts) ? { accounts: value.accounts } : {}) };
  } catch (_) {
    return null;
  } finally {
    for (const buffer of [output, password, key, plaintext]) buffer?.fill(0);
  }
}

function readCodebuddyDesktopCredential(fs, home, provider, options = {}) {
  const name = DESKTOP_NAMES[provider];
  if (!name || !home || (options.platform || process.platform) !== 'darwin') return null;
  let DatabaseSync;
  try { DatabaseSync = options.DatabaseSync || require('node:sqlite').DatabaseSync; } catch (_) { return null; }
  const run = options.execFileSync || execFileSync;
  const userDataDirs = [
    path.join(home, 'electron-user-data'),
    path.join(home, 'Library', 'Application Support', name)
  ];
  for (const userDataDir of userDataDirs) {
    const file = path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
    const encrypted = readEncryptedCredential(fs, file, DatabaseSync);
    if (!encrypted) continue;
    try {
      const fingerprint = crypto.createHash('sha256').update(encrypted).digest('hex');
      const cached = decryptedCredentials.get(file);
      if (cached?.fingerprint === fingerprint && cached.run === run) return cached.credential;
      const credential = decryptCredential(encrypted, `${name} Safe Storage`, run);
      if (!credential) continue;
      decryptedCredentials.delete(file);
      decryptedCredentials.set(file, { fingerprint, run, credential });
      if (decryptedCredentials.size > 32) decryptedCredentials.delete(decryptedCredentials.keys().next().value);
      return credential;
    } finally {
      encrypted.fill(0);
    }
  }
  return null;
}

module.exports = { readCodebuddyDesktopCredential };
