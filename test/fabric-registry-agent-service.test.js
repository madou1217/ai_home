const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');
const {
  parseFabricRegistryAgentServiceArgs,
  runFabricRegistryAgentService
} = require('../lib/cli/services/fabric/registry-agent-service');

function makeTempDir(prefix = 'aih-fabric-agent-service-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test('fabric registry agent service rejects raw token persistence', () => {
  assert.throws(
    () => parseFabricRegistryAgentServiceArgs([
      'install',
      'https://control.example.com',
      '--node-id',
      'office-node',
      '--token',
      'secret-token'
    ]),
    { code: 'fabric_agent_service_token_not_allowed' }
  );
});

test('fabric registry agent service installs Linux systemd unit without leaking token contents', () => {
  const root = makeTempDir();
  const tokenFile = path.join(root, 'fabric-node.token');
  fs.writeFileSync(tokenFile, 'secret-device-token');
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
    '--token-file',
    tokenFile,
    '--relay-status',
    'online',
    '--transport',
    'relay=online',
    '--probe-transport',
    'relay=tcp://127.0.0.1:8766',
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
  assert.match(unit, /"--token-file"/);
  assert.match(unit, new RegExp(tokenFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(unit, /"--probe-transport" "relay=tcp:\/\/127\.0\.0\.1:8766"/);
  assert.match(unit, /"--interval-ms" "2000"/);
  assert.match(unit, new RegExp(`Environment="AIH_HOST_HOME=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(unit.includes('secret-device-token'), false);
  assert.equal(calls.some((call) => call.cmd === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.fabric-registry-agent.office-node.service'), true);
});

test('fabric registry agent service writes Linux systemd unit to the real user home', () => {
  const root = makeTempDir();
  const realHome = path.join(root, 'real-home');
  const tokenFile = path.join(root, 'fabric-node.token');
  fs.writeFileSync(tokenFile, 'secret-device-token');
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
    '--token-file',
    tokenFile
  ], deps);

  assert.equal(
    result.status.file,
    path.join(realHome, '.config', 'systemd', 'user', 'com.clawdcodex.ai_home.fabric-registry-agent.office-node.service')
  );
  assert.equal(fs.existsSync(result.status.file), true);
});

test('fabric registry agent service status and uninstall are scoped by node id', () => {
  const root = makeTempDir();
  const deps = makeDeps(root, 'linux', (cmd) => {
    if (cmd === 'systemctl') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'sh') return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });

  const status = runFabricRegistryAgentService(['status', '--node-id', 'office-node'], deps);
  assert.equal(status.status.type, 'systemd-user');
  assert.equal(status.status.installed, false);
  assert.equal(status.status.state, 'missing');
  assert.equal(status.status.running, false);
  assert.equal(status.status.issues[0].code, 'fabric_agent_service_missing');
  assert.equal(status.status.nextActions[0].command, "aih fabric registry agent service install '<server-url>' --node-id office-node --token-file '<token-file>'");
  assert.equal(status.status.unit, 'com.clawdcodex.ai_home.fabric-registry-agent.office-node.service');

  const uninstall = runFabricRegistryAgentService(['uninstall', '--node-id', 'office-node'], deps);
  assert.equal(uninstall.action, 'uninstall');
  assert.equal(uninstall.status.installed, false);
  assert.equal(uninstall.status.state, 'missing');
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
