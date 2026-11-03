'use strict';

const path = require('node:path');
const { syncDirectory } = require('./durable-directory');

/** Small, secret-free ownership metadata. It is NOT the account migration journal. */
function readMaintenanceOwner(fs, file, allowMissing = false) {
  let item;
  try { item = fs.lstatSync(file); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  if (!item.isFile() || item.isSymbolicLink() || item.nlink > 1 || item.size > 4096) throw new Error('rekey_gate_owner_invalid');
  let owner;
  try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw new Error('rekey_gate_owner_invalid'); }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || !/^[a-f0-9-]{36}$/.test(owner.token || '') || !Number.isSafeInteger(owner.createdAt)
    || (owner.operationId !== undefined && !/^[a-f0-9-]{36}$/.test(owner.operationId))) {
    throw new Error('rekey_gate_owner_invalid');
  }
  return owner;
}

/**
 * Write under the already-held exclusive OS lease. The unique temp file and
 * parent fsync make a crash detectable without importing data-migration code.
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

module.exports = { readMaintenanceOwner, writeMaintenanceOwner };
