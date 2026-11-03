'use strict';

const path = require('node:path');

function compareVersions(left, right) {
  const parse = value => /^\d+(?:\.\d+)*$/.test(String(value || ''))
    ? String(value).split('.').map(Number)
    : null;
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function matchesVersion(layout, version) {
  if (layout.minVersion) {
    const comparison = compareVersions(version, layout.minVersion);
    if (comparison === null || comparison < 0) return false;
  }
  if (layout.maxVersionExclusive) {
    const comparison = compareVersions(version, layout.maxVersionExclusive);
    if (comparison === null || comparison >= 0) return false;
  }
  return true;
}

function resolveDesktopRuntimeLayout({ fs, root, platform, version, layouts }) {
  if (!root) return null;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  for (const layout of layouts || []) {
    if (layout.platform !== platform || !matchesVersion(layout, version)) continue;
    const segments = String(layout.relativePath || '').split(/[\\/]/);
    if (!segments.length || segments.some(segment => !segment || segment === '..' || segment === '.' || segment.includes(':'))) continue;
    const executablePath = pathApi.join(root, ...segments);
    try {
      if (!fs.existsSync(executablePath)) continue;
      if (fs.statSync && !fs.statSync(executablePath).isFile()) continue;
      return { layoutId: layout.id, executablePath, ...(layout.hookStrategy ? { hookStrategy: layout.hookStrategy } : {}) };
    } catch (_) {}
  }
  return null;
}

module.exports = { resolveDesktopRuntimeLayout };
