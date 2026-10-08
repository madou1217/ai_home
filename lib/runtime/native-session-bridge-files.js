'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function bridgeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function readPrivateJson(file, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes
      || fs.realpathSync(file) !== path.resolve(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

function ensurePrivateDirectory(directory, errorCode = 'native_session_bridge_directory_not_private') {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== path.resolve(directory)
    || process.platform !== 'win32' && (stat.mode & 0o077)) {
    throw bridgeError(errorCode);
  }
}

function writePrivateJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

module.exports = { bridgeError, readPrivateJson, ensurePrivateDirectory, writePrivateJson, processAlive };
