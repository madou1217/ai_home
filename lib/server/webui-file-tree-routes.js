'use strict';

const path = require('node:path');
const { resolveAuthorizedProjectRoot, resolveProjectChild } = require('./webui-project-root-policy');

const HIDDEN_NAMES = new Set(['.git', 'node_modules', '.next', '.nuxt', '__pycache__', '.cache', '.DS_Store', 'Thumbs.db']);
const MAX_ENTRIES = 200;

async function handleFileTreeRequest(ctx) {
  const { url, res, deps } = ctx;
  const requestedProjectDir = String(url.searchParams?.get('projectPath') || '').trim();
  const relativePath = String(url.searchParams?.get('path') || '').trim();
  const showHidden = url.searchParams?.get('showHidden') === '1';

  if (!requestedProjectDir) {
    ctx.writeJson(res, 400, { ok: false, error: 'project_path_required', message: '必须提供项目路径' });
    return true;
  }

  const projectRoot = await resolveAuthorizedProjectRoot(ctx, requestedProjectDir);
  if (!projectRoot) {
    ctx.writeJson(res, 403, { ok: false, error: 'unknown_project_root', message: '只允许浏览已登记项目内的文件' });
    return true;
  }

  const resolved = resolveProjectChild(deps.fs, projectRoot, relativePath);
  if (!resolved) {
    ctx.writeJson(res, 403, { ok: false, error: 'path_escape', message: '路径越界' });
    return true;
  }

  const { realTarget, realRoot } = resolved;
  let stat;
  try {
    stat = deps.fs.statSync(realTarget);
  } catch (_error) {
    ctx.writeJson(res, 404, { ok: false, error: 'not_found', message: '路径不存在' });
    return true;
  }
  if (!stat.isDirectory()) {
    ctx.writeJson(res, 400, { ok: false, error: 'not_a_directory', message: '目标不是目录' });
    return true;
  }

  let rawEntries;
  try {
    rawEntries = deps.fs.readdirSync(realTarget, { withFileTypes: true });
  } catch (_error) {
    ctx.writeJson(res, 403, { ok: false, error: 'read_denied', message: '无法读取目录' });
    return true;
  }

  const entries = [];
  for (const entry of rawEntries) {
    if (!showHidden && HIDDEN_NAMES.has(entry.name)) continue;
    if (!showHidden && entry.name.startsWith('.')) continue;
    const childPath = path.join(realTarget, entry.name);
    let childReal;
    try {
      childReal = path.resolve(deps.fs.realpathSync(childPath));
    } catch (_error) {
      continue;
    }
    const { isPathWithinRoot } = require('./webui-file-access-policy');
    if (!isPathWithinRoot(realRoot, childReal, path)) continue;

    let childStat;
    try { childStat = deps.fs.statSync(childReal); } catch { continue; }
    const isDir = childStat.isDirectory();
    entries.push({
      name: entry.name,
      type: isDir ? 'directory' : 'file',
      size: isDir ? undefined : childStat.size,
      mtime: childStat.mtimeMs,
      hasChildren: isDir,
    });
    if (entries.length >= MAX_ENTRIES) break;
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const responsePath = relativePath || '.';
  ctx.writeJson(res, 200, {
    ok: true,
    path: responsePath,
    projectPath: projectRoot,
    entries,
    truncated: rawEntries.length > MAX_ENTRIES,
  });
  return true;
}

module.exports = { handleFileTreeRequest };
