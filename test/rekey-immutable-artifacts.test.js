'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { immutableArtifactReason } = require('../lib/cli/services/account/rekey-immutable-artifacts');

function files(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-resource-policy-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  return (relative, bytes) => { const p=path.join(root,relative); fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);return immutableArtifactReason(fs,relative,p); };
}

test('only stamped configuration archives and uppercase Chromium diagnostic logs are immutable', t => {
  const inspect=files(t);
  assert.equal(inspect('run/app/electron-user-data/Default/Local Storage/leveldb/LOG','old ref'),'chromium_leveldb_diagnostic');
  assert.equal(inspect('run/app/electron-user-data/Default/Local Storage/leveldb/000031.log','database record'),'');
  assert.equal(inspect('run/app/custom/LOG','maybe config'),'');
  assert.equal(inspect('run/app/.codex/config.toml.aih-bak-2026-09-14T15-14-18-705Z','snapshot'),'archived_config_snapshot');
  assert.equal(inspect('run/app/.codex/config.toml','current'),'');
});

test('download location alone is not enough to exempt a script or unknown resource', t => {
  const inspect=files(t), cache='run/app/electron-user-data/component_crx_cache/'+'a'.repeat(64);
  assert.equal(inspect(cache,Buffer.concat([Buffer.from('Cr24'),Buffer.alloc(20)])),'signed_extension_cache');
  assert.equal(inspect(cache,'potential config'),'');
  assert.equal(inspect('run/app/.local/bin/agy',Buffer.from('cffaedfe00000000','hex')),'installed_native_binary');
  assert.equal(inspect('run/app/.local/bin/agy','#!/bin/sh\nrun old-account'),'');
  assert.equal(inspect('run/app/unknown-binary',Buffer.from('cffaedfe00000000','hex')),'');
});
