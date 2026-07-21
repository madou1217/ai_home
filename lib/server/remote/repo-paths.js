'use strict';

const os = require('node:os');
const path = require('node:path');

const FALLBACK_REPO_SUBDIR = 'ai_home';

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeRepoSubdir(value) {
  const text = normalizeText(value, 512).replace(/\\/g, '/');
  if (!text || text.startsWith('/') || /^[a-zA-Z]:\//.test(text)) return '';
  const parts = text.split('/').filter(Boolean);
  const normalized = [];
  for (const part of parts) {
    const segment = part
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!segment || segment === '.' || segment === '..') return '';
    normalized.push(segment);
  }
  return normalized.join('/');
}

function getDefaultRepoSubdir(value) {
  return normalizeRepoSubdir(value) || FALLBACK_REPO_SUBDIR;
}

function resolveRepoSubdir(deps = {}) {
  const explicit = normalizeRepoSubdir(typeof deps.repoSubdir === 'function' ? deps.repoSubdir() : deps.repoSubdir);
  if (explicit) return explicit;

  const cwd = normalizeText(typeof deps.cwd === 'function' ? deps.cwd() : deps.cwd, 1024) || process.cwd();
  const homeDir = normalizeText(typeof deps.homeDir === 'function' ? deps.homeDir() : deps.homeDir, 1024) || os.homedir();
  if (!cwd || !homeDir) return '';

  try {
    const relative = path.relative(homeDir, cwd);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
    return normalizeRepoSubdir(relative);
  } catch (_error) {
    return '';
  }
}

function toWindowsRepoSubdir(value) {
  return getDefaultRepoSubdir(value).replace(/\//g, '\\');
}

module.exports = {
  FALLBACK_REPO_SUBDIR,
  getDefaultRepoSubdir,
  normalizeRepoSubdir,
  resolveRepoSubdir,
  toWindowsRepoSubdir
};
