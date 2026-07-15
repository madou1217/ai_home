'use strict';

const {
  resolveAccountRuntimeDir,
  resolveLoginRuntimeDir
} = require('../../../runtime/aih-storage-layout');

function createProfileLayoutService(options = {}) {
  const {
    fs,
    aiHomeDir,
    hostHomeDir
  } = options;

  function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function getAccountRuntimeDir(provider, accountRef) {
    return resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  }

  function getGatewayRuntimeDir() {
    return String(hostHomeDir || '').trim();
  }

  function getLoginRuntimeDir(provider, sessionId) {
    return resolveLoginRuntimeDir(aiHomeDir, provider, sessionId);
  }

  function getProfileDir(provider, accountRef, runtime = {}) {
    if (runtime.gateway === true) return getGatewayRuntimeDir();
    if (String(provider || '').trim().toLowerCase() === 'claude') return getGatewayRuntimeDir();
    return getAccountRuntimeDir(provider, accountRef);
  }

  return {
    ensureDir,
    getAccountRuntimeDir,
    getGatewayRuntimeDir,
    getLoginRuntimeDir,
    getProfileDir
  };
}

module.exports = {
  createProfileLayoutService
};
