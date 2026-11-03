'use strict';

// Go 原生导入只接受已物化凭据；Node 快照继续沿用 ZCode 的宿主加密格式。
const {
  decryptZcodeCredentialRecord,
  encryptZcodeCredentialValue,
  isEncryptedZcodeCredentialValue
} = require('../zcode-credential');

function materializeZcodeNativeAuth(nativeAuth) {
  const credentials = nativeAuth && nativeAuth.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null;
  const plain = decryptZcodeCredentialRecord(credentials);
  if (Object.keys(credentials).some((key) => isEncryptedZcodeCredentialValue(credentials[key]) && !plain[key])) return null;
  return { ...nativeAuth, credentials: plain };
}

function preserveZcodeNativeEncoding(nativeAuth, incoming) {
  const previous = nativeAuth.credentials;
  if (!Object.values(previous).some(isEncryptedZcodeCredentialValue)) return incoming;
  const plain = decryptZcodeCredentialRecord(previous);
  const credentials = Object.fromEntries(Object.entries(incoming.credentials).map(([key, value]) => [
    key,
    plain[key] === value && isEncryptedZcodeCredentialValue(previous[key])
      ? previous[key]
      : (typeof value === 'string' ? encryptZcodeCredentialValue(value) : value)
  ]));
  return { ...incoming, credentials };
}

module.exports = { materializeZcodeNativeAuth, preserveZcodeNativeEncoding };
