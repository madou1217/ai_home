'use strict';

// 远程工作区作为 Work 项目时，Files / Review 面板的数据面适配（Adapter）。
//
// 前端面板不区分本机 / 远程：仍然带 projectPath 调 /v0/webui/fs/* 与 /v0/webui/git/*。
// projectPath 是远程工作区影子目录时，这里接管请求，经共享连接池（RemoteHost）落到远端，
// 返回与本机路由同形的 JSON；不是影子目录返回 false，交回本机路由。
//
// git 在远端执行（远端没装 git 时 Review 面板给出明确错误，可经 Toolkit 安装）。

const path = require('node:path');
const { workspaceIdFromProjectPath, loadWorkspace } = require('./remote-session-bridge');
const { parsePorcelain } = require('./webui-git-service').__private;

const HIDDEN_NAMES = new Set(['.git', 'node_modules', '.next', '.nuxt', '__pycache__', '.cache', '.DS_Store', 'Thumbs.db']);
const MAX_ENTRIES = 200;
const TEXT_FILE_SIZE_LIMIT = 2 * 1024 * 1024;
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;

function remoteContext(ctx) {
  const projectPath = String(ctx.url.searchParams?.get('projectPath') || '').trim();
  const aiHomeDir = ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir) || '';
  const workspaceId = workspaceIdFromProjectPath(aiHomeDir, projectPath);
  if (!workspaceId) return null;
  return { projectPath, aiHomeDir, workspaceId, fs: ctx.fs || (ctx.deps && ctx.deps.fs) };
}

function hostFor(remote) {
  if (!loadWorkspace(remote.fs, remote.aiHomeDir, remote.workspaceId)) {
    throw Object.assign(new Error('远程工作区不存在'), { code: 'workspace_not_found', status: 404 });
  }
  const { getRemoteWorkspaceService } = require('../remote-workspace');
  return getRemoteWorkspaceService({ fs: remote.fs, aiHomeDir: remote.aiHomeDir }).host(remote.workspaceId);
}

const STATUS_BY_CODE = Object.freeze({
  not_found: 404, invalid_path: 403, path_escape: 403, too_large: 413, workspace_not_found: 404
});

function sendError(ctx, error, fallback) {
  const code = String(error && error.code || fallback);
  const status = error && error.status || STATUS_BY_CODE[code] || 502;
  ctx.writeJson(ctx.res, status, { ok: false, error: code, message: String(error && error.message || error || code) });
  return true;
}

/** 影子目录内的绝对路径 / 相对路径 → 工作区相对路径。 */
function relativeOf(remote, rawPath) {
  const value = String(rawPath || '').trim().replace(/:\d+(?::\d+)?$/, '');
  if (!value) return '';
  if (path.isAbsolute(value)) {
    const rel = path.relative(remote.projectPath, value);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw Object.assign(new Error('只允许读取远程工作区内的文件'), { code: 'path_escape' });
    }
    return rel.split(path.sep).join('/');
  }
  return value.replace(/\\/g, '/');
}

async function handleTree(ctx, remote) {
  const relativePath = String(ctx.url.searchParams?.get('path') || '').trim();
  const showHidden = ctx.url.searchParams?.get('showHidden') === '1';
  const listing = await hostFor(remote).listDir(relativePath);
  const visible = listing.entries.filter((entry) => showHidden || (!HIDDEN_NAMES.has(entry.name) && !entry.name.startsWith('.')));
  const entries = visible.slice(0, MAX_ENTRIES).map((entry) => {
    const isDir = entry.type === 'd';
    return {
      name: entry.name,
      type: isDir ? 'directory' : 'file',
      size: isDir ? undefined : entry.size,
      mtime: Number(entry.mtime || 0) * 1000,
      hasChildren: isDir
    };
  });
  ctx.writeJson(ctx.res, 200, {
    ok: true, path: relativePath || '.', projectPath: remote.projectPath, entries, truncated: visible.length > MAX_ENTRIES, remote: true
  });
  return true;
}

