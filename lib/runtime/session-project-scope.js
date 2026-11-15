'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only recorded absolute paths establish project membership. Names, slugs and
// missing cwd values must never turn into the caller's current directory.
function normalizeSessionProjectPath(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) return '';
  let normalized = path.resolve(text);
  try { normalized = fs.realpathSync(normalized); } catch (_error) {}
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function matchesSessionCwd(projectPath, cwd) {
  const current = normalizeSessionProjectPath(cwd);
  return Boolean(current) && normalizeSessionProjectPath(projectPath) === current;
}

module.exports = { normalizeSessionProjectPath, matchesSessionCwd };
