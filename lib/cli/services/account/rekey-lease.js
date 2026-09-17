'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { maintenanceGatePath } = require('../../../runtime/account-maintenance-gate');
const { syncDirectory } = require('../../../runtime/durable-directory');
const { readMaintenanceOwner, writeMaintenanceOwner } = require('../../../runtime/maintenance-owner-file');

/**
 * This guard does not kill processes. Service draining is a separate explicit
 * operation. lsof must prove no other database opener before/while applying;
 * missing lsof or ambiguous output is a failure, never 'quiet'. A database
 * write transaction additionally serializes non-cooperating SQLite writers.
 */
function assertNoDatabaseOpeners(databasePath, options = {}) {
  const execute = options.execFileSync || execFileSync;
  let output = '';
  try {
    output = execute('lsof', ['-t', '--', databasePath], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    if (error.status !== 1 || String(error.stdout || '').trim()) throw new Error('rekey_quiescence_unverifiable');
    // No matching opener is exit 1 with no diagnostics; inaccessible files
    // must not be mistaken for an idle database.
    if (String(error.stderr || '').trim()) throw new Error('rekey_quiescence_unverifiable');
    output = '';
  }
  const pids = String(output).trim().split(/\s+/).filter(Boolean);
  if (pids.some(pid => !/^\d+$/.test(pid))) throw new Error('rekey_quiescence_unverifiable');
  if (pids.some(pid => Number(pid) !== (options.pid || process.pid))) throw new Error('rekey_database_openers_active');
}

/** Older detached native clients may predate the shared lease protocol. */
function assertNoMappedRuntimeProcesses(mapping, options = {}) {
  const pairs = Array.isArray(mapping) ? mapping : [];
  if (!pairs.length) return;
  const needles = pairs.flatMap(([oldRef]) => [oldRef, oldRef.replace('_', '')]);
  let output;
  try {
    output = (options.execFileSync || execFileSync)('ps', ['-axo', 'pid=,args='], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (_) { throw new Error('rekey_runtime_quiescence_unverifiable'); }
  for (const line of String(output).split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error('rekey_runtime_quiescence_unverifiable');
    if (Number(match[1]) !== process.pid && needles.some(needle => match[2].includes(needle))) {
      // No raw command line is exposed: upstream CLIs may put sensitive input
      // in argv. The operator only receives a stable actionable error code.
      throw new Error('rekey_runtime_process_active');
    }
  }
}

function acquireRekeyLease(aiHomeDir, options = {}) {
  const io = options.fs || fs;
  const { acquireAccountMaintenanceLock } = require('../../../runtime/account-maintenance-lock');
  // OS-exclusive ownership is acquired before examining a stale recovery gate.
  // Concurrent recoveries cannot both claim a dead PID and move the same files.
  const ownership = acquireAccountMaintenanceLock(io, aiHomeDir, { exclusive: true, timeoutMs: 100 });
  const lockPath = maintenanceGatePath(aiHomeDir);
  const parent = path.dirname(lockPath);
  const token = crypto.randomUUID();
  const databasePath = path.join(aiHomeDir, 'app-state.db');
  const assertQuiet = options.assertQuiet || (() => {
    assertNoDatabaseOpeners(databasePath, options);
    assertNoMappedRuntimeProcesses(options.mapping, options);
  });
  let created = false;
  let retained = false;
  let previousToken = '';
  let previousOperationId = '';
  if (options.operationId !== undefined && !/^[a-f0-9-]{36}$/.test(options.operationId)) {
    ownership.close(); throw new Error('rekey_operation_id_invalid');
  }
  try {
    if (options.recover === true) {
      let gate;
      try { gate = io.lstatSync(lockPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; io.mkdirSync(lockPath, { mode: 0o700 }); syncDirectory(io, parent); gate = io.lstatSync(lockPath); }
      if (!gate.isDirectory() || gate.isSymbolicLink()) throw new Error('rekey_gate_owner_invalid');
      const ownerPath = path.join(lockPath, 'owner.json');
      const previous = readMaintenanceOwner(io, ownerPath, true);
      previousToken = previous?.token || '';
      previousOperationId = previous?.operationId || previousToken;
      if (options.operationId && previousOperationId && options.operationId !== previousOperationId) {
        throw new Error('rekey_preparation_owner_mismatch');
      }
    } else {
      require('../../../runtime/account-maintenance-gate').assertNoUnfinishedMaintenance(io, aiHomeDir);
      io.mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      syncDirectory(io, parent);
    }
    assertQuiet();
    // Ownership token changes at every recovery; the transaction identity must
    // not. Otherwise a second crash before journal publication loses its owner.
    const operationId = options.operationId || previousOperationId || token;
    writeMaintenanceOwner(io, path.join(lockPath, 'owner.json'), { pid: process.pid, token, operationId, createdAt: Date.now() });
    syncDirectory(io, parent);
    let released = false;
    return {
      token,
      previousToken,
      previousOperationId,
      operationId,
      assertQuiet,
      retain() { retained = true; },
      release() {
        if (released) return;
        released = true;
        try {
          if (retained) return;
          const owner = readMaintenanceOwner(io, path.join(lockPath, 'owner.json'));
          if (owner.token !== token) throw new Error('rekey_lease_ownership_changed');
          io.unlinkSync(path.join(lockPath, 'owner.json'));
          io.rmdirSync(lockPath);
          syncDirectory(io, parent);
        } finally { ownership.close(); }
      }
    };
  } catch (error) {
    if (created) {
      try { io.rmdirSync(lockPath); syncDirectory(io, parent); } catch (_) { /* Ambiguous state remains gated. */ }
    }
    ownership.close();
    throw error;
  }
}

module.exports = { acquireRekeyLease, assertNoDatabaseOpeners, assertNoMappedRuntimeProcesses };
