'use strict';

const nodePath = require('node:path');

// Reuse the existing maintenance coordination file, not a new peer database.
// Its normal SHARED account leases coexist with this short RESERVED lock.
// No schema/data changes or COMMIT; OS locks release even on process death.
function acquireRecordLock(fs, aiHomeDir) {
  const { acquireAccountMaintenanceLock } = require('../../../runtime/account-maintenance-lock');
  const shared = acquireAccountMaintenanceLock(fs, aiHomeDir);
  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const file = nodePath.join(aiHomeDir, 'run', 'maintenance', 'access.sqlite');
    database = new DatabaseSync(file);
    database.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE');
    return () => {
      try { database.close(); }
      finally { shared.close(); }
    };
  } catch (error) {
    try { database?.close(); }
    finally { shared.close(); }
    throw error;
  }
}

function sameClaim(left, right) {
  return !!(left && right && left.token && left.token === right.token
    && Number(left.generation) > 0 && left.generation === right.generation
    && left.claimedAt === right.claimedAt);
}

module.exports = { acquireRecordLock, sameClaim };
