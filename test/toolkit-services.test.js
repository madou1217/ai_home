'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listManagedApps,
  installAppHooks,
  getProviderConfigPath,
  getConfigFormat,
  findDesktopClientRecord,
  getDesktopVersion,
  getBinaryVersion,
  APP_CATEGORIES
} = require('../lib/cli/services/toolkit/app-manager');
const {
  detectNodeEnvironment,
  detectPythonEnvironment,
  getEnvironmentsSummary,
  planEnvironmentAction,
  executeEnvironmentAction
} = require('../lib/cli/services/toolkit/env-manager');
const {
  NPM_PRESETS,
  PIP_PRESETS,
  getCurrentNpmRegistry,
  getCurrentPipIndexUrl,
  getMirrorsStatus,
  setNpmRegistry,
  setPipIndexUrl,
  testEndpointLatency
} = require('../lib/cli/services/toolkit/mirror-manager');
const {
  CONNECTIVITY_TARGETS,
  detectSystemProxy,
  getProxyStatus,
  setGitProxy,
  setNpmProxy,
  testConnectivity
} = require('../lib/cli/services/toolkit/proxy-manager');
const { EventEmitter } = require('node:events');
const { createServer } = require('node:http');

test('app-manager listManagedApps returns structured apps list', async () => {
  assert.equal(Object.hasOwn(APP_CATEGORIES, 'agents'), false);
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

  const vscodeApp = result.apps.find((a) => a.id === 'vscode');
  assert.ok(vscodeApp, 'Visual Studio Code host should exist');
  assert.equal(vscodeApp.clientId, 'vscode');
  assert.deepEqual(vscodeApp.integrationProviders, ['codex']);

  const geminiCli = result.apps.find((a) => a.id === 'gemini');
  assert.ok(geminiCli, 'Gemini CLI should remain available as a CLI installer');
  assert.equal(geminiCli.name, 'Gemini CLI');
  assert.equal(result.apps.some((a) => a.id === 'gemini-desktop'), false, 'Gemini must not expose a Desktop installer without a desktop contract');
});

test('app-manager getProviderConfigPath resolves known provider paths', () => {
  const hostHome = '/fake/home';
  const claudePath = getProviderConfigPath('claude', hostHome);
  assert.ok(claudePath.includes('.claude'));
  const codexPath = getProviderConfigPath('codex', hostHome);
  assert.ok(codexPath.includes('.codex'));
  const kimiPath = getProviderConfigPath('kimi', hostHome);
  assert.equal(kimiPath, '/fake/home/.kimi-code/config.toml');
  const antigravityPath = getProviderConfigPath('agy', hostHome);
  assert.equal(antigravityPath, '/fake/home/.gemini/antigravity-cli/hooks.json');
});

test('app-manager normalizes editable config formats across platforms', () => {
  assert.equal(getConfigFormat('/home/tester/.env'), 'dotenv');
  assert.equal(getConfigFormat('C:\\Users\\tester\\.env.local'), 'dotenv');
  assert.equal(getConfigFormat('/etc/cloudflared/config.yml'), 'yaml');
  assert.equal(getConfigFormat('C:\\frp\\frpc.toml'), 'toml');
  assert.equal(getConfigFormat('/etc/example/settings.properties'), 'ini');
  assert.equal(getConfigFormat('/opt/example/start.zsh'), 'shellscript');
  assert.equal(getConfigFormat('/opt/example/unknown.conf'), 'conf');
});

