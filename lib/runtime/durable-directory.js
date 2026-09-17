'use strict';

function syncDirectory(fs, directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** Validate a private coordination directory without following a symlink. */
function ensurePrivateDirectory(fs, directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const item = fs.lstatSync(directory);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('maintenance_directory_invalid');
}

/** Persist a new child entry in its parent before relying on it after a crash. */
function ensureDurableDirectory(fs, directory, parent) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(fs, parent); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const item = fs.lstatSync(directory);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('maintenance_directory_invalid');
}

module.exports = { syncDirectory, ensureDurableDirectory, ensurePrivateDirectory };
