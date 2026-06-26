'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fsBase = require('node:fs');
const { validateImageBuffer } = require('./image-data');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SSH_CLIP_ROOT_DIR = path.join(os.tmpdir(), 'aih-ssh-clip');

function normalizeString(value) {
  return String(value == null ? '' : value).trim();
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function sanitizeKey(value) {
  const cleaned = normalizeString(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'default';
}

function buildSshClipboardSessionKey(options = {}) {
  const env = options.env || {};
  const tty = normalizeString(env.SSH_TTY || env.SSH_CONNECTION || env.TTY);
  const cwd = normalizeString(options.cwd);
  const provider = normalizeString(options.provider);
  const accountId = normalizeString(options.accountId);
  const pid = normalizeString(options.pid);
  return sanitizeKey([
    tty || `pid-${pid || 'unknown'}`,
    provider,
    accountId,
    shortHash(cwd || process.cwd())
  ].filter(Boolean).join('-'));
}

function ensureDirSync(fsImpl, dir) {
  fsImpl.mkdirSync(dir, { recursive: true });
}

function safeStatMtime(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).mtimeMs || 0;
  } catch (_error) {
    return 0;
  }
}

function createInboxError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isSafeInjectableImagePath(fsImpl, rootDir, filePath) {
  const target = normalizeString(filePath);
  if (!target || /[\r\n\0]/.test(target) || !path.isAbsolute(target)) return false;
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) return false;
  if (!/\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/i.test(resolvedTarget)) return false;
  try {
    return fsImpl.existsSync(resolvedTarget) && fsImpl.statSync(resolvedTarget).isFile();
  } catch (_error) {
    return false;
  }
}

function listImageFiles(fsImpl, rootDir) {
  try {
    return fsImpl.readdirSync(rootDir)
      .filter((name) => /^aih_clip_\d+_[a-f0-9]{12}\.(?:png|jpg|webp|gif|bmp|tiff?)$/i.test(String(name || '')))
      .map((name) => path.join(rootDir, name))
      .sort((a, b) => safeStatMtime(fsImpl, b) - safeStatMtime(fsImpl, a));
  } catch (_error) {
    return [];
  }
}

function cleanupInbox(fsImpl, rootDir, options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const maxItems = Math.max(1, Number(options.maxItems) || DEFAULT_MAX_ITEMS);
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const files = listImageFiles(fsImpl, rootDir);
  files.forEach((filePath, index) => {
    const stale = now - safeStatMtime(fsImpl, filePath) > ttlMs;
    if (!stale && index < maxItems) return;
    try { fsImpl.unlinkSync(filePath); } catch (_error) {}
  });
}

function createSshClipboardInbox(options = {}) {
  const fsImpl = options.fs || fsBase;
  const rootBase = normalizeString(options.rootDir) || SSH_CLIP_ROOT_DIR;
  const sessionKey = sanitizeKey(options.sessionKey || 'default');
  const rootDir = path.join(rootBase, sessionKey);
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const maxItems = Math.max(1, Number(options.maxItems) || DEFAULT_MAX_ITEMS);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  function persistImage(image = {}) {
    const buffer = Buffer.isBuffer(image.buffer) ? image.buffer : Buffer.alloc(0);
    const info = validateImageBuffer(buffer, {
      mimeType: image.mimeType,
      maxBytes
    });
    ensureDirSync(fsImpl, rootDir);
    cleanupInbox(fsImpl, rootDir, { ttlMs, maxItems, now });

    const stamp = Math.max(0, Math.floor(now()));
    const fileName = `aih_clip_${stamp}_${info.sha256.slice(0, 12)}.${info.extension}`;
    const filePath = path.join(rootDir, fileName);
    fsImpl.writeFileSync(filePath, buffer);
    cleanupInbox(fsImpl, rootDir, { ttlMs, maxItems, now });
    return {
      filePath,
      mimeType: info.mimeType,
      sha256: info.sha256,
      byteLength: info.byteLength
    };
  }

  function latestImagePath() {
    cleanupInbox(fsImpl, rootDir, { ttlMs, maxItems, now });
    const latest = listImageFiles(fsImpl, rootDir)
      .find((filePath) => isSafeInjectableImagePath(fsImpl, rootDir, filePath));
    return latest || '';
  }

  function assertSafeImagePath(filePath) {
    if (!isSafeInjectableImagePath(fsImpl, rootDir, filePath)) {
      throw createInboxError('ssh_clip_unsafe_image_path');
    }
    return path.resolve(filePath);
  }

  return {
    rootDir,
    sessionKey,
    persistImage,
    latestImagePath,
    cleanup: () => cleanupInbox(fsImpl, rootDir, { ttlMs, maxItems, now }),
    assertSafeImagePath
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ITEMS,
  DEFAULT_TTL_MS,
  SSH_CLIP_ROOT_DIR,
  buildSshClipboardSessionKey,
  createSshClipboardInbox,
  isSafeInjectableImagePath
};
