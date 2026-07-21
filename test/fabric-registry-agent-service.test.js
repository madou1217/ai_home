const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');
const {
  createFabricRegistryAgentServiceManager,
  parseFabricRegistryAgentServiceArgs,
  runFabricRegistryAgentService
} = require('../lib/cli/services/fabric/registry-agent-service');
const {
  readRegistryAgentManagementKey,
  writeRegistryAgentManagementKey
} = require('../lib/cli/services/fabric/registry-agent-management-key-store');
const {
  readBackgroundSupervisorState,
  writeBackgroundSupervisorState
} = require('../lib/cli/services/background/supervisor-state-store');

function makeTempDir(prefix = 'aih-fabric-agent-service-') {
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
    hostHomeDir: root
  };
}

test('fabric registry service defaults logs under AIH_HOME when no root is injected', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createFabricRegistryAgentServiceManager({ nodeId: 'fabric-node' }, {
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

test('fabric registry agent service rejects raw Management Key persistence', () => {
  assert.throws(
    () => parseFabricRegistryAgentServiceArgs([
      'install',
      'https://control.example.com',
      '--node-id',
      'office-node',
      '--management-key',
      'secret-token'
    ]),
    { code: 'fabric_agent_service_management_key_not_allowed' }
  );
});

test('fabric registry agent joins the single macOS background supervisor without persisting its key', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managementKeyFile = path.join(root, 'fabric-node.token');
  fs.writeFileSync(managementKeyFile, 'management-secret');
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

  const result = runFabricRegistryAgentService([
    'install',
    'https://control.example.com',
    '--node-id',
    'Office Node',
    '--management-key-file',
    managementKeyFile,
    '--transport',
    'relay=degraded,Authorization: Bearer header-secret',
    '--runtime-diagnostics',
    '--interval-ms',
    '2000'
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
  const component = desiredState.components['fabric-registry-agent:office-node'];
  assert.deepEqual(component.args, [
    'fabric',
    'registry',
    'agent',
    'https://control.example.com',
    '--node-id',
    'office-node',
    '--status',
    'online',
    '--transport',
    'relay=degraded',
    '--runtime-diagnostics',
    '--interval-ms',
    '2000'
  ]);
  assert.equal(JSON.stringify(desiredState).includes('management-secret'), false);
  assert.equal(JSON.stringify(desiredState).includes('header-secret'), false);
  assert.equal(JSON.stringify(desiredState).includes(managementKeyFile), false);
  assert.equal(readRegistryAgentManagementKey('office-node', deps), 'management-secret');
  assert.equal(calls.filter((call) => call.cmd === 'launchctl' && call.args[0] === 'bootstrap').length, 1);
});

test('fabric registry agent restores desired state before restarting the previous macOS supervisor', (t) => {
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
  const managementKeyFile = path.join(root, 'registry-management-key');
  fs.writeFileSync(managementKeyFile, 'management-secret');
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
    () => runFabricRegistryAgentService([
      'install',
      'https://control.example.com',
      '--node-id',
      'office-node',
      '--management-key-file',
      managementKeyFile
    ], deps),
    { code: 'background_supervisor_bootstrap_failed' }
  );

  assert.deepEqual(stateAtRollbackBootstrap, previousState);
  assert.deepEqual(readBackgroundSupervisorState(stateDeps), previousState);
});

test('fabric registry agent service installs Linux systemd unit without leaking Management Key contents', () => {
  const root = makeTempDir();
  const managementKeyFile = path.join(root, 'fabric-node.token');
  fs.writeFileSync(managementKeyFile, 'management-secret');
  const calls = [];
  const deps = makeDeps(root, 'linux', (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'sh' && args[1] === 'command -v aih') {
      return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    }
    if (cmd === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });

  const result = runFabricRegistryAgentService([
    'install',
    'https://control.example.com',
    '--node-id',
    'Office Node',
    '--management-key-file',
    managementKeyFile,
    '--relay-status',
    'online',
    '--transport',
    'relay=online',
    '--probe-transport',
    'relay=tcp://127.0.0.1:8766',
    '--runtime-diagnostics',
    '--interval-ms',
    '2000'
  ], deps);

  const status = result.status;
  const unit = fs.readFileSync(status.file, 'utf8');
  assert.equal(status.type, 'systemd-user');
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.running, true);
  assert.equal(status.state, 'running');
  assert.equal(result.nodeId, 'office-node');
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/aih" "fabric" "registry" "agent" "https:\/\/control\.example\.com"/);
  assert.match(unit, /"--node-id" "office-node"/);
  assert.equal(unit.includes('--management-key-file'), false);
  assert.equal(unit.includes(managementKeyFile), false);
  assert.match(unit, /"--probe-transport" "relay=tcp:\/\/127\.0\.0\.1:8766"/);
  assert.match(unit, /"--runtime-diagnostics"/);
  assert.match(unit, /"--interval-ms" "2000"/);
  assert.match(unit, new RegExp(`Environment="AIH_HOST_HOME=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(unit.includes('management-secret'), false);
  assert.equal(readRegistryAgentManagementKey('office-node', deps), 'management-secret');
  assert.equal(calls.some((call) => call.cmd === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.fabric-registry-agent.office-node.service'), true);
});

test('fabric registry agent service writes Linux systemd unit to the real user home', () => {
  const root = makeTempDir();
  const realHome = path.join(root, 'real-home');
  const managementKeyFile = path.join(root, 'fabric-node.token');
  fs.writeFileSync(managementKeyFile, 'management-secret');
  const deps = makeDeps(root, 'linux', (cmd, args) => {
    if (cmd === 'sh' && args[1] === 'command -v aih') {
      return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    }
    if (cmd === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  }, {
    HOME: realHome
  });

  const result = runFabricRegistryAgentService([
    'install',
    'https://control.example.com',
    '--node-id',
    'Office Node',
    '--management-key-file',
    managementKeyFile
  ], deps);

  assert.equal(
    result.status.file,
    path.join(realHome, '.config', 'systemd', 'user', 'com.clawdcodex.ai_home.fabric-registry-agent.office-node.service')
  );
  assert.equal(fs.existsSync(result.status.file), true);
});

test('fabric registry agent service reinstalls from the DB token without an import file', () => {
  const root = makeTempDir();
  const deps = makeDeps(root, 'linux', (cmd, args) => {
    if (cmd === 'sh' && args[1] === 'command -v aih') {
      return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    }
    if (cmd === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });
  writeRegistryAgentManagementKey('office-node', 'stored-token', deps);

  const result = runFabricRegistryAgentService([
    'install',
    'https://control.example.com',
    '--node-id',
    'office-node'
  ], deps);

  const unit = fs.readFileSync(result.status.file, 'utf8');
  assert.equal(unit.includes('--management-key-file'), false);
  assert.equal(readRegistryAgentManagementKey('office-node', deps), 'stored-token');
});

test('fabric registry agent service status and uninstall are scoped by node id', () => {
  const root = makeTempDir();
  const deps = makeDeps(root, 'linux', (cmd) => {
    if (cmd === 'systemctl') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'sh') return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });

  writeRegistryAgentManagementKey('office-node', 'stored-token', deps);
  const status = runFabricRegistryAgentService(['status', '--node-id', 'office-node'], deps);
  assert.equal(status.status.type, 'systemd-user');
  assert.equal(status.status.installed, false);
  assert.equal(status.status.state, 'missing');
  assert.equal(status.status.running, false);
  assert.equal(status.status.issues[0].code, 'fabric_agent_service_missing');
  assert.equal(status.status.nextActions[0].command, "aih fabric registry agent service install '<server-url>' --node-id office-node");
  assert.equal(status.status.unit, 'com.clawdcodex.ai_home.fabric-registry-agent.office-node.service');

  const uninstall = runFabricRegistryAgentService(['uninstall', '--node-id', 'office-node'], deps);
  assert.equal(uninstall.action, 'uninstall');
  assert.equal(uninstall.status.installed, false);
  assert.equal(uninstall.status.state, 'missing');
  assert.equal(readRegistryAgentManagementKey('office-node', deps), '');
});

test('fabric registry agent service restores the previous DB token when install fails', () => {
  const root = makeTempDir();
  const managementKeyFile = path.join(root, 'fabric-node.token');
  fs.writeFileSync(managementKeyFile, 'replacement-management-key');
  const deps = makeDeps(root, 'linux', (cmd, args) => {
    if (cmd === 'sh' && args[1] === 'command -v aih') {
      return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    }
    if (cmd === 'systemctl' && args[0] === '--version') {
      return { status: 0, stdout: 'systemd 255\n', stderr: '' };
    }
    if (cmd === 'systemctl' && args.includes('daemon-reload')) {
      return { status: 1, stdout: '', stderr: 'reload failed' };
    }
    return { status: 1, stdout: '', stderr: '' };
  });
  writeRegistryAgentManagementKey('office-node', 'previous-token', deps);

  assert.throws(
    () => runFabricRegistryAgentService([
      'install',
      'https://control.example.com',
      '--node-id',
      'office-node',
      '--management-key-file',
      managementKeyFile
    ], deps),
    /reload failed/
  );
  assert.equal(readRegistryAgentManagementKey('office-node', deps), 'previous-token');
});

test('fabric command router routes registry agent service JSON', async () => {
  const writes = [];
  const exits = [];
  const code = await runFabricCommandRouter([
    'fabric',
    'registry',
    'agent',
    'service',
    'status',
    '--node-id',
    'office-node',
    '--json'
  ], {
    runFabricRegistryAgentService: (args) => {
      assert.deepEqual(args, ['status', '--node-id', 'office-node', '--json']);
      return {
        ok: true,
        json: true,
        action: 'status',
        nodeId: 'office-node',
        status: {
          state: 'missing',
          type: 'systemd-user',
          installed: false,
          running: false
        }
      };
    },
    processObj: {
      stdout: {
        write(value) {
          writes.push(value);
        }
      },
      exit(codeValue) {
        exits.push(codeValue);
      }
    },
    consoleImpl: {
      log() {},
      error(message) {
        writes.push(message);
      }
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'status');
  assert.equal(payload.nodeId, 'office-node');
  assert.equal(payload.status.state, 'missing');
});
