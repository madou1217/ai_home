'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Pending host transactions are not safe launch inputs. Refuse managed launch;
// an explicit set-default retries the journal under the shared lock.
function assertCodexHostReady(home, fsImpl = fs) {
  if (!home) return;
  const directories = new Set([home]);
  try { directories.add(fsImpl.realpathSync(home)); } catch (_error) {}
  const candidates = new Set();
  for (const directory of directories) {
    for (const name of ['.aih-default-change.json', 'config.toml.aih-default-conflict', 'auth.json.aih-default-conflict']) {
      candidates.add(path.join(directory, name));
    }
    for (const name of ['config.toml', 'auth.json']) {
      try { candidates.add(`${fsImpl.realpathSync(path.join(directory, name))}.aih-default-conflict`); }
      catch (error) {
        if (!error || error.code !== 'ENOENT') throw new Error('codex_default_recovery_state_unavailable');
      }
    }
  }
  for (const candidate of candidates) {
    try { fsImpl.lstatSync(candidate); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw new Error('codex_default_recovery_state_unavailable');
    }
    throw new Error('codex_default_recovery_required: rerun codex set-default before launching');
  }
}

// All managed healers share the Go writer lock. Lack of a compatible binary is
// an observable heal failure, never permission to write an unlocked old snapshot.
function replaceCodexConfig(configPath, expected, next, options = {}) {
  const binary = options.binary || path.join(__dirname, '..', '..', 'bin', 'native',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  assertCodexHostReady(path.dirname(configPath), options.fs || fs);
  const result = spawnSync(binary, ['codex', 'effort', '--replace-config', path.resolve(configPath)], {
    input: JSON.stringify({ expected, next }), encoding: 'utf8',
    timeout: 10000, maxBuffer: 65536, windowsHide: true
  });
  if (result.error || result.status !== 0) throw new Error('codex_config_edit_rejected');
}

module.exports = { assertCodexHostReady, replaceCodexConfig };
