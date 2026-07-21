const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  createNodeRelayServiceManager,
  parseNodeRelayServiceArgs,
  runNodeRelayService
} = require('../lib/cli/services/node/relay-service');
const {
  readBackgroundSupervisorState,
  writeBackgroundSupervisorState
} = require('../lib/cli/services/background/supervisor-state-store');

function makeTempDir(prefix = 'aih-node-relay-service-') {
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

test('node relay service defaults logs under AIH_HOME when no root is injected', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createNodeRelayServiceManager({ nodeId: 'nat-node' }, {
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

test('parseNodeRelayServiceArgs rejects secret-bearing service installs', () => {
  assert.throws(
    () => parseNodeRelayServiceArgs([
      'install',
      'https://control.example.com',
      '--node-id',
      'nat-node',
      '--management-key',
      'node-secret'
    ]),
    { code: 'relay_service_management_key_not_allowed' }
  );
});

test('node relay service joins one branded macOS background supervisor', (t) => {
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

  const result = runNodeRelayService([
    'install',
    'https://control.example.com',
    '--node-id',
    'Nat_Node',
    '--heartbeat-ms',
    '2000'
  ], deps);

  const status = result.status;
  const plist = fs.readFileSync(status.file, 'utf8');
  assert.equal(status.type, 'launchd');
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(result.nodeId, 'nat_node');
  assert.equal(
    status.file,
    path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.plist')
  );
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/aih<\/string>/);
  assert.match(plist, /<string>__background<\/string>\s+<string>run<\/string>/);
  assert.doesNotMatch(plist, /<string>node<\/string>\s+<string>relay<\/string>/);
  assert.doesNotMatch(plist, /https:\/\/control\.example\.com/);
  assert.match(
    plist,
    /<key>AssociatedBundleIdentifiers<\/key>\s+<array>\s+<string>com\.aih\.background<\/string>\s+<\/array>/
  );
  assert.equal(plist.includes('node-secret'), false);
  assert.equal(
    calls.filter((call) => call.cmd === 'launchctl' && call.args[0] === 'bootstrap').length,
    1
  );

  const desiredState = JSON.parse(fs.readFileSync(
    path.join(root, '.ai_home', 'run', 'background-supervisor.json'),
    'utf8'
  ));
  assert.deepEqual(Object.keys(desiredState.components), ['node-relay:nat_node']);
  assert.deepEqual(desiredState.components['node-relay:nat_node'].args, [
    'node',
    'relay',
    'connect',
    'https://control.example.com',
    '--node-id',
    'nat_node',
    '--heartbeat-ms',
    '2000'
  ]);
  assert.equal(JSON.stringify(desiredState).includes('node-secret'), false);

  const appPath = path.join(
    root,
    'Library',
    'Application Support',
    'AI Home',
    'AI Home.app'
  );
  const infoPlist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
  assert.match(infoPlist, /<key>CFBundleDisplayName<\/key>\s+<string>AI Home<\/string>/);
  assert.match(infoPlist, /<key>CFBundleIdentifier<\/key>\s+<string>com\.aih\.background<\/string>/);
  assert.equal(fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'AIHome.icns')), true);
});

test('node relay service restores desired state before restarting the previous macOS supervisor', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const stateDeps = { fs, path, aiHomeDir };
  const previousState = writeBackgroundSupervisorState({
    schemaVersion: 1,
    components: {
      'node-webrtc:existing': {
        id: 'node-webrtc:existing',
        args: ['node', 'webrtc', 'connect', 'https://existing.example.com', '--node-id', 'existing']
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
    () => runNodeRelayService([
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

test('node relay service installs Linux systemd user unit without leaking management key', () => {
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

  const result = runNodeRelayService([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
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
  assert.equal(status.commands.restart, 'systemctl --user restart com.clawdcodex.ai_home.node-relay.nat-node.service');
  assert.match(status.commands.logs, /journalctl --user -u com\.clawdcodex\.ai_home\.node-relay\.nat-node\.service/);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/aih" "node" "relay" "connect" "https:\/\/control\.example\.com"/);
  assert.match(unit, new RegExp(`WorkingDirectory=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.ai_home`));
  assert.doesNotMatch(unit, /WorkingDirectory="[^"]+"/);
  assert.match(unit, new RegExp(`Environment="AIH_HOST_HOME=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(unit, /"--node-id" "nat-node"/);
  assert.match(unit, /"--reconnect-delay-ms" "5000"/);
  assert.equal(unit.includes('node-secret'), false);
  assert.equal(calls.some((call) => call.cmd === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.node-relay.nat-node.service'), true);
});

test('node relay service writes Linux systemd unit to the real user home', () => {
  const root = makeTempDir();
  const realHome = path.join(root, 'real-home');
  const deps = makeDeps(root, 'linux', (cmd, args) => {
    if (cmd === 'sh' && args[1] === 'command -v aih') {
      return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    }
    if (cmd === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  }, {
    HOME: realHome
  });

  const result = runNodeRelayService([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ], deps);

  assert.equal(
    result.status.file,
    path.join(realHome, '.config', 'systemd', 'user', 'com.clawdcodex.ai_home.node-relay.nat-node.service')
  );
  assert.equal(fs.existsSync(result.status.file), true);
});

test('node relay service installs Windows startup script without leaking management key', () => {
  const root = makeTempDir();
  const appData = path.join(root, 'AppData', 'Roaming');
  const deps = makeDeps(root, 'win32', (cmd, args) => {
    if (cmd === 'where' && args[0] === 'aih') {
      return { status: 0, stdout: 'C:\\Users\\model\\AppData\\Roaming\\npm\\aih.cmd\r\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  }, {
    APPDATA: appData,
    PATH: 'C:\\Node'
  });

  const result = runNodeRelayService([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ], deps);

  const status = result.status;
  const script = fs.readFileSync(status.file, 'utf8');
  assert.equal(status.type, 'windows-startup');
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(status.state, 'installed');
  assert.equal(status.running, false);
  assert.equal(status.issues[0].code, 'relay_service_not_running');
  assert.match(status.nextActions[0].command, /node-relay\.nat-node\.vbs/);
  assert.equal(script.includes('""C:\\Users\\model\\AppData\\Roaming\\npm\\aih.cmd"" ""node"" ""relay"" ""connect"" ""https://control.example.com"" ""--node-id"" ""nat-node""'), true);
  assert.equal(script.includes('shell.Run'), true);
  assert.equal(script.includes(', 0, False'), true);
  assert.equal(script.includes('node-secret'), false);
});

test('node relay service status and uninstall are scoped by node id', () => {
  const root = makeTempDir();
  const deps = makeDeps(root, 'linux', (cmd) => {
    if (cmd === 'systemctl') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'sh') return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });

  const status = runNodeRelayService(['status', '--node-id', 'nat-node'], deps);
  assert.equal(status.status.type, 'systemd-user');
  assert.equal(status.status.installed, false);
  assert.equal(status.status.state, 'missing');
  assert.equal(status.status.running, false);
  assert.equal(status.status.issues[0].code, 'relay_service_missing');
  assert.equal(status.status.nextActions[0].command, "aih node relay service install '<control-url>' --node-id nat-node");
  assert.equal(status.status.unit, 'com.clawdcodex.ai_home.node-relay.nat-node.service');

  const uninstall = runNodeRelayService(['uninstall', '--node-id', 'nat-node'], deps);
  assert.equal(uninstall.action, 'uninstall');
  assert.equal(uninstall.status.installed, false);
  assert.equal(uninstall.status.state, 'missing');
});

test('node relay service install requires local management key in server config', () => {
  const root = makeTempDir();
  const deps = makeDeps(root, 'linux', () => ({ status: 0, stdout: '', stderr: '' }));
  deps.readServerConfig = () => ({});

  assert.throws(
    () => runNodeRelayService([
      'install',
      'https://control.example.com',
      '--node-id',
      'nat-node'
    ], deps),
    { code: 'management_key_required', command: 'relay-service' }
  );
});
