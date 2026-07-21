'use strict';

const fs = require('node:fs');

function managementKeyFromEnv(env = process.env) {
  return String(env.AIH_MANAGEMENT_KEY || '').trim();
}

function readManagementKey(options = {}, deps = {}) {
  const file = String(options.managementKeyFile || '').trim();
  if (file) {
    const readFileSync = deps.readFileSync || (deps.fs && deps.fs.readFileSync) || fs.readFileSync;
    return String(readFileSync(file, 'utf8') || '').trim();
  }
  const inline = String(options.managementKey || '').trim();
  if (inline) return inline;
  throw new Error(
    'missing Management Key: set AIH_MANAGEMENT_KEY, pass --management-key, or pass --management-key-file'
  );
}

module.exports = {
  managementKeyFromEnv,
  readManagementKey
};
