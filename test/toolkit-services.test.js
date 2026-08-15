'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listManagedApps,
  installAppHooks,
  getProviderConfigPath,
  findDesktopClientRecord,
  getBinaryVersion
} = require('../lib/cli/services/toolkit/app-manager');
const {
  detectNodeEnvironment,
  detectPythonEnvironment,
  getEnvironmentsSummary
} = require('../lib/cli/services/toolkit/env-manager');
const {
  NPM_PRESETS,
  PIP_PRESETS,
  getCurrentNpmRegistry,
  getCurrentPipIndexUrl,
  getMirrorsStatus
} = require('../lib/cli/services/toolkit/mirror-manager');
const {
  CONNECTIVITY_TARGETS,
  getProxyStatus
} = require('../lib/cli/services/toolkit/proxy-manager');

test('app-manager listManagedApps returns structured apps list', async () => {
  const result = await listManagedApps();
  assert.equal(result.ok, true);
  assert.ok(result.total > 0);
  assert.ok(Array.isArray(result.apps));

  const claudeApp = result.apps.find((a) => a.id === 'claude');
  assert.ok(claudeApp, 'Claude app should exist');
  assert.equal(claudeApp.provider, 'claude');
  assert.ok(claudeApp.categories.includes('CLI Code'));
  assert.ok(claudeApp.categories.includes('ALL'));

  const desktopApp = result.apps.find((a) => a.id === 'claude-desktop');
  assert.ok(desktopApp, 'Claude Desktop app should exist');
  assert.ok(desktopApp.categories.includes('Desktop'));
});

test('app-manager getProviderConfigPath resolves known provider paths', () => {
  const hostHome = '/fake/home';
  const claudePath = getProviderConfigPath('claude', hostHome);
  assert.ok(claudePath.includes('.claude'));
  const codexPath = getProviderConfigPath('codex', hostHome);
  assert.ok(codexPath.includes('.codex'));
});

test('app-manager resolves the merged ChatGPT desktop executable on Windows and Linux', () => {
  const cases = [
    {
      platform: 'win32',
      hostHomeDir: 'C:\\Users\\tester',
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      target: 'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe'
    },
    {
      platform: 'linux',
      hostHomeDir: '/home/tester',
      env: {},
      target: '/usr/bin/ChatGPT'
    }
  ];

  for (const item of cases) {
    const record = findDesktopClientRecord('codex', {
      platform: item.platform,
      hostHomeDir: item.hostHomeDir,
      env: item.env,
      fs: { existsSync: (candidate) => candidate === item.target },
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' })
    });

    assert.ok(record, `${item.platform} ChatGPT executable should be detected`);
    assert.equal(record.executablePath, item.target);
    assert.equal(record.clientName, 'ChatGPT');
  }
});

test('app-manager presents the merged Codex desktop client as ChatGPT and parses desktop versions', async () => {
  const result = await listManagedApps({
    platform: 'darwin',
    hostHomeDir: '/home/tester',
    fs: {
      existsSync(candidate) {
        return candidate === '/Applications/ChatGPT.app'
          || candidate === '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
      },
      readFileSync() {
        return '<key>CFBundleShortVersionString</key><string>26.727</string>';
      }
    },
    spawnSync() {
      return { status: 1, stdout: '', stderr: '' };
    }
  });

  const desktop = result.apps.find((app) => app.id === 'codex-desktop');
  assert.equal(desktop.name, 'ChatGPT');
  assert.equal(desktop.version, '26.727');
  assert.equal(getBinaryVersion('/usr/bin/example', {
    spawnSync() {
      return { status: 0, stdout: 'example 3.7b\n', stderr: '' };
    }
  }), '3.7b');
});

test('env-manager detects Node and Python environments', () => {
  const nodeEnv = detectNodeEnvironment();
  assert.equal(nodeEnv.name, 'Node.js');
  assert.ok(typeof nodeEnv.currentVersion === 'string');
  assert.ok(nodeEnv.packageManagers);

  const pythonEnv = detectPythonEnvironment();
  assert.equal(pythonEnv.name, 'Python');
  assert.ok(typeof pythonEnv.currentVersion === 'string');

  const summary = getEnvironmentsSummary();
  assert.equal(summary.ok, true);
  assert.ok(summary.environments.node);
  assert.ok(summary.environments.python);
});

test('mirror-manager returns presets and status', async () => {
  assert.ok(NPM_PRESETS.length >= 3);
  assert.ok(PIP_PRESETS.length >= 3);

  const status = await getMirrorsStatus();
  assert.equal(status.ok, true);
  assert.ok(status.npm);
  assert.ok(status.pip);
  assert.ok(Array.isArray(status.npm.presets));
  assert.ok(Array.isArray(status.pip.presets));
});

test('proxy-manager returns proxy status and connectivity targets', () => {
  assert.ok(CONNECTIVITY_TARGETS.length >= 3);
  const status = getProxyStatus();
  assert.equal(status.ok, true);
  assert.ok(status.env);
  assert.ok(status.tools);
  assert.ok(status.tools.git);
  assert.ok(status.tools.npm);
});
