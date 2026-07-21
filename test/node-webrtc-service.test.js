const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  createNodeWebrtcServiceManager,
  parseNodeWebrtcServiceArgs,
  runNodeWebrtcService
} = require('../lib/cli/services/node/webrtc-service');
const {
  readBackgroundSupervisorState,
  writeBackgroundSupervisorState
} = require('../lib/cli/services/background/supervisor-state-store');

function makeTempDir(prefix = 'aih-node-webrtc-service-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function targetsBackgroundSupervisor(args) {
  const target = String(args[1] || '');
  return target === 'com.clawdcodex.ai_home'
    || target.endsWith('/com.clawdcodex.ai_home');
}

function launchctlResult(status, stderr = '') {
  return { status, stdout: '', stderr };
}

function makeDeps(root, platform, spawnSync, env = {}) {
  const aiHomeDir = path.join(root, '.ai_home');
  return {
    fs,
    path,
    spawnSync,
    processObj: {
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        ...env
      },
      platform,
      cwd() { return root; }
    },
    ensureDir(dir) {
      fs.mkdirSync(dir, { recursive: true });
    },
    aiHomeDir,
    hostHomeDir: root,
    readServerConfig: () => ({ managementKey: 'node-secret' })
  };
}

test('node WebRTC service defaults logs under AIH_HOME when no root is injected', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createNodeWebrtcServiceManager({ nodeId: 'webrtc-node' }, {
    fs,
    path,
    hostHomeDir: root,
    spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    processObj: { platform: 'darwin', env: {}, cwd: () => root }
  });

  assert.equal(
    manager.getStatus().logFile,
    path.join(root, '.ai_home', 'logs', 'services', 'background-supervisor.log')
  );
});

test('parseNodeWebrtcServiceArgs rejects secret-bearing service installs', () => {
  assert.throws(
    () => parseNodeWebrtcServiceArgs([
      'install',
      'https://control.example.com',
      '--node-id',
      'nat-node',
      '--management-key',
      'node-secret'
    ]),
    { code: 'webrtc_service_management_key_not_allowed' }
  );
});

test('node WebRTC service joins the single macOS background supervisor', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let supervisorLoaded = false;
  const deps = makeDeps(root, 'darwin', (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'sh' && args[1] === 'command -v aih') {
      return { status: 0, stdout: '/opt/homebrew/bin/aih\n', stderr: '' };
    }
    if (String(cmd).endsWith('/lsregister')) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'launchctl' && (args[0] === 'print' || args[0] === 'list')) {
      return supervisorLoaded && targetsBackgroundSupervisor(args)
        ? launchctlResult(0)
        : launchctlResult(1, 'service not found');
    }
    if (cmd === 'launchctl' && (args[0] === 'bootstrap' || args[0] === 'load')) {
      supervisorLoaded = true;
      return launchctlResult(0);
    }
    if (cmd === 'launchctl') return launchctlResult(0);
    return { status: 1, stdout: '', stderr: '' };
  });

  const result = runNodeWebrtcService([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--connect-timeout-ms',
    '15000',
    '--reconnect-delay-ms',
    '5000'
  ], deps);

  assert.equal(
    result.status.file,
    path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.plist')
  );
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'Library', 'LaunchAgents')).sort(),
    ['com.clawdcodex.ai_home.plist']
  );
  const desiredState = JSON.parse(fs.readFileSync(
    path.join(root, '.ai_home', 'run', 'background-supervisor.json'),
    'utf8'
  ));
  assert.deepEqual(desiredState.components['node-webrtc:nat-node'].args, [
    'node',
    'webrtc',
    'connect',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--connect-timeout-ms',
    '15000',
    '--reconnect-delay-ms',
    '5000'
  ]);
  assert.equal(JSON.stringify(desiredState).includes('node-secret'), false);
  assert.equal(calls.filter((call) => call.cmd === 'launchctl' && call.args[0] === 'bootstrap').length, 1);
});

