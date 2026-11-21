'use strict';

const path = require('node:path');
const { syncDirectory } = require('./durable-directory');

/**
 * Small, secret-free ownership metadata for a held maintenance lease. Written
 * under the already-held exclusive OS lease: the unique temp file and parent
 * fsync make a crash detectable.
 */
function writeMaintenanceOwner(fs, file, owner) {
  const temporary = `${file}.${owner.token}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, JSON.stringify(owner));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(fs, path.dirname(file));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

module.exports = { writeMaintenanceOwner };
