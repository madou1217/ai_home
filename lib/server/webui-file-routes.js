'use strict';

const path = require('node:path');
const { resolveHostHomeDirFromAiHomeDir } = require('../runtime/codex-home');
const {
  canonicalizeProviderResourceText,
  resolveProviderResourcePath
} = require('../runtime/provider-resource-path');
const {
  isProviderPrivateArtifactPath
} = require('../runtime/provider-storage-policy');
const { CHAT_IMAGE_ROOT_DIR } = require('./chat-attachments');
const {
  createFileTrustCandidates,
  isPathWithinRoot,
  isProviderConfigurationPath,
  resolveProviderReadableResourceRoots
} = require('./webui-file-access-policy');
const {
  addTrustedFileRoot,
  readTrustedFileRoots
} = require('./webui-file-trust-store');

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

function normalizeSlashPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function resolveRequestHostHomeDir(ctx) {
  const deps = ctx.deps || {};
  const aiHomeDir = String(deps.aiHomeDir || ctx.aiHomeDir || '').trim();
  return String(deps.hostHomeDir || ctx.hostHomeDir || '').trim()
    || resolveHostHomeDirFromAiHomeDir(aiHomeDir, path);
}

function resolveCodexMemoryRoot(ctx) {
  const hostHomeDir = resolveRequestHostHomeDir(ctx);
  return hostHomeDir ? path.join(hostHomeDir, '.codex', 'memories') : '';
}

function resolveCodexMemoryCitationPath(ctx, rawFilePath) {
  const memoryRoot = resolveCodexMemoryRoot(ctx);
  const normalized = normalizeSlashPath(rawFilePath);
  if (!memoryRoot || !normalized || normalized.startsWith('/') || normalized.startsWith('~')) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 1 || parts.some((part) => part === '.' || part === '..')) return null;
  const targetPath = path.resolve(memoryRoot, ...parts);
  if (!isPathWithinRoot(memoryRoot, targetPath, path)) return null;
  return { memoryRoot, targetPath };
}

function getImageContentType(filePath) {
  // 图片预览只按白名单扩展名返回，避免 media route 变成任意二进制下载入口。
  return IMAGE_CONTENT_TYPES[path.extname(String(filePath || '')).toLowerCase()] || '';
}

