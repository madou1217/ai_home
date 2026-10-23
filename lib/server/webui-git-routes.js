'use strict';

const path = require('node:path');
const { resolveAuthorizedProjectRoot } = require('./webui-project-root-policy');
const { getGitSummary, getGitDiff } = require('./webui-git-service');

function validRelativePath(value) {
  const candidate = String(value || '').trim();
  if (!candidate || path.isAbsolute(candidate)) return '';
  const normalized = path.normalize(candidate);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return '';
  return normalized;
}

async function resolveRootOrRespond(ctx) {
  const requested = String(ctx.url.searchParams?.get('projectPath') || '').trim();
  const root = await resolveAuthorizedProjectRoot(ctx, requested);
  if (!root) {
    ctx.writeJson(ctx.res, 403, { ok: false, error: 'unknown_project_root', message: '只允许查看已登记项目的 Git 变更' });
    return '';
  }
  return root;
}

// git 状态要起 git 子进程（实测 40~350ms，随仓库大小与并发变化）。
// 工作区状态秒级内不会变，而面板每次进项目页都会拉一次。
// 按短 TTL 缓存；stale 时先回旧值并后台刷新，避免把子进程等待压在用户点击那一刻。
const GIT_SUMMARY_TTL_MS = 5000;
const gitSummaryCache = new Map();
const gitSummaryInFlight = new Map();

async function getGitSummaryCached(root) {
  const now = Date.now();
  const hit = gitSummaryCache.get(root);
  if (hit && now - hit.at < GIT_SUMMARY_TTL_MS) return hit.value;
  if (hit) {
    if (!gitSummaryInFlight.has(root)) {
      const request = getGitSummary(root)
        .then((value) => { gitSummaryCache.set(root, { at: Date.now(), value }); return value; })
        .catch(() => hit.value)
        .finally(() => { if (gitSummaryInFlight.get(root) === request) gitSummaryInFlight.delete(root); });
      gitSummaryInFlight.set(root, request);
    }
    return hit.value;
  }
  const value = await getGitSummary(root);
  gitSummaryCache.set(root, { at: now, value });
  return value;
}

async function handleGitSummaryRequest(ctx) {
  const root = await resolveRootOrRespond(ctx);
  if (!root) return true;
  try {
    const summary = await getGitSummaryCached(root);
    ctx.writeJson(ctx.res, 200, { ok: true, ...summary });
  } catch (error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: error.code || 'git_summary_failed', message: String(error.message || error) });
  }
  return true;
}

async function handleGitDiffRequest(ctx) {
  const root = await resolveRootOrRespond(ctx);
  if (!root) return true;
  const filePath = validRelativePath(ctx.url.searchParams?.get('path'));
  if (!filePath) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_file_path', message: '必须提供项目内的相对文件路径' });
    return true;
  }
  try {
    const diff = await getGitDiff(root, filePath, ctx.url.searchParams?.get('staged') === '1');
    ctx.writeJson(ctx.res, 200, { ok: true, path: filePath, ...diff });
  } catch (error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: error.code || 'git_diff_failed', message: String(error.message || error) });
  }
  return true;
}

module.exports = { handleGitSummaryRequest, handleGitDiffRequest, __private: { validRelativePath } };
