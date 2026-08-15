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
const {
  readProcessEntries,
  readStartupEntries
} = require('../lib/cli/services/toolkit/frp-discovery');
const {
  parseSystemdUnit,
  DEFAULT_DISCOVERY_MAX_BUFFER,
  DEFAULT_DISCOVERY_TIMEOUT_MS
} = require('../lib/cli/services/toolkit/host-runtime-discovery');
const {
  discoverNetworkTools
} = require('../lib/cli/services/toolkit/network-tool-discovery');

function createHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-toolkit-tools-'));
}

function createProbeOptions(home) {
  const paths = {
    tmux: '/usr/bin/tmux',
    herdr: '/usr/bin/herdr',
    frpc: '/usr/bin/frpc',
    frps: '/usr/bin/frps',
    cloudflared: '/usr/bin/cloudflared'
  };
  const versions = {
    tmux: 'tmux 3.7b\n',
    herdr: 'herdr 0.8.0\n',
    frpc: 'frpc version 0.71.0\n',
    frps: 'frps version 0.71.0\n',
    cloudflared: 'cloudflared version 2026.8.2\n'
  };
  return {
    platform: 'linux',
    hostHomeDir: home,
    env: {},
    processEntries: [],
    startupEntries: [],
    resolveCommandPath(name) {
      return paths[name] || '';
    },
    spawnSync(command, args) {
      const name = path.basename(command);
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
  assert.equal(result.tools.some((tool) => tool.id === 'tailscale'), false);
  assert.equal(herdr.version, '0.8.0');
  assert.equal(cloudflared.version, '2026.8.2');
  assert.equal(Object.prototype.hasOwnProperty.call(herdr, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cloudflared, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cloudflared, 'configPath'), false);
});

test('tool-manager discovers a running frpc config from process arguments', () => {
  const home = createHome();
  const configPath = path.join(home, 'runtime', 'frpc.yaml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'serverAddr: 127.0.0.1\n', 'utf8');

  const result = listManagedTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    resolveCommandPath() { return ''; },
    processEntries: [{
      pid: 321,
      name: 'frpc',
      executablePath: '/opt/frpc',
      commandLine: `/opt/frpc --config ${configPath}`
    }],
    startupEntries: []
  });

  const frpc = result.tools.find((tool) => tool.id === 'frpc');
  assert.equal(frpc.installed, true);
  assert.equal(frpc.running, true);
  assert.equal(frpc.runningCount, 1);
  assert.equal(frpc.configName, 'frpc.yaml');
  assert.equal(frpc.configSource, 'running-process');
  assert.equal(frpc.configEditable, true);
});

test('tool-manager discovers a stopped frps config from a startup task', () => {
  const home = createHome();
  const configPath = path.join(home, 'services', 'server.ini');
  const executablePath = path.join(home, 'bin', 'frps');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(configPath, '[common]\nbindPort = 7000\n', 'utf8');
  fs.writeFileSync(executablePath, '', 'utf8');

  const result = listManagedTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    resolveCommandPath() { return ''; },
    processEntries: [],
    startupEntries: [{
      source: 'systemd',
      name: 'edge-frps.service',
      commandLine: `${executablePath} -c ${configPath}`,
      enabled: true
    }]
  });

  const frps = result.tools.find((tool) => tool.id === 'frps');
  assert.equal(frps.installed, true);
  assert.equal(frps.running, false);
  assert.equal(frps.startupManaged, true);
  assert.deepEqual(frps.startupSources, ['systemd']);
  assert.equal(frps.configName, 'server.ini');
  assert.equal(frps.configSource, 'systemd');
});