async function handleRead(ctx, remote, { checkOnly }) {
  const rel = relativeOf(remote, ctx.url.searchParams?.get('path'));
  if (!rel) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'missing_path', message: '缺少文件路径' });
    return true;
  }
  const host = hostFor(remote);
  const targetPath = path.join(remote.projectPath, rel);
  if (checkOnly) {
    const info = await host.stat(rel);
    if (info.type === 'd') {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'not_a_file', message: '目标不是文件' });
      return true;
    }
    ctx.writeJson(ctx.res, 200, { ok: true, path: targetPath, size: info.size, mtime: info.mtime * 1000 });
    return true;
  }
  const file = await host.readFile(rel, { maxBytes: TEXT_FILE_SIZE_LIMIT });
  ctx.writeJson(ctx.res, 200, {
    ok: true, path: targetPath, content: file.content.toString('utf8'), size: file.size, mtime: file.mtime * 1000
  });
  return true;
}

async function remoteGit(host, args) {
  const command = ['git', ...args].map((part) => (/^[A-Za-z0-9_@%+=:,./{}-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ');
  const result = await host.run(command, { lane: 'interactive', maxOutputBytes: GIT_OUTPUT_LIMIT, timeoutMs: 30_000 });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
}

function gitFailure(result) {
  const text = String(result.stderr || result.stdout || '').trim();
  if (result.code === 127 || /git: (command )?not found/.test(text)) {
    return Object.assign(new Error('远端未安装 git，可在「Toolkit → 运行环境」选择该机器安装'), { code: 'git_not_installed', status: 400 });
  }
  if (/not a git repository/i.test(text)) {
    return Object.assign(new Error('远程工作区不是 Git 仓库'), { code: 'not_a_git_repository', status: 400 });
  }
  return Object.assign(new Error(text || `git 退出码 ${result.code}`), { code: 'git_failed', status: 400 });
}

async function handleGitSummary(ctx, remote) {
  const host = hostFor(remote);
  const [status, branch, upstream] = await Promise.all([
    remoteGit(host, ['status', '--porcelain=v1', '-z']),
    remoteGit(host, ['branch', '--show-current']),
    remoteGit(host, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  ]);
  if (status.code !== 0) throw gitFailure(status);
  const upstreamName = upstream.code === 0 ? upstream.stdout.trim() : '';
  let ahead = 0;
  let behind = 0;
  if (upstreamName) {
    const counts = await remoteGit(host, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    [ahead, behind] = counts.stdout.trim().split(/\s+/).map((value) => Number(value) || 0);
  }
  ctx.writeJson(ctx.res, 200, {
    ok: true, branch: branch.stdout.trim() || 'HEAD', upstream: upstreamName, ahead, behind, files: parsePorcelain(status.stdout), remote: true
  });
  return true;
}

async function handleGitDiff(ctx, remote) {
  const filePath = String(ctx.url.searchParams?.get('path') || '').trim();
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (!filePath || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_file_path', message: '必须提供项目内的相对文件路径' });
    return true;
  }
  const args = ['diff', '--no-ext-diff', '--no-color', '--unified=3'];
  if (ctx.url.searchParams?.get('staged') === '1') args.push('--cached');
  args.push('--', normalized);
  const result = await remoteGit(hostFor(remote), args);
  if (result.code !== 0) throw gitFailure(result);
  ctx.writeJson(ctx.res, 200, { ok: true, path: normalized, content: result.stdout, truncated: result.truncated });
  return true;
}

const HANDLERS = Object.freeze({
  '/v0/webui/fs/tree': (ctx, remote) => handleTree(ctx, remote),
  '/v0/webui/fs/read': (ctx, remote) => handleRead(ctx, remote, { checkOnly: false }),
  '/v0/webui/fs/access': (ctx, remote) => handleRead(ctx, remote, { checkOnly: true }),
  '/v0/webui/git/summary': (ctx, remote) => handleGitSummary(ctx, remote),
  '/v0/webui/git/diff': (ctx, remote) => handleGitDiff(ctx, remote)
});

/**
 * 远程工作区项目的 fs / git 请求。不是远程工作区项目返回 false。
 * @returns {Promise<boolean>}
 */
async function handleRemoteWorkspaceProjectRequest(ctx) {
  if (ctx.method !== 'GET') return false;
  const handler = HANDLERS[ctx.pathname];
  if (!handler) return false;
  const remote = remoteContext(ctx);
  if (!remote) return false;
  try {
    return await handler(ctx, remote);
  } catch (error) {
    return sendError(ctx, error, 'remote_workspace_failed');
  }
}

module.exports = { handleRemoteWorkspaceProjectRequest };
