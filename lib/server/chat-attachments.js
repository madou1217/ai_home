'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { ensureDirSync } = require('./fs-compat');
const { resolveHostHomeDirFromAiHomeDir } = require('../runtime/codex-home');
const {
  PROVIDER_STORAGE_POLICIES,
  isProviderPrivateArtifactPath,
  resolveProviderAttachmentRoot,
  resolveProviderNativeRoot
} = require('../runtime/provider-storage-policy');
const { canonicalizeProviderResourcePath } = require('../runtime/provider-resource-path');

const CHAT_IMAGE_ROOT_DIR = path.join(os.tmpdir(), 'aih-web-chat-images');
const PROJECT_ATTACHMENT_DIR = '.aih';
const PROJECT_CHAT_IMAGE_DIR = 'chat-images';
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
  const aiHomeDir = normalizeString(options.aiHomeDir);
  const hostHomeDir = normalizeString(options.hostHomeDir)
    || resolveHostHomeDirFromAiHomeDir(aiHomeDir, path);
  const providerRoot = resolveProviderAttachmentRoot(hostHomeDir, provider, path);

  if (isAbsolutePath(providerRoot)) {
    return providerRoot;
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
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
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

function isPathWithinRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || Boolean(
    relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolveProjectAttachmentRoot(targetPath) {
  const marker = `${path.sep}${PROJECT_ATTACHMENT_DIR}${path.sep}${PROJECT_CHAT_IMAGE_DIR}`;
  const markerIndex = targetPath.indexOf(marker);
  return markerIndex >= 0 ? targetPath.slice(0, markerIndex + marker.length) : '';
}

function resolveChatAttachmentRoot(targetPath, options = {}) {
  const aiHomeDir = normalizeString(options.aiHomeDir);
  const hostHomeDir = normalizeString(options.hostHomeDir)
    || resolveHostHomeDirFromAiHomeDir(aiHomeDir, path);
  const roots = [path.resolve(CHAT_IMAGE_ROOT_DIR)];
  if (hostHomeDir) {
    Object.keys(PROVIDER_STORAGE_POLICIES).forEach((provider) => {
      // Provider-generated images are not limited to AIH's clipboard folder:
      // AGY stores them under brain/<session>, Claude under projects/artifacts,
      // and Codex/Gemini may emit images beside their native session state.
      // The complete provider root is account-independent and credential paths
      // remain blocked below, including through symlinks.
      const root = resolveProviderNativeRoot(hostHomeDir, provider, path);
      if (root) roots.push(path.resolve(root));
    });
  }
  const projectRoot = resolveProjectAttachmentRoot(targetPath);
  if (projectRoot) roots.push(projectRoot);
  return roots.find((root) => isPathWithinRoot(root, targetPath)) || '';
}

function createAttachmentNotFoundError() {
  const error = new Error('chat_attachment_not_found');
  error.code = 'chat_attachment_not_found';
  return error;
}

function resolveChatAttachmentPath(filePath, options = {}) {
  const target = normalizeString(filePath);
  const fsImpl = options.fs || fs;
  const resolvedTarget = canonicalizeProviderResourcePath(target, {
    aiHomeDir: options.aiHomeDir,
    hostHomeDir: options.hostHomeDir
  });
  const lexicalTarget = path.resolve(resolvedTarget || '');
  const lexicalRoot = resolvedTarget
    ? resolveChatAttachmentRoot(lexicalTarget, options)
    : '';
  if (
    !lexicalRoot
    || isProviderPrivateArtifactPath(lexicalTarget, path)
    || !fsImpl.existsSync(lexicalTarget)
  ) throw createAttachmentNotFoundError();

  try {
    const realTarget = path.resolve(fsImpl.realpathSync(lexicalTarget));
    const realRoot = path.resolve(fsImpl.realpathSync(lexicalRoot));
    const stat = fsImpl.statSync(realTarget);
    if (
      !stat.isFile()
      || !isPathWithinRoot(realRoot, realTarget)
      || isProviderPrivateArtifactPath(realTarget, path)
    ) throw createAttachmentNotFoundError();
    return realTarget;
  } catch (error) {
    if (error && error.code === 'chat_attachment_not_found') throw error;
    throw createAttachmentNotFoundError();
  }
}

function guessAttachmentMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return '';
}

module.exports = {
  CHAT_IMAGE_ROOT_DIR,
  appendImagePathsToPrompt,
  persistChatImages,
  resolveChatAttachmentPath,
  guessAttachmentMimeType
};
