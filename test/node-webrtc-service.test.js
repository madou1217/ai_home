const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  parseNodeWebrtcServiceArgs,
  runNodeWebrtcService
} = require('../lib/cli/services/node/webrtc-service');

function makeTempDir(prefix = 'aih-node-webrtc-service-') {
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
    hostHomeDir: root,
    readServerConfig: () => ({ managementKey: 'node-secret' })
  };
}

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