test('node WebRTC service restores desired state before restarting the previous macOS supervisor', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const stateDeps = { fs, path, aiHomeDir };
  const previousState = writeBackgroundSupervisorState({
    schemaVersion: 1,
    components: {
      'node-relay:existing': {
        id: 'node-relay:existing',
        args: ['node', 'relay', 'connect', 'https://existing.example.com', '--node-id', 'existing']
      }
    }
  }, stateDeps);
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.plist');
  fs.mkdirSync(path.dirname(launchdPlist), { recursive: true });
  fs.writeFileSync(launchdPlist, 'previous-supervisor-plist');
  let stateAtRollbackBootstrap = null;
  let supervisorLoaded = true;
  const deps = makeDeps(root, 'darwin', (command, args) => {
    if (command === 'sh') return { status: 0, stdout: '/opt/homebrew/bin/aih\n', stderr: '' };
    if (command !== 'launchctl') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print' || args[0] === 'list') {
      return supervisorLoaded && targetsBackgroundSupervisor(args)
        ? launchctlResult(0)
        : launchctlResult(1, 'service not found');
    }
    if (args[0] === 'bootout' || args[0] === 'unload') {
      supervisorLoaded = false;
      return launchctlResult(0);
    }
    if (args[0] === 'bootstrap' || args[0] === 'load') {
      const plistFile = args[0] === 'bootstrap' ? args[2] : args[1];
      const plist = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, 'utf8') : '';
      if (plist === 'previous-supervisor-plist') {
        if (args[0] === 'bootstrap') stateAtRollbackBootstrap = readBackgroundSupervisorState(stateDeps);
        supervisorLoaded = true;
        return launchctlResult(0);
      }
      return launchctlResult(1, 'new supervisor bootstrap failed');
    }
    return launchctlResult(0);
  });

  assert.throws(
    () => runNodeWebrtcService([
      'install',
      'https://control.example.com',
      '--node-id',
      'nat-node'
    ], deps),
    { code: 'background_supervisor_bootstrap_failed' }
  );

  assert.deepEqual(stateAtRollbackBootstrap, previousState);
  assert.deepEqual(readBackgroundSupervisorState(stateDeps), previousState);
});

test('node webrtc service installs Linux systemd user unit without leaking management key', () => {
  const root = makeTempDir();
  const calls = [];
  const deps = makeDeps(root, 'linux', (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'sh' && args[1] === 'command -v aih') {
      return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    }
    if (cmd === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });

  const result = runNodeWebrtcService([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--connect-timeout-ms',
    '15000',
    '--reconnect-delay-ms',
    '5000'
  ], deps);

  const status = result.status;
  const unit = fs.readFileSync(status.file, 'utf8');
  assert.equal(status.type, 'systemd-user');
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.state, 'running');
  assert.equal(status.running, true);
  assert.equal(status.issues.length, 0);
  assert.equal(status.commands.restart, 'systemctl --user restart com.clawdcodex.ai_home.node-webrtc.nat-node.service');
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/aih" "node" "webrtc" "connect" "https:\/\/control\.example\.com"/);
  assert.match(unit, /"--node-id" "nat-node"/);
  assert.match(unit, /"--connect-timeout-ms" "15000"/);
  assert.match(unit, /"--reconnect-delay-ms" "5000"/);
  assert.match(unit, new RegExp(`Environment="AIH_HOST_HOME=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(unit.includes('node-secret'), false);
  assert.equal(calls.some((call) => call.cmd === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.node-webrtc.nat-node.service'), true);
});

test('node webrtc service status and uninstall are scoped by node id', () => {
  const root = makeTempDir();
  const deps = makeDeps(root, 'linux', (cmd) => {
    if (cmd === 'systemctl') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'sh') return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });

  const status = runNodeWebrtcService(['status', '--node-id', 'nat-node'], deps);
  assert.equal(status.status.type, 'systemd-user');
  assert.equal(status.status.installed, false);
  assert.equal(status.status.state, 'missing');
  assert.equal(status.status.running, false);
  assert.equal(status.status.issues[0].code, 'webrtc_service_missing');
  assert.equal(status.status.nextActions[0].command, "aih node webrtc service install '<control-url>' --node-id nat-node");
  assert.equal(status.status.unit, 'com.clawdcodex.ai_home.node-webrtc.nat-node.service');

  const uninstall = runNodeWebrtcService(['uninstall', '--node-id', 'nat-node'], deps);
  assert.equal(uninstall.action, 'uninstall');
  assert.equal(uninstall.status.installed, false);
  assert.equal(uninstall.status.state, 'missing');
});

test('node webrtc service install requires local management key in server config', () => {
  const root = makeTempDir();
  const deps = makeDeps(root, 'linux', () => ({ status: 0, stdout: '', stderr: '' }));
  deps.readServerConfig = () => ({});

  assert.throws(
    () => runNodeWebrtcService([
      'install',
      'https://control.example.com',
      '--node-id',
      'nat-node'
    ], deps),
    { code: 'management_key_required', command: 'webrtc-service' }
  );
});
