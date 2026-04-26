'use strict';

const path = require('node:path');

function normalizeAccountStatusValue(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'down' || value === 'disabled') return 'down';
  if (value === 'up' || value === 'enabled') return 'up';
  return '';
}

function getAccountStatusFilePath(profileDir) {
  const baseDir = String(profileDir || '').trim();
  if (!baseDir) return '';
  return path.join(baseDir, '.aih_status');
}

function readAccountStatusFile(fs, profileDir) {
  const filePath = getAccountStatusFilePath(profileDir);
  if (!filePath || !fs || typeof fs.existsSync !== 'function' || !fs.existsSync(filePath)) {
    return '';
  }
  try {
    const value = fs.readFileSync(filePath, 'utf8');
    return normalizeAccountStatusValue(value);
  } catch (_error) {
    return '';
  }
}

function writeAccountStatusFile(fs, profileDir, status) {
  const normalizedStatus = normalizeAccountStatusValue(status);
  const filePath = getAccountStatusFilePath(profileDir);
  if (!normalizedStatus || !filePath || !fs) return false;
  try {
    if (typeof fs.mkdirSync === 'function') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(filePath, `${normalizedStatus}\n`, 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveEffectiveAccountStatus(persistedStatus, fileStatus) {
  const normalizedFileStatus = normalizeAccountStatusValue(fileStatus);
  if (normalizedFileStatus) return normalizedFileStatus;
  const normalizedPersistedStatus = normalizeAccountStatusValue(persistedStatus);
  return normalizedPersistedStatus || 'up';
}

module.exports = {
  normalizeAccountStatusValue,
  getAccountStatusFilePath,
  readAccountStatusFile,
  writeAccountStatusFile,
  resolveEffectiveAccountStatus
};
