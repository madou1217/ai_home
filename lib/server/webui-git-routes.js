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

async function handleGitSummaryRequest(ctx) {
  const root = await resolveRootOrRespond(ctx);
  if (!root) return true;
  try {
    const summary = await getGitSummary(root);
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
