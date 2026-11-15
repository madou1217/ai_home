'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { resolveUnprojectedHostHomeDir } = require('../../../runtime/host-home');
const { resolveAiHomeDir } = require('../../../runtime/aih-home');

// Account selection, native files, and default state are Go-owned. This narrow
// front-door adapter preserves the existing Desktop/UI integration after the Go
// transaction commits; it never re-runs Node host-sync or writes account pointers.
function tryRunCodexDefaultCommand(args, binary) {
  if (!Array.isArray(args) || String(args[0]).toLowerCase() !== 'codex'
    || !['set-default', 'unset-default'].includes(String(args[1]).toLowerCase())) return false;
  if (!fs.existsSync(binary)) {
    process.stderr.write(`[aih] Go CLI 未构建：${binary}\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n`);
    process.exitCode = 1;
    return true;
  }
  const hostHomeDir = resolveUnprojectedHostHomeDir({ env: process.env, os });
  const aiHomeDir = resolveAiHomeDir({ env: process.env, hostHomeDir });
  const nativeArgs = ['codex', String(args[1]).toLowerCase(), ...args.slice(2)];
  const help = nativeArgs.includes('--help') || nativeArgs.includes('-h');
  const wantsJSON = nativeArgs.includes('--json');
  if (!help && !wantsJSON) nativeArgs.push('--json');
  const child = spawnSync(binary, nativeArgs, {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { ...process.env, AIH_HOME_DIR: aiHomeDir, AIH_HOST_HOME: hostHomeDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error || child.status !== 0) {
    if (child.error) process.stderr.write('[aih] Codex default command unavailable.\n');
    process.exitCode = Number.isInteger(child.status) ? child.status : 1;
    return true;
  }
  if (help) { process.stdout.write(child.stdout || ''); return true; }
  let result;
  try { result = JSON.parse(child.stdout); } catch (_error) {}
  if (!result || result.ok !== true) {
    process.stderr.write('[aih] Invalid Codex default command response.\n');
    process.exitCode = 1;
    return true;
  }
  const effects = [];
  // No installed App is normal, not a pending reload. Other errors remain
  // observable without claiming the already-committed default was rolled back.
  const { createCodexDesktopHookService } = require('../../../server/codex-desktop-hook');
  const { reloadCodexDesktopRuntime } = require('../../../server/codex-desktop-runtime-reload');
  const reload = reloadCodexDesktopRuntime(createCodexDesktopHookService({ fs, path, processObj: process, spawnSync, aiHomeDir, hostHomeDir }));
  if (!reload.ok) effects.push(`Codex App runtime reload pending (${reload.reason}).`);
  if (result.restartClient) {
    const { createDesktopClientRestartService } = require('./desktop-client-restart');
    try {
      const restart = createDesktopClientRestartService({ aiHomeDir, hostHomeDir }).restartDetectedDesktopClient('codex', { forceQuit: result.forceQuit });
      effects.push(restart && (restart.restarted || restart.launched)
        ? 'Codex desktop client restarted.'
        : `Desktop client restart skipped (${String(restart && restart.reason || 'unavailable')}).`);
    } catch (_error) { effects.push('Desktop client restart skipped (restart_failed).'); }
  }
  if (wantsJSON) process.stdout.write(JSON.stringify({ ...result, effects }) + '\n');
  else {
    process.stdout.write(result.gateway
      ? '[Success] Set AIH Server as the default provider for codex.\n'
      : `[Success] Set Account ID ${result.cliAccountId} as default for codex in ai-home and synced host config.\n`);
    for (const message of effects) process.stderr.write(`[aih] ${message}\n`);
  }
  process.exitCode = 0;
  return true;
}

module.exports = { tryRunCodexDefaultCommand };