test('tool-manager does not advertise a frpc config editor when no config exists', () => {
  const result = listManagedTools({
    platform: 'linux',
    hostHomeDir: createHome(),
    fs,
    resolveCommandPath() { return ''; },
    processEntries: [],
    startupEntries: []
  });

  const frpc = result.tools.find((tool) => tool.id === 'frpc');
  assert.equal(frpc.installed, false);
  assert.equal(frpc.running, false);
  assert.equal(frpc.configExists, false);
  assert.equal(frpc.configName, '');
  assert.equal(frpc.configEditable, false);
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
  assert.match(before.targetRevision, /^[a-f0-9]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(before, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(before, 'configPath'), false);
  assert.throws(
    () => saveManagedToolConfig('frpc', 'serverAddr = "unsafe"\n', {
      ...options,
      expectedRevision: before.revision
    }),
    (error) => error && error.code === 'config_target_changed'
  );

  const saved = saveManagedToolConfig(
    'frpc',
    'serverAddr = "192.0.2.10"\n',
    {
      ...options,
      expectedRevision: before.revision,
      expectedTargetRevision: before.targetRevision
    }
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
    processEntries: [],
    startupEntries: [],
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

test('host runtime discovery bounds process probes and parses a Linux snapshot', () => {
  const entries = readProcessEntries({
    platform: 'linux',
    fs: {},
    spawnSync(command, args, spawnOptions) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-ww', '-axo', 'pid=,ppid=,command=']);
      assert.equal(spawnOptions.timeout, DEFAULT_DISCOVERY_TIMEOUT_MS);
      assert.equal(spawnOptions.maxBuffer, DEFAULT_DISCOVERY_MAX_BUFFER);
      return { status: 0, stdout: '  41   1 /usr/local/bin/frpc --config /etc/frp/edge.yaml\n' };
    }
  });

  assert.deepEqual(entries, [{
    pid: 41,
    parentPid: 1,
    commandLine: '/usr/local/bin/frpc --config /etc/frp/edge.yaml',
    cwd: ''
  }]);
});

test('frp discovery reads Windows services, scheduled tasks, and startup commands', () => {
  const entries = readStartupEntries({
    platform: 'win32',
    spawnSync(command, args) {
      assert.equal(command, 'powershell.exe');
      const script = args[3];
      assert.match(script, /Get-ScheduledTask/);
      assert.match(script, /Win32_StartupCommand/);
      assert.match(script, /Win32_Service/);
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Source: 'scheduled-task',
            Name: 'FRP Client',
            TaskPath: '\\',
            Execute: 'C:\\Tools\\frpc.exe',
            Arguments: '-c C:\\ProgramData\\frp\\frpc.yaml',
            WorkingDirectory: 'C:\\Tools',
            State: 'Ready'
          },
          {
            Source: 'startup-command',
            Name: 'FRP Startup',
            Command: 'C:\\Tools\\frps.exe --config C:\\ProgramData\\frp\\frps.toml',
            Location: 'HKLM'
          },
          {
            Source: 'windows-service',
            Name: 'frpc',
            PathName: '"C:\\Tools\\frpc.exe" -c C:\\ProgramData\\frp\\frpc.yaml',
            StartMode: 'Auto',
            State: 'Running'
          }
        ])
      };
    }
  });

  assert.deepEqual(entries.map((entry) => entry.source), [
    'scheduled-task',
    'startup-command',
    'windows-service'
  ]);
  assert.equal(entries[0].enabled, true);
  assert.equal(entries[2].enabled, true);
  assert.match(entries[1].commandLine, /frps\.exe/);
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
    resolveCommandPath() { return ''; },
    processEntries: [],
    startupEntries: []
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

test('network discovery prioritizes a running FRP config over environment fallbacks', () => {
  const home = createHome();
  const runningConfig = path.join(home, 'runtime', 'active.toml');
  const environmentConfig = path.join(home, 'environment.toml');
  fs.mkdirSync(path.dirname(runningConfig), { recursive: true });
  fs.writeFileSync(runningConfig, 'serverAddr = "active"\n', 'utf8');
  fs.writeFileSync(environmentConfig, 'serverAddr = "stale"\n', 'utf8');

  const result = discoverNetworkTools({
    platform: 'linux',
    hostHomeDir: home,
    env: { FRPC_CONFIG: environmentConfig },
    fs,
    processEntries: [{
      pid: 99,
      executablePath: '/usr/local/bin/frpc',
      commandLine: `/usr/local/bin/frpc -c ${runningConfig}`
    }],
    startupEntries: []
  });

  assert.equal(result.frpc.configPath, runningConfig);
  assert.equal(result.frpc.configSource, 'running-process');
  assert.equal(result.frpc.configAmbiguous, false);
});

test('network discovery fails closed when frpc --config-dir contains multiple configs', () => {
  const home = createHome();
  const configDir = path.join(home, 'frpc.d');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'one.toml'), 'serverAddr = "one"\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'two.yaml'), 'serverAddr: two\n', 'utf8');

  const result = listManagedTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    resolveCommandPath() { return ''; },
    processEntries: [{
      pid: 101,
      executablePath: '/usr/local/bin/frpc',
      commandLine: `/usr/local/bin/frpc --config-dir ${configDir}`
    }],
    startupEntries: []
  });
  const frpc = result.tools.find((tool) => tool.id === 'frpc');

  assert.equal(frpc.running, true);
  assert.equal(frpc.configCount, 2);
  assert.equal(frpc.configAmbiguous, true);
  assert.equal(frpc.configState, 'multiple');
  assert.equal(frpc.configName, '');
  assert.equal(frpc.configEditable, false);
});