function disableFilePreviewCaching(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function sendFileRequestError(ctx, error) {
  const payload = {
    ok: false,
    error: error.error,
    message: error.message
  };
  if (error.authorization) payload.authorization = error.authorization;
  ctx.writeJson(ctx.res, error.status, payload);
}

// provider 会话资源目录 + AIH 图片临时目录：会话工具产出物(view_image 渲染图、中间文件)常落在
// 项目目录之外，需显式放开只读授权。根目录来自当前 Server 的 hostHomeDir，不能缓存
// os.homedir()，否则远端/custom host home 会出现“会话可列出但附件 403”。
function resolveExtraReadableRoots(ctx) {
  const os = require('node:os');
  const home = resolveRequestHostHomeDir(ctx)
    || (typeof os.homedir === 'function' ? os.homedir() : (process.env.HOME || process.env.USERPROFILE || ''));
  const roots = [];
  if (home) {
    roots.push(...resolveProviderReadableResourceRoots(home, path));
  }
  roots.push(path.resolve(CHAT_IMAGE_ROOT_DIR));
  return Array.from(new Set(roots.filter(Boolean)));
}

function isSensitiveFilePath(filePath, hostHomeDir = '') {
  const targetPath = String(filePath || '');
  const lowerPath = targetPath.toLowerCase();
  return lowerPath.includes('/.ssh/')
    || lowerPath.includes('\\.ssh\\')
    || lowerPath.includes('auth.json')
    || lowerPath.includes('oauth_creds.json')
    || lowerPath.includes('credentials.json')
    || lowerPath.endsWith('id_rsa')
    || isProviderConfigurationPath(hostHomeDir, targetPath, path)
    || isProviderPrivateArtifactPath(targetPath, path);
}

function isPathAuthorizedByRoots(targetPath, roots) {
  return roots.some((root) => root && isPathWithinRoot(root, targetPath, path));
}

function resolveRealPathOrSelf(fsImpl, targetPath) {
  try {
    return path.resolve(fsImpl.realpathSync(targetPath));
  } catch (_error) {
    return path.resolve(targetPath);
  }
}

function resolveOptionalRealPath(fsImpl, targetPath) {
  const candidate = String(targetPath || '').trim();
  return candidate ? resolveRealPathOrSelf(fsImpl, candidate) : '';
}

async function resolveAuthorizedProjectRoot(ctx, requestedProjectDir) {
  const candidate = String(requestedProjectDir || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) return '';
  const resolvedCandidate = path.resolve(candidate);
  try {
    const resolver = ctx.deps && typeof ctx.deps.getCompleteProjectSnapshot === 'function'
      ? ctx.deps.getCompleteProjectSnapshot
      : require('./webui-project-cache').getCompleteProjectSnapshot;
    const project = await resolver(ctx, resolvedCandidate);
    const resolvedProjectPath = String(project && project.path || '').trim();
    if (!resolvedProjectPath || path.resolve(resolvedProjectPath) !== resolvedCandidate) return '';
    return resolvedCandidate;
  } catch (_error) {
    return '';
  }
}

function resolveEffectiveAiHomeDir(ctx) {
  return String(ctx.deps && ctx.deps.aiHomeDir || ctx.aiHomeDir || '').trim();
}

function stripFileLineSuffix(filePath) {
  const match = String(filePath || '').trim().match(/^(.*?):[0-9]+(-[0-9]+)?$/);
  return match ? match[1] : String(filePath || '').trim();
}

function resolveRequestedFileTarget(ctx, options = {}) {
  const { fs } = ctx.deps;
  const source = String(options.source || '').trim();
  const effectiveAiHome = resolveEffectiveAiHomeDir(ctx);
  const hostHomeDir = resolveRequestHostHomeDir(ctx);
  let rawFilePath = stripFileLineSuffix(options.rawFilePath);
  let forcedAuthorizedRoot = '';

  if (!rawFilePath) {
    return { ok: false, status: 400, error: 'path_required', message: '必须提供文件路径' };
  }
  if (source === 'codex-memory') {
    const resolvedMemory = resolveCodexMemoryCitationPath(ctx, rawFilePath);
    if (!resolvedMemory) {
      return { ok: false, status: 403, error: 'outside_memory_root', message: '只允许读取 Codex 记忆目录内的引用文件' };
    }
    rawFilePath = resolvedMemory.targetPath;
    forcedAuthorizedRoot = resolvedMemory.memoryRoot;
  } else if (rawFilePath.startsWith('~')) {
    rawFilePath = path.join(hostHomeDir, rawFilePath.slice(1));
  }

  if (isSensitiveFilePath(rawFilePath, hostHomeDir)) {
    return { ok: false, status: 403, error: 'permission_denied', message: '出于安全考虑，不允许读取此系统或凭证文件' };
  }
  const providerPath = resolveProviderResourcePath(rawFilePath, {
    aiHomeDir: effectiveAiHome,
    hostHomeDir
  });
  if (providerPath.blocked) {
    return { ok: false, status: 403, error: 'permission_denied', message: '出于安全考虑，不允许读取账号凭证投影' };
  }

  const targetPath = path.resolve(providerPath.path);
  if (isSensitiveFilePath(targetPath, hostHomeDir)) {
    return { ok: false, status: 403, error: 'permission_denied', message: '出于安全考虑，不允许读取此系统或凭证文件' };
  }
  if (!fs.existsSync(targetPath)) {
    return { ok: false, status: 404, error: 'not_found', message: `文件不存在: ${rawFilePath}` };
  }

  const realTargetPath = resolveRealPathOrSelf(fs, targetPath);
  if (isSensitiveFilePath(realTargetPath, hostHomeDir)) {
    return { ok: false, status: 403, error: 'permission_denied', message: '出于安全考虑，不允许读取此系统或凭证文件' };
  }
  const stat = fs.statSync(realTargetPath);
  if (!stat.isFile()) {
    return { ok: false, status: 400, error: 'not_a_file', message: '目标路径不是一个普通文件' };
  }

  return {
    ok: true,
    targetPath,
    readPath: realTargetPath,
    forcedAuthorizedRoot,
    stat,
    aiHomeDir: effectiveAiHome,
    hostHomeDir,
    trustBoundary: {
      hostHomeDir: resolveOptionalRealPath(fs, hostHomeDir),
      aiHomeDir: resolveOptionalRealPath(fs, effectiveAiHome)
    }
  };
}

function createOutsideWorkspaceError(fileTarget) {
  return {
    ok: false,
    status: 403,
    error: 'outside_workspace',
    message: '此文件位于未信任的文件夹，请授权后继续预览',
    authorization: {
      required: true,
      filePath: fileTarget.readPath,
      candidates: createFileTrustCandidates(fileTarget.readPath, fileTarget.trustBoundary, path)
    }
  };
}

async function resolveAuthorizedFileRequest(ctx, options = {}) {
  const { url, deps } = ctx;
  const rawFilePath = String(url.searchParams?.get('path') || '').trim();
  const requestedProjectDir = String(url.searchParams?.get('projectPath') || '').trim();
  let projectDir = '';
  const source = String(url.searchParams?.get('source') || '').trim();
  const sizeLimit = Number(options.sizeLimit) || TEXT_FILE_SIZE_LIMIT;

  if (source !== 'codex-memory' && requestedProjectDir) {
    projectDir = await resolveAuthorizedProjectRoot(ctx, requestedProjectDir);
    if (!projectDir) {
      return { ok: false, status: 403, error: 'unknown_project_root', message: '只允许读取服务端已登记项目内的文件' };
    }
  }

  const fileTarget = resolveRequestedFileTarget(ctx, { rawFilePath, source });
  if (!fileTarget.ok) return fileTarget;

  const defaultRoots = [fileTarget.forcedAuthorizedRoot, projectDir]
    .filter(Boolean)
    .map((root) => path.resolve(root));
  defaultRoots.push(...resolveExtraReadableRoots(ctx));
  const canonicalDefaultRoots = defaultRoots.map((root) => resolveRealPathOrSelf(deps.fs, root));
  const trustedRoots = readTrustedFileRoots(deps);
  const authorizedRoots = [...canonicalDefaultRoots, ...trustedRoots];
  if (!isPathAuthorizedByRoots(fileTarget.readPath, authorizedRoots)) {
    return createOutsideWorkspaceError(fileTarget);
  }

  if (fileTarget.stat.size > sizeLimit) {
    return { ok: false, status: 413, error: 'file_too_large', message: `文件超过${Math.round(sizeLimit / 1024 / 1024)}MB大小限制` };
  }
  return fileTarget;
}

async function handleCheckFileAccessRequest(ctx) {
  disableFilePreviewCaching(ctx.res);
  try {
    const resolved = await resolveAuthorizedFileRequest(ctx, { sizeLimit: MEDIA_FILE_SIZE_LIMIT });
    if (!resolved.ok) {
      sendFileRequestError(ctx, resolved);
      return true;
    }
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      path: resolved.targetPath,
      size: resolved.stat.size,
      mtime: resolved.stat.mtimeMs
    });
    return true;
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'check_file_access_failed',
      message: String(error && error.message || error || '检查文件权限失败')
    });
    return true;
  }
}

