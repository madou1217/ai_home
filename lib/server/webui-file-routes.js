'use strict';

const path = require('node:path');
const { resolveHostHomeDirFromAiHomeDir } = require('../runtime/codex-home');

const TEXT_FILE_SIZE_LIMIT = 5 * 1024 * 1024;
const MEDIA_FILE_SIZE_LIMIT = 15 * 1024 * 1024;

const IMAGE_CONTENT_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
});

// 一些安全目录的校验，防止利用绝对路径乱读文件
function isSubPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeSlashPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function resolveCodexMemoryRoot(ctx) {
  const pathImpl = path;
  const deps = ctx.deps || {};
  const aiHomeDir = String(deps.aiHomeDir || ctx.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || ctx.hostHomeDir || '').trim()
    || resolveHostHomeDirFromAiHomeDir(aiHomeDir, pathImpl);

  const candidateRoots = [
    aiHomeDir ? pathImpl.join(aiHomeDir, 'profiles', 'codex', '.aih-server', '.codex', 'memories') : '',
    hostHomeDir ? pathImpl.join(hostHomeDir, '.ai_home', 'profiles', 'codex', '.aih-server', '.codex', 'memories') : '',
    hostHomeDir ? pathImpl.join(hostHomeDir, '.codex', 'memories') : ''
  ].filter(Boolean);

  for (const root of candidateRoots) {
    if (deps.fs && deps.fs.existsSync(root)) return root;
  }
  return candidateRoots[0] || '';
}

function resolveCodexMemoryCitationPath(ctx, rawFilePath) {
  const memoryRoot = resolveCodexMemoryRoot(ctx);
  const normalized = normalizeSlashPath(rawFilePath);
  if (!memoryRoot || !normalized || normalized.startsWith('/') || normalized.startsWith('~')) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 1 || parts.some((part) => part === '.' || part === '..')) return null;
  const targetPath = path.resolve(memoryRoot, ...parts);
  if (targetPath !== memoryRoot && !isSubPath(memoryRoot, targetPath)) return null;
  return { memoryRoot, targetPath };
}

function getImageContentType(filePath) {
  // 图片预览只按白名单扩展名返回，避免 media route 变成任意二进制下载入口。
  return IMAGE_CONTENT_TYPES[path.extname(String(filePath || '')).toLowerCase()] || '';
}

function sendFileRequestError(ctx, error) {
  ctx.writeJson(ctx.res, error.status, {
    ok: false,
    error: error.error,
    message: error.message
  });
}

