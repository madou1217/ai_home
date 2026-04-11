'use strict';

function ensureDirSync(fs, targetPath) {
  if (!fs || !targetPath) return;
  if (typeof fs.ensureDirSync === 'function') {
    fs.ensureDirSync(targetPath);
    return;
  }
  if (typeof fs.mkdirpSync === 'function') {
    fs.mkdirpSync(targetPath);
    return;
  }
  if (typeof fs.mkdirSync === 'function') {
    fs.mkdirSync(targetPath, { recursive: true });
    return;
  }
  throw new Error('fs_missing_directory_creation_api');
}

module.exports = {
  ensureDirSync
};