test('network discovery finds a running cloudflared config and service state', () => {
  const home = createHome();
  const configPath = path.join(home, 'edge', 'config.yml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'tunnel: test\n', 'utf8');

  const result = listManagedTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    resolveCommandPath() { return ''; },
    processEntries: [{
      pid: 102,
      executablePath: '/opt/cloudflared',
      commandLine: `/opt/cloudflared tunnel --config=${configPath} run`
    }],
    startupEntries: [{
      source: 'systemd',
      name: 'cloudflared.service',
      commandLine: `/opt/cloudflared --config=${configPath} tunnel run`,
      enabled: true
    }]
  });
  const cloudflared = result.tools.find((tool) => tool.id === 'cloudflared');

  assert.equal(cloudflared.installed, true);
  assert.equal(cloudflared.running, true);
  assert.equal(cloudflared.startupManaged, true);
  assert.equal(cloudflared.configName, 'config.yml');
  assert.equal(cloudflared.configSource, 'running-process');
  assert.equal(cloudflared.configEditable, true);
});

test('network discovery accepts an explicitly selected Cloudflare YAML config without exposing credentials files', () => {
  const home = createHome();
  const configPath = path.join(home, 'edge', 'production.yaml');
  const credentialsPath = path.join(home, 'edge', 'tunnel-credentials.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'tunnel: test\n', 'utf8');
  fs.writeFileSync(credentialsPath, '{"AccountTag":"secret"}\n', 'utf8');

  const result = listManagedTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    resolveCommandPath() { return ''; },
    processEntries: [{
      pid: 104,
      executablePath: '/opt/cloudflared',
      commandLine: `/opt/cloudflared tunnel --config ${configPath} run`
    }],
    startupEntries: []
  });
  const cloudflared = result.tools.find((tool) => tool.id === 'cloudflared');

  assert.equal(cloudflared.configName, 'production.yaml');
  assert.equal(cloudflared.configFormat, 'yaml');
  assert.equal(cloudflared.configEditable, true);
  assert.equal(JSON.stringify(cloudflared).includes(credentialsPath), false);
});

test('network discovery does not attach an unrelated config to token-managed cloudflared', () => {
  const home = createHome();
  const configPath = path.join(home, '.cloudflared', 'config.yml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'tunnel: unrelated\n', 'utf8');

  const result = listManagedTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    resolveCommandPath() { return ''; },
    processEntries: [{
      pid: 103,
      executablePath: '/opt/cloudflared',
      commandLine: '/opt/cloudflared tunnel run --token sensitive-value'
    }],
    startupEntries: []
  });
  const cloudflared = result.tools.find((tool) => tool.id === 'cloudflared');

  assert.equal(cloudflared.running, true);
  assert.equal(cloudflared.configCount, 0);
  assert.equal(cloudflared.configState, 'token-managed');
  assert.equal(cloudflared.configName, '');
  assert.equal(cloudflared.configEditable, false);
  assert.equal(JSON.stringify(cloudflared).includes('sensitive-value'), false);
});

test('systemd parsing ignores ExecStartPre helpers and keeps the actual service command', () => {
  const entries = parseSystemdUnit('frpc.service', [
    '[Service]',
    'WorkingDirectory=/opt/frp',
    'ExecStartPre=/usr/bin/install -d /run/frp',
    'ExecStart=/opt/frp/frpc -c /etc/frp/frpc.toml',
    'ExecStartPost=/usr/bin/logger started'
  ].join('\n'), true);

  assert.deepEqual(entries, [{
    source: 'systemd',
    name: 'frpc.service',
    commandLine: '/opt/frp/frpc -c /etc/frp/frpc.toml',
    workingDirectory: '/opt/frp',
    enabled: true
  }]);
});

test('launchd discovery recognizes scheduled jobs and decodes plist path values', (t) => {
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgents, 'com.example.frpc.plist');
  fs.mkdirSync(launchAgents, { recursive: true });
  fs.writeFileSync(plistPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>ProgramArguments</key><array>',
    '<string>/opt/frp/frpc</string>',
    '<string>-c</string>',
    '<string>/etc/frp/client&amp;edge.toml</string>',
    '</array>',
    '<key>StartCalendarInterval</key><dict><key>Minute</key><integer>5</integer></dict>',
    '</dict></plist>'
  ].join(''), 'utf8');
  const fsImpl = {
    readdirSync(directory, options) {
      if (!String(directory).startsWith(home)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return fs.readdirSync(directory, options);
    },
    readFileSync: fs.readFileSync.bind(fs)
  };

  const entries = readStartupEntries({
    platform: 'darwin',
    hostHomeDir: home,
    fs: fsImpl,
    spawnSync() { return { status: 1, stdout: '', stderr: '' }; }
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].enabled, true);
  assert.equal(entries[0].args[1], '/etc/frp/client&edge.toml');
});