function resolveAuthorizedFileRequest(ctx, options = {}) {
  const { url, writeJson, deps, aiHomeDir } = ctx;
  const { fs } = deps;

  let rawFilePath = String(url.searchParams?.get('path') || '').trim();
  let projectDir = String(url.searchParams?.get('projectPath') || '').trim();
  const source = String(url.searchParams?.get('source') || '').trim();
  const sizeLimit = Number(options.sizeLimit) || TEXT_FILE_SIZE_LIMIT;

  if (!rawFilePath) {
    return { ok: false, status: 400, error: 'path_required', message: '必须提供文件路径' };
  }

  // 处理类似 .php:14 的行号后缀。
  const lineNumMatch = rawFilePath.match(/^(.*?):[0-9]+(-[0-9]+)?$/);
  if (lineNumMatch) {
    rawFilePath = lineNumMatch[1];
  }

  let forcedAuthorizedRoot = '';
  if (source === 'codex-memory') {
    const resolvedMemory = resolveCodexMemoryCitationPath(ctx, rawFilePath);
    if (!resolvedMemory) {
      return { ok: false, status: 403, error: 'outside_memory_root', message: '只允许读取 Codex 记忆目录内的引用文件' };
    }
    rawFilePath = resolvedMemory.targetPath;
    forcedAuthorizedRoot = resolvedMemory.memoryRoot;
    projectDir = '';
  } else if (rawFilePath.startsWith('~')) {
    // 将 ~ 解析到用户主目录。
    const homeDir = typeof require('node:os').homedir === 'function'
      ? require('node:os').homedir()
      : process.env.HOME || process.env.USERPROFILE || '';
    rawFilePath = path.join(homeDir, rawFilePath.slice(1));
  }

  // 清理路径中的相对导航符，并转成绝对路径。
  const targetPath = path.resolve(rawFilePath);

  // 【安全拦截1】绝不允许读取核心密钥文件。
  const lowerPath = targetPath.toLowerCase();
  if (
    lowerPath.includes('/.ssh/') ||
    lowerPath.includes('\\.ssh\\') ||
    lowerPath.includes('auth.json') ||
    lowerPath.includes('oauth_creds.json') ||
    lowerPath.includes('credentials.json') ||
    lowerPath.endsWith('id_rsa')
  ) {
    return { ok: false, status: 403, error: 'permission_denied', message: '出于安全考虑，不允许读取此系统或凭证文件' };
  }

  // 【安全拦截2】基于工作空间和 AI Home 的作用域白名单。
  const effectiveAiHome = String((ctx.deps && ctx.deps.aiHomeDir) || aiHomeDir || '').trim();
  let isAuthorized = false;

  if (forcedAuthorizedRoot && (targetPath === forcedAuthorizedRoot || isSubPath(forcedAuthorizedRoot, targetPath))) {
    isAuthorized = true;
  } else if (projectDir && isSubPath(projectDir, targetPath)) {
    isAuthorized = true;
  } else if (effectiveAiHome && isSubPath(effectiveAiHome, targetPath)) {
    isAuthorized = true;
  } else if (projectDir === targetPath || effectiveAiHome === targetPath) {
    isAuthorized = true; // 允许读取根路径本身，后续 stat 会拦截目录。
  }

  // 为了兼容绝对路径引用，如果没有 projectDir 上下文，只允许 AI Home 或受控 source。
  if (!isAuthorized) {
    return { ok: false, status: 403, error: 'outside_workspace', message: '出于安全考虑，只允许读取当前项目空间和 AI 配置目录内的文件' };
  }

  if (!fs.existsSync(targetPath)) {
    return { ok: false, status: 404, error: 'not_found', message: `文件不存在: ${rawFilePath}` };
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) {
    return { ok: false, status: 400, error: 'not_a_file', message: '目标路径不是一个普通文件' };
  }

  // 【安全拦截3】文件大小限制。
  if (stat.size > sizeLimit) {
    return { ok: false, status: 413, error: 'file_too_large', message: `文件超过${Math.round(sizeLimit / 1024 / 1024)}MB大小限制` };
  }

  return {
    ok: true,
    targetPath,
    stat
  };
}

async function handleReadFileRequest(ctx) {
  const { writeJson, deps } = ctx;
  const { fs } = deps;

  try {
    const resolved = resolveAuthorizedFileRequest(ctx, { sizeLimit: TEXT_FILE_SIZE_LIMIT });
    if (!resolved.ok) {
      sendFileRequestError(ctx, resolved);
      return true;
    }

    const content = fs.readFileSync(resolved.targetPath, 'utf8');

    writeJson(ctx.res, 200, {
      ok: true,
      path: resolved.targetPath,
      content,
      size: resolved.stat.size,
      mtime: resolved.stat.mtimeMs
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'read_file_failed',
      message: String((error && error.message) || error || '读取文件失败')
    });
    return true;
  }
}

async function handleReadFileMediaRequest(ctx) {
  const { deps } = ctx;
  const { fs } = deps;

  try {
    const resolved = resolveAuthorizedFileRequest(ctx, { sizeLimit: MEDIA_FILE_SIZE_LIMIT });
    if (!resolved.ok) {
      sendFileRequestError(ctx, resolved);
      return true;
    }

    const contentType = getImageContentType(resolved.targetPath);
    if (!contentType) {
      ctx.writeJson(ctx.res, 415, {
        ok: false,
        error: 'unsupported_media_type',
        message: '当前仅支持预览图片文件'
      });
      return true;
    }

    const payload = fs.readFileSync(resolved.targetPath);
    ctx.res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': resolved.stat.size,
      'Cache-Control': 'private, max-age=300'
    });
    ctx.res.end(payload);
    return true;
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'read_media_failed',
      message: String((error && error.message) || error || '读取媒体文件失败')
    });
    return true;
  }
}

module.exports = {
  handleReadFileMediaRequest,
  handleReadFileRequest,
  __private: {
    getImageContentType,
    resolveAuthorizedFileRequest,
    resolveCodexMemoryCitationPath,
    resolveCodexMemoryRoot
  }
};
