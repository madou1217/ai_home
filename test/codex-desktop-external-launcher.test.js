'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { installExternalLauncher, readDesktopLaunchEnv } = require('../lib/server/codex-desktop-external-launcher');
const { createDesktopClientRestartService } = require('../lib/cli/services/ai-cli/desktop-client-restart');
const { writeJsonValue } = require('../lib/server/app-state-store');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-external-launcher-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const upstreamBinaryPath = path.join(root, 'signed-codex');
  const targetBinaryPath = path.join(aiHomeDir, 'run', 'codex', 'desktop-cli');
  const wrapper = '#!/bin/sh\n# aih-codex-desktop-hook\n';
  const isWrapperInstalled = file => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('aih-codex-desktop-hook');
  fs.writeFileSync(upstreamBinaryPath, 'signed-original');
  return { root, aiHomeDir, fs, path, upstreamBinaryPath, targetBinaryPath, wrapper, isWrapperInstalled };
}

test('external launcher preserves the signed original and installs idempotently', context => {
  const options = fixture(context);
  assert.equal(installExternalLauncher(options).ok, true);
  assert.equal(fs.readFileSync(options.upstreamBinaryPath, 'utf8'), 'signed-original');
  assert.equal(fs.existsSync(`${options.upstreamBinaryPath}.aih-original`), false);
  assert.equal(installExternalLauncher(options).unchanged, true);
});

test('external launcher restores a previous in-place hook before launching the signed binary', context => {
  const options = fixture(context);
  fs.renameSync(options.upstreamBinaryPath, `${options.upstreamBinaryPath}.aih-original`);
  fs.writeFileSync(options.upstreamBinaryPath, options.wrapper);
  assert.equal(installExternalLauncher(options).ok, true);
  assert.equal(fs.readFileSync(options.upstreamBinaryPath, 'utf8'), 'signed-original');
  assert.equal(fs.existsSync(`${options.upstreamBinaryPath}.aih-original`), false);
});

test('a missing original fails closed without creating a recursive launcher', context => {
  const options = fixture(context);
  fs.writeFileSync(options.upstreamBinaryPath, options.wrapper);
  assert.deepEqual(installExternalLauncher(options), { ok: false, reason: 'missing_upstream_backup' });
  assert.equal(fs.existsSync(options.targetBinaryPath), false);
});

test('desktop restart passes the enabled external launcher through the supported CLI override', context => {
  const options = fixture(context);
  installExternalLauncher(options);
  const statePath = path.join(path.dirname(options.targetBinaryPath), 'desktop-hook-state.json');
  const state = { enabled: true, hookStrategy: 'external-launcher', targetBinaryPath: options.targetBinaryPath };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const executable = path.join(options.root, 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fixture');
  writeJsonValue(fs, options.aiHomeDir, 'desktop-client-paths', {
    codex: { macos: { executablePath: executable, bundlePath: path.join(options.root, 'ChatGPT.app'), clientName: 'ChatGPT' } }
  });
  const launches = [];
  const service = createDesktopClientRestartService({
    fs, aiHomeDir: options.aiHomeDir, hostHomeDir: options.root,
    processObj: { platform: 'darwin', env: { HOME: options.root } },
    spawnSync: () => ({ status: 0, stdout: '' }),
    spawn: (command, args, launchOptions) => { launches.push({ command, args, launchOptions }); return { unref() {} }; }
  });
  assert.equal(service.restartDetectedDesktopClient('codex').launched, true);
  assert.equal(launches[0].launchOptions.env.CODEX_CLI_PATH, options.targetBinaryPath);
  assert.ok(launches[0].args.includes(`CODEX_CLI_PATH=${options.targetBinaryPath}`));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, enabled: false }));
  assert.deepEqual(readDesktopLaunchEnv(fs, path, options.aiHomeDir), {});
  fs.writeFileSync(statePath, JSON.stringify({ ...state, targetBinaryPath: '/untrusted/launcher' }));
  assert.deepEqual(readDesktopLaunchEnv(fs, path, options.aiHomeDir), {});
});