test('app-manager resolves the merged ChatGPT desktop executable on Windows', () => {
  const cases = [{
    platform: 'win32',
    hostHomeDir: 'C:\\Users\\tester',
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    target: 'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe'
  }];

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

test('app-manager detects the Windows Store ChatGPT/Codex package without launching its GUI', () => {
  const installLocation = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.727.11326_x64__2p2nqsd0c76g0';
  const executablePath = `${installLocation}\\app\\ChatGPT.exe`;
  const calls = [];
  const record = findDesktopClientRecord('codex', {
    platform: 'win32',
    hostHomeDir: 'C:\\Users\\tester',
    env: {},
    fs: { existsSync() { return false; } },
    spawnSync(command, args) {
      calls.push({ command, args });
      if (command === 'powershell.exe' && String(args[3] || '').includes('Get-AppxPackage')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            Name: 'OpenAI.Codex',
            InstallLocation: installLocation,
            Version: '26.727.11326.0',
            Executable: 'app\\ChatGPT.exe'
          }),
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    }
  });

  assert.ok(record);
  assert.equal(record.executablePath, executablePath);
  assert.equal(record.packageVersion, '26.727.11326.0');
  assert.equal(getDesktopVersion(record, {
    platform: 'win32',
    spawnSync() { throw new Error('Store package version must not execute ChatGPT.exe'); }
  }), '26.727.11326.0');
  assert.equal(calls.filter((call) => call.command === 'powershell.exe').length, 1);
});

test('app-manager reads a conventional Windows desktop version through file metadata', () => {
  const executablePath = 'C:\\Tools\\ChatGPT.exe';
  const calls = [];
  const version = getDesktopVersion({ executablePath }, {
    platform: 'win32',
    spawnSync(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: '26.721.81911\n', stderr: '' };
    }
  });

  assert.equal(version, '26.721.81911');
  assert.equal(calls[0].command, 'powershell.exe');
  assert.notEqual(calls[0].command, executablePath);
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
  assert.equal(desktop.defaultModel, '-');
  assert.deepEqual(desktop.supportedModels, []);
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

test('env-manager reports command probes from the AIH server PATH instead of process.version', () => {
  const calls = [];
  const values = new Map([
    ['node --version', 'v22.14.0\n'],
    ['which node', '/opt/user/bin/node\n'],
    ['npm -v', '10.9.2\n']
  ]);
  const environment = detectNodeEnvironment({
    hostHomeDir: '/home/tester',
    processObj: { version: 'v99.0.0', execPath: '/server/node', env: {}, platform: 'linux' },
    fs: { existsSync: () => false },
    path: require('node:path').posix,
    spawnSync(command, args) {
      const key = [command, ...args].join(' ');
      calls.push(key);
      const stdout = values.get(key) || '';
      return { status: stdout ? 0 : 127, stdout, stderr: stdout ? '' : 'not found' };
    }
  });

  assert.equal(environment.currentVersion, 'v22.14.0');
  assert.equal(environment.activePath, '/opt/user/bin/node');
  assert.equal(environment.scope, 'aih-server-process-path');
  assert.equal(environment.source, 'command-probe');
  assert.equal(environment.probeStatus, 'available');
  assert.ok(calls.includes('node --version'));
  assert.notEqual(environment.currentVersion, 'v99.0.0');
});

test('env-manager action planner rejects shell injection and documents shell-only actions', () => {
  const invalid = planEnvironmentAction({ manager: 'fnm', action: 'install', version: '22; touch /tmp/pwned' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_version');

  const unsupported = planEnvironmentAction({ manager: 'fnm', action: 'use', version: '22' });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, 'interactive_shell_action_unsupported');
  assert.equal(unsupported.scope, 'caller-shell');

  const nvm = planEnvironmentAction(
    { manager: 'nvm', action: 'default', version: '22' },
    { hostHomeDir: '/home/tester', processObj: { env: {}, platform: 'linux', cwd: () => '/workspace' } }
  );
  assert.equal(nvm.ok, true);
  assert.equal(nvm.plan.command, '/bin/sh');
  assert.deepEqual(nvm.plan.args.slice(0, 1), ['-c']);
  assert.equal(nvm.plan.env.AIH_ENV_VERSION, '22');
  assert.equal(nvm.plan.env.AIH_ENV_ACTION, 'default');
  assert.equal(nvm.plan.args.join(' ').includes('22'), false, 'validated values must travel through env, not shell source');

  const conda = planEnvironmentAction({ manager: 'conda', action: 'create', name: 'research-312', pythonVersion: '3.12' });
  assert.equal(conda.ok, true);
  assert.deepEqual(conda.plan.args, ['create', '--yes', '--name', 'research-312', 'python=3.12']);
  assert.equal(planEnvironmentAction({ manager: 'conda', action: 'remove', name: 'bad;name' }).error, 'invalid_environment_name');

  const venv = planEnvironmentAction(
    { manager: 'venv', action: 'create', path: '.venv' },
    { processObj: { env: {}, platform: 'linux', cwd: () => '/workspace' }, path: require('node:path').posix }
  );
  assert.equal(venv.ok, true);
  assert.deepEqual(venv.plan.args, ['-m', 'venv', '/workspace/.venv']);
  const escaped = planEnvironmentAction(
    { manager: 'venv', action: 'create', path: '../outside' },
    { processObj: { env: {}, platform: 'linux', cwd: () => '/workspace' }, path: require('node:path').posix }
  );
  assert.equal(escaped.error, 'invalid_environment_path');
});

test('env-manager executor requires confirmation and executes with injected async spawn', async () => {
  const input = { manager: 'pyenv', action: 'install', version: '3.12.7' };
  const preview = await executeEnvironmentAction(input, {
    processObj: { env: {}, platform: 'linux', cwd: () => '/workspace' }
  });
  assert.equal(preview.ok, false);
  assert.equal(preview.error, 'confirmation_required');
  assert.ok(preview.plan);

  let spawnCall;
  const result = await executeEnvironmentAction({ ...input, confirmed: true }, {
    processObj: { env: { PATH: '/usr/bin' }, platform: 'linux', cwd: () => '/workspace' },
    spawn(command, args, options) {
      spawnCall = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('installed\n'));
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'installed');
  assert.equal(spawnCall.command, 'pyenv');
  assert.deepEqual(spawnCall.args, ['install', '3.12.7']);
  assert.equal(spawnCall.options.shell, false);
});

test('mirror-manager materializes guides and labels direct HTTP TTFB probes truthfully', async () => {
  const status = await getMirrorsStatus({
    spawnSync(command, args) {
      const key = [command, ...args].join(' ');
      if (key === 'npm config get registry') return { status: 0, stdout: 'https://registry.example.test/custom/\n', stderr: '' };
      if (key === 'pip config get global.index-url') return { status: 0, stdout: 'https://pypi.example.test/simple\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'missing' };
    }
  });
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /<URL>|<HOST>/);
  assert.match(serialized, /registry\.example\.test/);
  assert.equal(status.npm.presets[0].guides.commands.some((item) => item.cmd.includes(NPM_PRESETS[0].url)), true);

  const redirect = await testEndpointLatency('https://mirror.example.test/', {
    requestAdapter: async () => ({ statusCode: 302 })
  });
  assert.equal(redirect.ok, true);
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.measurement, 'ttfb');
  assert.equal(redirect.route, 'direct');

  const notFound = await testEndpointLatency('https://mirror.example.test/missing', {
    requestAdapter: async () => ({ statusCode: 404 })
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.statusCode, 404);
});

test('mirror-manager rejects non-HTTP URLs and reports command failures', () => {
  const invalid = setNpmRegistry('file:///tmp/registry', { spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_url');

  const npmFailure = setNpmRegistry('https://registry.example.test/', {
    spawnSync: () => ({ status: 2, stdout: '', stderr: 'permission denied' })
  });
  assert.equal(npmFailure.ok, false);
  assert.equal(npmFailure.error, 'permission denied');

  const pipFailure = setPipIndexUrl('https://pypi.example.test/simple', {
    spawnSync: () => ({ status: 2, stdout: '', stderr: 'write failed' })
  });
  assert.equal(pipFailure.ok, false);
  assert.equal(pipFailure.error, 'write failed');
});

test('mirror-manager makes copied commands inert for shell metacharacters in registry URLs', async () => {
  const status = await getMirrorsStatus({
    spawnSync(command, args) {
      const key = [command, ...args].join(' ');
      if (key === 'npm config get registry') {
        return { status: 0, stdout: 'https://registry.example.test/a;touch-pwned\n', stderr: '' };
      }
      if (key === 'pip config get global.index-url') {
        return { status: 0, stdout: 'https://pypi.example.test/simple\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'missing' };
    }
  });
  const commands = JSON.stringify(status.npm.guides.commands);

  assert.doesNotMatch(commands, /;touch-pwned/);
  assert.match(commands, /%3Btouch-pwned/);
});

test('mirror-manager default probe blocks private network targets before connecting', async () => {
  const result = await testEndpointLatency('http://127.0.0.1:65535/private');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'subscription_url_blocked');
});

test('proxy-manager labels scopes and parses macOS bypass exceptions', () => {
  const scutil = `\n<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n  }\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n}\n`;
  const status = getProxyStatus({
    processObj: {
      platform: 'darwin',
      env: { HTTP_PROXY: 'http://127.0.0.1:8080' }
    },
    spawnSync(command, args) {
      const key = [command, ...args].join(' ');
      if (key === 'scutil --proxy') return { status: 0, stdout: scutil, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  });

  assert.equal(status.env.scope, 'aih-server-process');
  assert.equal(status.env.source, 'process.env');
  assert.equal(status.system.probeStatus, 'available');
  assert.deepEqual(status.system.bypassList, ['*.local', '169.254/16']);
  assert.equal(status.tools.git.scope, 'global');
});

test('proxy-manager distinguishes unset, unsupported, and failed system probes', () => {
  const unset = detectSystemProxy({
    processObj: { platform: 'darwin', env: {} },
    spawnSync: () => ({ status: 0, stdout: '<dictionary> { HTTPEnable : 0 }', stderr: '' })
  });
  assert.equal(unset.probeStatus, 'unset');

  const unsupported = detectSystemProxy({
    processObj: { platform: 'linux', env: {} },
    spawnSync: () => ({ status: 127, stdout: '', stderr: 'gsettings: not found' })
  });
  assert.equal(unsupported.probeStatus, 'unsupported');

  const failed = detectSystemProxy({
    processObj: { platform: 'darwin', env: {} },
    spawnSync: () => { throw new Error('probe failed'); }
  });
  assert.equal(failed.probeStatus, 'error');
});

test('proxy-manager checks every Git and npm write and reports partial failures', () => {
  let calls = 0;
  const options = {
    spawnSync() {
      calls += 1;
      return calls === 2
        ? { status: 1, stdout: '', stderr: 'second write failed' }
        : { status: 0, stdout: '', stderr: '' };
    }
  };
  const git = setGitProxy('http://127.0.0.1:7890', options);
  assert.equal(git.ok, false);
  assert.equal(git.error, 'proxy_config_failed');
  assert.equal(git.operations[1].ok, false);

  calls = 0;
  const npm = setNpmProxy('http://127.0.0.1:7890', options);
  assert.equal(npm.ok, false);
  assert.equal(npm.operations[1].ok, false);
});

test('proxy-manager connectivity distinguishes direct and explicit local HTTP proxy routes', async () => {
  const observed = [];
  const requestAdapter = async (request) => {
    observed.push(request);
    return { statusCode: request.url.includes('github') ? 401 : 204 };
  };
  const targets = [
    { id: 'github', name: 'GitHub', url: 'https://api.github.com', host: 'api.github.com', group: 'dev' }
  ];

  const direct = await testConnectivity({ route: 'direct' }, { requestAdapter, connectivityTargets: targets });
  assert.equal(direct.route, 'direct');
  assert.equal(direct.proxyUsed, null);
  assert.equal(direct.results[0].statusCode, 401);
  assert.equal(direct.results[0].reachable, true);

  const proxied = await testConnectivity(
    { route: 'proxy', proxyUrl: 'http://127.0.0.1:7890' },
    { requestAdapter, connectivityTargets: targets }
  );
  assert.equal(proxied.route, 'proxy');
  assert.equal(proxied.proxyUsed, 'http://127.0.0.1:7890/');
  assert.equal(observed.at(-1).route, 'proxy');

  const rejected = await testConnectivity(
    { route: 'proxy', proxyUrl: 'http://proxy.example.com:7890' },
    { requestAdapter, connectivityTargets: targets }
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'invalid_local_http_proxy');
});

test('proxy-manager default direct probe uses an Undici-compatible redirect policy', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const result = await testConnectivity({ route: 'direct' }, {
      connectivityTargets: [{
        id: 'probe',
        name: 'Probe',
        url: `http://127.0.0.1:${port}/`,
        host: '127.0.0.1',
        group: 'test'
      }],
      requestTimeoutMs: 1000
    });

    assert.equal(result.results[0].reachable, true);
    assert.equal(result.results[0].statusCode, 204);
    assert.equal(result.results[0].error, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
