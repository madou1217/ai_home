'use strict';

const path = require('node:path');

function getStateDbVersion(filePath) {
  const match = path.basename(String(filePath || '')).match(/^state_(\d+)\.sqlite$/i);
  return match ? Number(match[1]) || 0 : 0;
}

function listStateDbPathsInDirectory(fs, directory) {
  try {
    return fs.readdirSync(directory)
      .filter((entryName) => /^state_\d+\.sqlite$/i.test(entryName))
      .map((entryName) => path.join(directory, entryName));
  } catch (_error) {
    return [];
  }
}

function listCodexStateDbPaths(fs, codexHome) {
  const home = String(codexHome || '').trim();
  if (!home) return [];
  const nestedDirectory = path.join(home, 'sqlite');
  return Array.from(new Set([
    ...listCodexTopLevelStateDbPaths(fs, home),
    ...listStateDbPathsInDirectory(fs, nestedDirectory)
  ])).sort((left, right) => {
    const versionDelta = getStateDbVersion(right) - getStateDbVersion(left);
    if (versionDelta !== 0) return versionDelta;
    const leftNested = path.dirname(left) === nestedDirectory ? 1 : 0;
    const rightNested = path.dirname(right) === nestedDirectory ? 1 : 0;
    if (leftNested !== rightNested) return leftNested - rightNested;
    return left.localeCompare(right);
  });
}

function listCodexTopLevelStateDbPaths(fs, codexHome) {
  const home = String(codexHome || '').trim();
  if (!home) return [];
  return listStateDbPathsInDirectory(fs, home).sort((left, right) => (
    getStateDbVersion(right) - getStateDbVersion(left) || left.localeCompare(right)
  ));
}

module.exports = {
  listCodexStateDbPaths,
  listCodexTopLevelStateDbPaths
};