test('network discovery extracts FRP config from a shell-wrapped startup command', () => {
  const home = createHome();
  const executablePath = path.join(home, 'bin', 'frpc');
  const configPath = path.join(home, 'config', 'wrapped.toml');
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(executablePath, '', 'utf8');
  fs.writeFileSync(configPath, 'serverAddr = "wrapped"\n', 'utf8');

  const result = discoverNetworkTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    processEntries: [],
    startupEntries: [{
      source: 'systemd',
      name: 'edge-tunnel.service',
      commandLine: `/bin/sh -c '${executablePath} --config ${configPath}'`,
      enabled: true
    }]
  });

  assert.equal(result.frpc.executablePath, executablePath);
  assert.equal(result.frpc.configPath, configPath);
  assert.equal(result.frpc.configSource, 'systemd');
  assert.equal(result.frpc.startupManaged, true);
});

test('network discovery does not double-count a shell parent and its FRP child', () => {
  const home = createHome();
  const configPath = path.join(home, 'frpc.toml');
  fs.writeFileSync(configPath, 'serverAddr = "one"\n', 'utf8');
  const result = discoverNetworkTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    processEntries: [
      {
        pid: 200,
        executablePath: '/bin/sh',
        commandLine: `/bin/sh -c '/opt/frpc -c ${configPath}'`
      },
      {
        pid: 201,
        parentPid: 200,
        executablePath: '/opt/frpc',
        commandLine: `/opt/frpc -c ${configPath}`
      }
    ],
    startupEntries: []
  });

  assert.equal(result.frpc.running, true);
  assert.equal(result.frpc.runningCount, 1);
  assert.equal(result.frpc.configPath, configPath);
});

test('network discovery accepts known launch wrappers without treating ordinary arguments as running FRP', () => {
  const home = createHome();
  const configPath = path.join(home, 'wrapped.toml');
  fs.writeFileSync(configPath, 'serverAddr = "wrapped"\n', 'utf8');

  const falsePositive = discoverNetworkTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    processEntries: [{
      pid: 210,
      executablePath: '/usr/bin/node',
      commandLine: '/usr/bin/node /opt/inspect.js frpc'
    }],
    startupEntries: []
  });
  assert.equal(falsePositive.frpc.running, false);

  const wrapped = discoverNetworkTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    processEntries: [{
      pid: 211,
      executablePath: '/usr/bin/sudo',
      commandLine: `/usr/bin/sudo /opt/frpc -c ${configPath}`
    }],
    startupEntries: []
  });
  assert.equal(wrapped.frpc.running, true);
  assert.equal(wrapped.frpc.configPath, configPath);
});

test('systemd discovery includes XDG user unit paths and enabled target links', (t) => {
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configHome = path.join(home, 'xdg-config');
  const userUnits = path.join(configHome, 'systemd', 'user');
  const servicePath = path.join(userUnits, 'edge-tunnel.service');
  const wantsDir = path.join(userUnits, 'default.target.wants');
  fs.mkdirSync(wantsDir, { recursive: true });
  fs.writeFileSync(servicePath, [
    '[Service]',
    'ExecStart=/opt/frpc -c /srv/frp/client.yaml'
  ].join('\n'), 'utf8');
  fs.symlinkSync(servicePath, path.join(wantsDir, 'edge-tunnel.service'));

  const fsImpl = {
    readdirSync(directory, options) {
      if (!String(directory).startsWith(configHome)) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return fs.readdirSync(directory, options);
    },
    readFileSync: fs.readFileSync.bind(fs)
  };
  const entries = readStartupEntries({
    platform: 'linux',
    hostHomeDir: home,
    env: { XDG_CONFIG_HOME: configHome },
    fs: fsImpl,
    spawnSync() { return { status: 1, stdout: '', stderr: '' }; }
  });

  assert.equal(entries.some((entry) => entry.commandLine.includes('/opt/frpc -c /srv/frp/client.yaml')), true);
  assert.equal(entries.some((entry) => entry.enabled), true);
});

test('network discovery never falls back when a running process names an unreadable config', () => {
  const home = createHome();
  const unrelatedConfig = path.join(home, '.config', 'frp', 'frpc.toml');
  const missingActiveConfig = path.join(home, 'runtime', 'missing.toml');
  fs.mkdirSync(path.dirname(unrelatedConfig), { recursive: true });
  fs.writeFileSync(unrelatedConfig, 'serverAddr = "unrelated"\n', 'utf8');

  const result = discoverNetworkTools({
    platform: 'linux',
    hostHomeDir: home,
    fs,
    processEntries: [{
      pid: 300,
      executablePath: '/opt/frpc',
      commandLine: `/opt/frpc -c ${missingActiveConfig}`
    }],
    startupEntries: []
  });

  assert.equal(result.frpc.configPath, '');
  assert.equal(result.frpc.configCount, 0);
  assert.equal(result.frpc.configAmbiguous, true);
  assert.equal(result.frpc.configState, 'unresolved');
});
