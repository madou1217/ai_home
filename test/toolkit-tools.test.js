'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TOOLKIT_TOOL_CATEGORIES,
  listManagedTools,
  readManagedToolConfig,
  saveManagedToolConfig
} = require('../lib/cli/services/toolkit/tool-manager');

function createHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-toolkit-tools-'));
}

function createProbeOptions(home) {
  const paths = {
    tmux: '/usr/bin/tmux',
    herdr: '/usr/bin/herdr',
    frpc: '/usr/bin/frpc',
    frps: '/usr/bin/frps',
    tailscale: '/usr/bin/tailscale',
    cloudflared: '/usr/bin/cloudflared'
  };
  const versions = {
    tmux: 'tmux 3.7b\n',
    herdr: 'herdr 0.8.0\n',
    frpc: 'frpc version 0.71.0\n',
    frps: 'frps version 0.71.0\n',
    tailscale: '1.102.2\n',
    cloudflared: 'cloudflared version 2026.8.2\n'
  };
  return {
    platform: 'linux',
    hostHomeDir: home,
    env: {},
    resolveCommandPath(name) {
      return paths[name] || '';
    },
    spawnSync(command, args) {
      const name = path.basename(command);
      if (name === 'tailscale' && args[0] === 'version') {
        return { status: 0, stdout: versions.tailscale, stderr: '' };
      }
      return { status: 0, stdout: versions[name] || '', stderr: '' };
    }
  };
}

test('tool-manager exposes runtime and network categories without absolute paths', () => {
  const home = createHome();
  const result = listManagedTools(createProbeOptions(home));

  assert.deepEqual(
    TOOLKIT_TOOL_CATEGORIES.map((category) => category.id),
    ['session-runtimes', 'network-access']
  );
  assert.deepEqual(
    result.categories.map((category) => category.id),
    ['session-runtimes', 'network-access']
  );

  const herdr = result.tools.find((tool) => tool.id === 'herdr');
  const cloudflared = result.tools.find((tool) => tool.id === 'cloudflared');
  assert.equal(herdr.version, '0.8.0');
  assert.equal(cloudflared.version, '2026.8.2');
  assert.equal(Object.prototype.hasOwnProperty.call(herdr, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cloudflared, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cloudflared, 'configPath'), false);
});

test('tool-manager edits an allowlisted frpc config without returning its path', () => {
  const home = createHome();
  const configPath = path.join(home, '.config', 'frp', 'frpc.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'serverAddr = "127.0.0.1"\n', 'utf8');

  const options = {
    ...createProbeOptions(home),
    fs,
    hostHomeDir: home
  };
  const before = readManagedToolConfig('frpc', options);
  assert.equal(before.configName, 'frpc.toml');
  assert.equal(Object.prototype.hasOwnProperty.call(before, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(before, 'configPath'), false);

  const saved = saveManagedToolConfig(
    'frpc',
    'serverAddr = "192.0.2.10"\n',
    { ...options, expectedRevision: before.revision }
  );

  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'serverAddr = "192.0.2.10"\n');
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'path'), false);
});

test('tool-manager detects Windows psmux from the WinGet Links location', () => {
  const psmuxPath = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const result = listManagedTools({
    platform: 'win32',
    hostHomeDir: 'C:\\Users\\tester',
    env: {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
    },
    fs: {
      existsSync(candidate) {
        return candidate === psmuxPath;
      },
      accessSync() {}
    },
    resolveCommandPath() {
      return '';
    },
    spawnSync(command, args) {
      assert.equal(command, psmuxPath);
      assert.deepEqual(args, ['-V']);
      return { status: 0, stdout: 'psmux 0.1.4\\n', stderr: '' };
    }
  });

  const psmux = result.tools.find((tool) => tool.id === 'psmux');
  assert.equal(psmux.installed, true);
  assert.equal(psmux.binaryName, 'psmux.exe');
  assert.equal(psmux.version, '0.1.4');
});

test('tool-manager resolves Windows FRP and Cloudflare config names without exposing paths', () => {
  const home = 'C:\\Users\\tester';
  const programData = 'C:\\ProgramData';
  const frpcPath = `${programData}\\frp\\frpc.toml`;
  const cloudflaredPath = `${programData}\\cloudflared\\config.yml`;
  const existing = new Set([frpcPath, cloudflaredPath]);
  const result = listManagedTools({
    platform: 'win32',
    hostHomeDir: home,
    env: { PROGRAMDATA: programData, APPDATA: `${home}\\AppData\\Roaming` },
    fs: {
      existsSync(candidate) { return existing.has(candidate); },
      accessSync() {}
    },
    resolveCommandPath() { return ''; }
  });

  const frpc = result.tools.find((tool) => tool.id === 'frpc');
  const cloudflared = result.tools.find((tool) => tool.id === 'cloudflared');
  assert.equal(frpc.configName, 'frpc.toml');
  assert.equal(frpc.configExists, true);
  assert.equal(cloudflared.configName, 'config.yml');
  assert.equal(cloudflared.configExists, true);
  assert.equal(Object.prototype.hasOwnProperty.call(frpc, 'configPath'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cloudflared, 'configPath'), false);
});
