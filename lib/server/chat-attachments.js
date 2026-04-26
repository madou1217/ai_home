'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { ensureDirSync } = require('./fs-compat');

const CHAT_IMAGE_ROOT_DIR = path.join(os.tmpdir(), 'aih-web-chat-images');
const PROJECT_ATTACHMENT_DIR = '.aih';
const PROJECT_CHAT_IMAGE_DIR = 'chat-images';
const PROVIDER_IMAGE_SEGMENTS = {
  gemini: ['.gemini', 'tmp', 'model', 'images'],
  claude: ['.claude', 'tmp', 'model', 'images'],
  codex: ['.codex', '.tmp', 'model', 'images']
};

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeExtensionFromMime(mimeType) {
  const mime = normalizeString(mimeType).toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'bin';
}

function parseDataUrlImage(dataUrl) {
  const text = normalizeString(dataUrl);
  const match = text.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    const error = new Error('invalid_image_data_url');
    error.code = 'invalid_image_data_url';
    throw error;
  }
  const mimeType = normalizeString(match[1]).toLowerCase();
  const base64 = normalizeString(match[2]);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    const error = new Error('empty_image_payload');
    error.code = 'empty_image_payload';
    throw error;
  }
  return {
    mimeType,
    extension: sanitizeExtensionFromMime(mimeType),
    buffer
  };
}

function isAbsoluteExistingDir(fsImpl, targetPath) {
  if (!targetPath || !path.isAbsolute(targetPath)) return false;
  try {
    return Boolean(fsImpl.existsSync(targetPath) && fsImpl.statSync(targetPath).isDirectory());
  } catch (_error) {
    return false;
  }
}

function isAbsolutePath(targetPath) {
  return Boolean(targetPath && path.isAbsolute(targetPath));
}

function resolveAttachmentRootDir(fsImpl, projectPath) {
  if (isAbsoluteExistingDir(fsImpl, projectPath)) {
    return path.join(projectPath, PROJECT_ATTACHMENT_DIR, PROJECT_CHAT_IMAGE_DIR);
  }
  return CHAT_IMAGE_ROOT_DIR;
}

function resolveProviderAttachmentRootDir(fsImpl, options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const profileDir = normalizeString(options.profileDir);
  const providerSegments = PROVIDER_IMAGE_SEGMENTS[provider];

  if (providerSegments && isAbsolutePath(profileDir)) {
    return path.join(profileDir, ...providerSegments);
  }

  return resolveAttachmentRootDir(fsImpl, options.projectPath);
}

function persistChatImages(images, deps = {}) {
  const fs = deps.fs;
  if (!fs || typeof fs.writeFileSync !== 'function') {
    const error = new Error('chat_attachment_fs_unavailable');
    error.code = 'chat_attachment_fs_unavailable';
    throw error;
  }

  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) return [];

  const rootDir = resolveProviderAttachmentRootDir(fs, {
    provider: deps.provider,
    profileDir: deps.profileDir,
    projectPath: deps.projectPath
  });
  ensureDirSync(fs, rootDir);

  return list.map((item, index) => {
    const parsed = parseDataUrlImage(item);
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${index + 1}`;
    const filePath = path.join(rootDir, `clipboard-${stamp}.${parsed.extension}`);
    fs.writeFileSync(filePath, parsed.buffer);
    return filePath;
  });
}

function appendImagePathsToPrompt(prompt, imagePaths) {
  const basePrompt = String(prompt || '').trim();
  const files = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  if (files.length === 0) return basePrompt;

  const attachmentBlock = [
    'Attached image files:',
    ...files.map((filePath) => `- ${filePath}`),
    'Please inspect these local image files directly when answering.'
  ].join('\n');

  return [attachmentBlock, '', basePrompt].filter(Boolean).join('\n');
}

function isChatAttachmentPath(filePath) {
  const target = normalizeString(filePath);
  if (!target) return false;
  const resolvedTarget = path.resolve(target);
  const resolvedTempRoot = path.resolve(CHAT_IMAGE_ROOT_DIR);
  if (resolvedTarget === resolvedTempRoot || resolvedTarget.startsWith(`${resolvedTempRoot}${path.sep}`)) {
    return true;
  }

  for (const segments of Object.values(PROVIDER_IMAGE_SEGMENTS)) {
    const marker = `${path.sep}${segments.join(path.sep)}${path.sep}`;
    if (resolvedTarget.includes(marker)) {
      return true;
    }
  }

  const parts = resolvedTarget.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === PROJECT_ATTACHMENT_DIR && parts[index + 1] === PROJECT_CHAT_IMAGE_DIR) {
      return true;
    }
  }
  return false;
}

function resolveChatAttachmentPath(filePath) {
  const target = normalizeString(filePath);
  if (!target || !isChatAttachmentPath(target) || !fs.existsSync(target)) {
    const error = new Error('chat_attachment_not_found');
    error.code = 'chat_attachment_not_found';
    throw error;
  }
  return path.resolve(target);
}

function guessAttachmentMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

module.exports = {
  CHAT_IMAGE_ROOT_DIR,
  appendImagePathsToPrompt,
  persistChatImages,
  resolveChatAttachmentPath,
  guessAttachmentMimeType
};
