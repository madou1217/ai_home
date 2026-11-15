'use strict';

// Recovery gate handoff is itself durable. The gate is staged completely before
// no-overwrite rename; retained receipts/quarantines are never recursively erased.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const layout = require('../../../../contracts/backuprepository/format.json');
const { writeSftpStage } = require('../../../runtime/sftp-stage');
const HASH = /^[a-f0-9]{64}$/, TOKEN = /^[a-f0-9]{48}$/;
const gate = 'v2/.recovery-lock';

async function repositoryRecoveryAccess(session, baseDir, joinRemote, timeoutMs) {
  const absolute = (relative) => joinRemote(baseDir, relative);
  const call = (method, args) => session.call(method, args, { timeoutMs });
  const read = async (relative, limit) => {
    const file = absolute(relative); let handle;
    try { handle = await call('open', [file, 'r']); } catch (e) { if (e.code === 2) return null; throw e; }
    const parts = []; let count = 0;
    try {
      for (;;) {
        const b = Buffer.alloc(Math.min(32768, limit + 1 - count));
        const n = await call('read', [handle, b, 0, b.length, count]);
        if (!n) break;
        count += n; if (count > limit) throw new Error('backup_recovery_record_too_large');
        parts.push(b.subarray(0, n));
      }
      return Buffer.concat(parts, count);
    } finally { if (!session.closed()) await call('close', [handle]); }
  };
  const readGate = async () => {
    const raw = await read(`${gate}/request.json`, 4096);
    if (!raw) return null;
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch (_) { throw new Error('backup_recovery_gate_invalid'); }
    if (value.kind !== 'aih-backup-recovery' || value.version !== 2 || !TOKEN.test(value.token) || !TOKEN.test(value.sourceOwner)
      || (value.intentSha256 !== '' && !HASH.test(value.intentSha256))) throw new Error('backup_recovery_gate_invalid');
    return value;
  };
  const ownerAt = async (relative) => {
    const raw = await read(`${relative}/owner`, 1024);
    if (!raw) return '';
    const value = raw.toString();
    if (!/^[a-f0-9]{48}\n$/.test(value)) throw new Error('backup_recovery_owner_invalid');
    return value.slice(0, -1);
  };
  const archivePath = (owner) => `v2/.recovery-${owner}`;
  const inspect = async () => {
    const receipt = await readGate();
    const owner = await ownerAt(layout.lockPath);
    const source = receipt ? archivePath(receipt.sourceOwner) : layout.lockPath;
    let intent = await read(`${source}/intent.json`, 4096);
    if (receipt && !(await ownerAt(source))) {
      // Gate may have been committed immediately before the first lock rename.
      if (owner !== receipt.sourceOwner) throw new Error('backup_recovery_source_missing');
      intent = await read(`${layout.lockPath}/intent.json`, 4096);
    }
    const attempt = receipt ? await ownerAt(`${gate}/attempt`) : '';
    return { owner, intent, receipt, attempt };
  };
  return {
    read,
    inspect,
    async claim(expectedOwner, recoveryToken, expectedAttempt) {
      const before = await inspect();
      let receipt = before.receipt;
      if (receipt) {
        if (recoveryToken !== receipt.token) throw new Error('backup_recovery_token_required');
      } else {
        if (!TOKEN.test(expectedOwner) || before.owner !== expectedOwner) throw new Error('backup_lock_ownership_changed');
        receipt = { kind: 'aih-backup-recovery', version: 2, token: crypto.randomBytes(24).toString('hex'), sourceOwner: expectedOwner,
          intentSha256: before.intent ? crypto.createHash('sha256').update(before.intent).digest('hex') : '' };
        const stage = `v2/.recovery-stage-${receipt.token}`;
        await call('mkdir', [absolute(stage), { mode: 0o700 }]);
        await writeSftpStage(call, absolute(`${stage}/request.json`), Buffer.from(`${JSON.stringify(receipt)}\n`), { mode: 0o600 });
        try { await call('rename', [absolute(stage), absolute(gate)]); }
        catch (error) { if (typeof error.code === 'number') { const conflict = new Error('backup_recovery_busy'); conflict.code = 'backup_recovery_busy'; throw conflict; } throw error; }
      }
      // A receipt authorizes continuation, not concurrent execution. A
      // retained attempt needs an explicit stopped-attempt token to supersede.
      const oldAttempt = await ownerAt(`${gate}/attempt`);
      if (oldAttempt) {
        if (expectedAttempt !== oldAttempt) throw new Error('backup_recovery_attempt_required');
        // Deterministic no-overwrite archive prevents a delayed contender from
        // quarantining the next attempt after the old attempt has moved.
        try { await call('rename', [absolute(`${gate}/attempt`), absolute(`${gate}/.attempt-${oldAttempt}`)]); }
        catch (error) { if (typeof error.code === 'number') { const busy = new Error('backup_recovery_attempt_superseded'); busy.code = 'backup_recovery_attempt_superseded'; throw busy; } throw error; }
      } else if (expectedAttempt) {
        const archived = await ownerAt(`${gate}/.attempt-${expectedAttempt}`);
        if (archived) throw new Error('backup_recovery_attempt_superseded');
      }
      const attempt = crypto.randomBytes(24).toString('hex');
      const attemptStage = `${gate}/.attempt-stage-${attempt}`;
      await call('mkdir', [absolute(attemptStage), { mode: 0o700 }]);
      await writeSftpStage(call, absolute(`${attemptStage}/owner`), Buffer.from(`${attempt}\n`), { mode: 0o600 });
      try { await call('rename', [absolute(attemptStage), absolute(`${gate}/attempt`)]); }
      catch (error) { if (typeof error.code === 'number') { const busy = new Error('backup_recovery_busy'); busy.code = 'backup_recovery_busy'; throw busy; } throw error; }
      const currentReceipt = await readGate();
      if (currentReceipt?.token !== receipt.token) throw new Error('backup_recovery_gate_changed');
      const currentOwner = await ownerAt(layout.lockPath);
      if (currentOwner && currentOwner !== expectedOwner) throw new Error('backup_lock_ownership_changed');
      if (!currentOwner && expectedOwner !== receipt.sourceOwner && expectedOwner !== '') throw new Error('backup_lock_ownership_changed');
      if (currentOwner) {
        const quarantine = archivePath(currentOwner);
        if (await ownerAt(quarantine)) throw new Error('backup_recovery_archive_exists');
        await call('rename', [absolute(layout.lockPath), absolute(quarantine)]);
      }
      const source = archivePath(receipt.sourceOwner);
      if (await ownerAt(source) !== receipt.sourceOwner) throw new Error('backup_recovery_source_missing');
      const intent = await read(`${source}/intent.json`, 4096);
      const hash = intent ? crypto.createHash('sha256').update(intent).digest('hex') : '';
      if (hash !== receipt.intentSha256) throw new Error('backup_recovery_intent_changed');
      return { receipt, intent, attempt, path: source,
        async finish() {
          const actual = await readGate();
          if (actual?.token !== receipt.token || await ownerAt(`${gate}/attempt`) !== attempt) throw new Error('backup_recovery_gate_changed');
          await call('rename', [absolute(gate), absolute(`v2/.recovered-${receipt.token}`)]);
        },
        async replacementEvidence() {
          const active = `${layout.manifestPath}.aih-replace-lock`;
          const savedPrefix = `.recovery-${receipt.token}-manifest-replace-`;
          const baseEntries = await call('readdir', [absolute('v2')]);
          const archives = baseEntries.filter((e) => e.filename.startsWith(savedPrefix) && e.attrs.isDirectory?.()).map((e) => `v2/${e.filename}`);
          const previous = []; let activeExists = false;
          for (const relative of [active, ...archives]) {
            let list;
            try { list = await call('readdir', [absolute(relative)]); }
            catch (e) { if (relative === active && e.code === 2) continue; throw e; }
            if (relative === active) activeExists = true;
            for (const entry of list) {
              if (entry.filename === '.' || entry.filename === '..') continue;
              if (!/^previous-[a-f0-9]{24}$/.test(entry.filename) || !entry.attrs.isFile?.()) throw new Error('backup_recovery_auxiliary_unknown');
              const raw = await read(`${relative}/${entry.filename}`, layout.maxManifestBytes);
              previous.push(crypto.createHash('sha256').update(raw).digest('hex'));
            }
          }
          if (!activeExists && !archives.length) return null;
          return { previous, async quarantine() {
            if (activeExists) await call('rename', [absolute(active), absolute(`v2/${savedPrefix}${attempt}`)]);
          } };

        }
      };
    }
  };
}
module.exports = { repositoryRecoveryAccess };
