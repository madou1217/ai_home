'use strict';

const path = require('node:path');

function maintenanceGatePath(aiHomeDir) {
  return path.join(aiHomeDir, 'run', 'maintenance', 'oauth-rekey.lock');
}

/**
 * A persistent gate is fail-closed after a crash; a PID becoming stale is not
 * proof that the SQLite/filesystem transaction completed. Only the maintenance
 * recovery command may clear it after reconciling the transaction marker.
 */
function assertAccountMaintenanceAvailable(fs, aiHomeDir) {
  if (!aiHomeDir || typeof fs?.existsSync !== 'function') return;
  let present;
  if (typeof fs.lstatSync === 'function') {
    try { fs.lstatSync(maintenanceGatePath(aiHomeDir)); present = true; }
    catch (error) {
      if (error.code === 'ENOENT') present = false;
      else throw error; // An inaccessible gate is not evidence of availability.
    }
  } else present = fs.existsSync(maintenanceGatePath(aiHomeDir));
  if (present) {
    const error = new Error('account_maintenance_in_progress');
    error.code = 'account_maintenance_in_progress';
    throw error;
  }
}

/** Startup backstop for a lost gate: incomplete durable journals remain a stop. */
function assertNoUnfinishedMaintenance(fs, aiHomeDir) {
  const directory = path.join(aiHomeDir, 'migration');
  let entries;
  try { entries = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of entries) {
    if (!/^oauth-rekey-[a-f0-9-]{36}$/.test(name)) continue;
    const file = path.join(directory, name, 'journal.json');
    let journal;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024 * 1024) throw new Error();
      journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { throw new Error('account_maintenance_journal_unverifiable'); }
    if (!['completed', 'rolled_back'].includes(journal.state)) throw new Error('account_maintenance_recovery_required');
  }
}

module.exports = { maintenanceGatePath, assertAccountMaintenanceAvailable, assertNoUnfinishedMaintenance };
