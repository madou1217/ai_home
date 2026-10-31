'use strict';

// 主机指纹固定（TOFU：首次信任，之后锁定）。
//
// 第一次连某台远端时记下它的主机公钥 sha256 指纹；以后指纹变化一律拒绝连接（可能是中间人，
// 也可能是远端重装）。重装后需要用户在 SSH 开发机里显式「重新信任」（forget）。
// 存在 app-state（ssh_known_hosts 键），与 SSH 连接配置同库，按 host:port 区分。

const crypto = require('node:crypto');
const { readJsonValue, writeJsonValue } = require('../../server/app-state-store');
const { remoteError } = require('../errors');

const STORE_KEY = 'ssh_known_hosts';

function fingerprintOf(hostKey) {
  return `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
}

function hostId(host, port) {
  return `${String(host).toLowerCase()}:${Number(port) || 22}`;
}

class HostKeyStore {
  constructor({ fs, aiHomeDir, now } = {}) {
    this.fs = fs;
    this.aiHomeDir = aiHomeDir;
    this.now = now || Date.now;
  }

  readAll() {
    const value = readJsonValue(this.fs, this.aiHomeDir, STORE_KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  /**
   * ssh2 的 hostVerifier：同步返回 true/false。首次见到的指纹落库并放行；不一致拒绝，
   * 并把不一致的事实记在 lastMismatch 上供连接层报出 host_key_mismatch。
   */
  verifier(host, port) {
    const id = hostId(host, port);
    const self = this;
    const verify = (hostKey) => {
      const fingerprint = fingerprintOf(hostKey);
      const all = self.readAll();
      const known = all[id];
      if (!known) {
        all[id] = { fingerprint, firstSeenAt: self.now() };
        writeJsonValue(self.fs, self.aiHomeDir, STORE_KEY, all);
        verify.trusted = 'first_use';
        return true;
      }
      if (known.fingerprint === fingerprint) {
        verify.trusted = 'known';
        return true;
      }
      verify.mismatch = { expected: known.fingerprint, actual: fingerprint };
      return false;
    };
    return verify;
  }

  mismatchError(verify, host, port) {
    return remoteError('host_key_mismatch',
      `远端 ${hostId(host, port)} 的主机指纹变了（可能被中间人或远端重装）。确认安全后在 SSH 开发机里重新信任。`,
      verify && verify.mismatch);
  }

  forget(host, port) {
    const all = this.readAll();
    delete all[hostId(host, port)];
    writeJsonValue(this.fs, this.aiHomeDir, STORE_KEY, all);
  }

  get(host, port) {
    return this.readAll()[hostId(host, port)] || null;
  }
}

module.exports = { HostKeyStore, fingerprintOf, hostId };