async function handleTrustFilePathRequest(ctx) {
  try {
    const bodyBuffer = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 });
    const payload = JSON.parse(String(bodyBuffer || '{}'));
    const source = String(payload && payload.source || '').trim();
    const scope = String(payload && payload.scope || '').trim();
    const fileTarget = resolveRequestedFileTarget(ctx, {
      rawFilePath: payload && payload.path,
      source
    });
    if (!fileTarget.ok) {
      sendFileRequestError(ctx, fileTarget);
      return true;
    }

    const candidate = createFileTrustCandidates(
      fileTarget.readPath,
      fileTarget.trustBoundary,
      path
    ).find((item) => item.scope === scope);
    if (!candidate) {
      ctx.writeJson(ctx.res, 400, {
        ok: false,
        error: 'unsafe_trust_scope',
        message: '所选文件夹范围不可授权'
      });
      return true;
    }

    const trustedRoot = addTrustedFileRoot(candidate.path, ctx.deps);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      trustedRoot,
      filePath: fileTarget.readPath
    });
    return true;
  } catch (error) {
    const syntaxError = error instanceof SyntaxError;
    ctx.writeJson(ctx.res, syntaxError ? 400 : 500, {
      ok: false,
      error: syntaxError ? 'invalid_json' : 'trust_file_path_failed',
      message: syntaxError ? '请求内容不是有效 JSON' : String(error && error.message || error || '保存文件信任失败')
    });
    return true;
  }
}

async function handleReadFileRequest(ctx) {
  const { writeJson, deps } = ctx;
  const { fs } = deps;
  disableFilePreviewCaching(ctx.res);

  try {
    const resolved = await resolveAuthorizedFileRequest(ctx, { sizeLimit: TEXT_FILE_SIZE_LIMIT });
    if (!resolved.ok) {
      sendFileRequestError(ctx, resolved);
      return true;
    }

    const content = canonicalizeProviderResourceText(
      fs.readFileSync(resolved.readPath, 'utf8'),
      {
        aiHomeDir: resolved.aiHomeDir,
        hostHomeDir: resolved.hostHomeDir
      }
    );

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
  disableFilePreviewCaching(ctx.res);

  try {
    const resolved = await resolveAuthorizedFileRequest(ctx, { sizeLimit: MEDIA_FILE_SIZE_LIMIT });
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

    const payload = fs.readFileSync(resolved.readPath);
    ctx.res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': resolved.stat.size,
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache'
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
  handleCheckFileAccessRequest,
  handleReadFileMediaRequest,
  handleReadFileRequest,
  handleTrustFilePathRequest,
  __private: {
    createOutsideWorkspaceError,
    getImageContentType,
    resolveAuthorizedFileRequest,
    resolveAuthorizedProjectRoot,
    resolveCodexMemoryCitationPath,
    resolveCodexMemoryRoot,
    resolveRequestedFileTarget
  }
};
