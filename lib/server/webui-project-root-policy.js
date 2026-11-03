'use strict';

const path = require('node:path');
const { isPathWithinRoot } = require('./webui-file-access-policy');

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

function resolveProjectChild(fsImpl, projectRoot, relativePath = '') {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, String(relativePath || ''));
  if (!isPathWithinRoot(root, candidate, path)) return null;
  try {
    const realRoot = path.resolve(fsImpl.realpathSync(root));
    const realTarget = path.resolve(fsImpl.realpathSync(candidate));
    if (!isPathWithinRoot(realRoot, realTarget, path)) return null;
    return { root, realRoot, target: candidate, realTarget };
  } catch (_error) {
    return null;
  }
}

module.exports = { resolveAuthorizedProjectRoot, resolveProjectChild };
