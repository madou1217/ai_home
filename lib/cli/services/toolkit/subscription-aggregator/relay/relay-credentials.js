'use strict';

const nativeCrypto = require('node:crypto');
const nativeFs = require('node:fs');
const nativePath = require('node:path');
const { atomicWritePrivateFile } = require('../../proxy-pool/secure-file-io');

/**
 * 中转入口的认证凭据。绑非回环地址（手机 / 另一台电脑要连）时**必须有**，否则等于在公网开一个
 * 无认证代理，任何人都能拿你的机器当出口。
 *
 * 顺序：AIH_RELAY_USERNAME / AIH_RELAY_PASSWORD → <runDir>/credentials.json → 生成并落盘（0600）。
 * 落盘是必要的：客户端配置里已经写着这串密码，服务重启后它必须还有效，否则每次重启都要重新拉订阅。
 * 轮换就是删掉这个文件（或改环境变量）后重启 —— 旧配置随即失效。
 */

const USERNAME = 'aih-relay';
const FILE_NAME = 'credentials.json';

function readFileCredentials(fsImpl, filePath) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    const username = String(parsed.username || '').trim();
    const password = String(parsed.password || '').trim();
    return username && password ? { username, password } : null;
  } catch (_error) {
    return null;
  }
}

function resolveRelayCredentials(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const filePath = pathImpl.join(options.runDir, FILE_NAME);
  const envUser = String(env.AIH_RELAY_USERNAME || '').trim();
  const envPassword = String(env.AIH_RELAY_PASSWORD || '').trim();
  if (envUser && envPassword) return { username: envUser, password: envPassword, source: 'env' };
  const fromFile = readFileCredentials(fsImpl, filePath);
  if (fromFile) return { ...fromFile, source: 'file' };
  const random = options.random || (() => nativeCrypto.randomBytes(18).toString('base64url'));
  const generated = { username: USERNAME, password: random() };
  atomicWritePrivateFile(fsImpl, pathImpl, filePath, `${JSON.stringify(generated, null, 2)}\n`, {});
  return { ...generated, source: 'generated' };
}

module.exports = {
  FILE_NAME,
  USERNAME,
  resolveRelayCredentials
};
