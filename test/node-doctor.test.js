const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildNodeDoctorReport,
  listNetworkCandidates,
  parseNodeDoctorArgs,
  runNodeDoctor
} = require('../lib/cli/services/node/doctor');
const { runNodeCommandRouter } = require('../lib/cli/commands/node-router');

function createSpawnSync(paths = {}, versions = {}) {
  return (command, args) => {
    if (command === 'sh' && args[0] === '-lc') {
      const match = String(args[1] || '').match(/^command -v (.+)$/);
      const resolved = match ? paths[match[1]] : '';
      return resolved ? { status: 0, stdout: `${resolved}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (command === 'where') {
      const resolved = paths[args[0]];
      return resolved ? { status: 0, stdout: `${resolved}\r\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (args[0] === '--version' && versions[command]) {
      return { status: 0, stdout: `${versions[command]}\n`, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
}

function makeDeps(overrides = {}) {
  return {
    spawnSync: createSpawnSync({
      node: '/usr/local/bin/node',
      npm: '/usr/local/bin/npm',
      aih: '/usr/local/bin/aih'
    }, {
      node: 'v24.1.0',
      npm: '11.0.0'
    }),
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: { PATH: '/usr/local/bin:/usr/bin' }
    },
    hostname: () => 'Lab Node',
    aiHomeDir: '/home/model/.ai_home',
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: 9527,
      managementKey: 'node-secret'
    }),
    networkInterfaces: () => ({
      eth0: [{ family: 'IPv4', address: '192.168.3.8', internal: false }]
    }),
    ...overrides
  };
}

test('parseNodeDoctorArgs accepts control url, node id, and json output', () => {
  assert.deepEqual(parseNodeDoctorArgs([
    '--control-url',
    'https://control.example.com/',
    '--node-id',
    'Lab_Node',
    '--json'
  ]), {
    controlUrl: 'https://control.example.com',
    nodeId: 'Lab_Node',
    json: true
  });
});

test('listNetworkCandidates prioritizes overlay addresses over private LAN addresses', () => {
  const candidates = listNetworkCandidates(() => ({
    en0: [{ family: 'IPv4', address: '192.168.3.8', internal: false }],
    ts0: [{ family: 'IPv4', address: '100.88.1.20', internal: false }],
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }]
  }));

  assert.deepEqual(candidates.map((candidate) => [candidate.interfaceName, candidate.address, candidate.kind]), [
    ['ts0', '100.88.1.20', 'overlay'],
    ['en0', '192.168.3.8', 'private']
  ]);
});

test('listNetworkCandidates ignores reserved IPv4 ranges', () => {
  const candidates = listNetworkCandidates(() => ({
    bridge0: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    link0: [{ family: 'IPv4', address: '169.254.10.20', internal: false }],
    en0: [{ family: 'IPv4', address: '192.168.3.8', internal: false }]
  }));

  assert.deepEqual(candidates.map((candidate) => candidate.address), ['192.168.3.8']);
});

test('buildNodeDoctorReport derives stable node defaults and recommends relay for loopback servers', () => {
  const report = buildNodeDoctorReport({}, makeDeps());

  assert.equal(report.hostname, 'Lab Node');
  assert.equal(report.node.name, 'Lab Node');
  assert.match(report.node.id, /^lab-node-[a-f0-9]{8}$/);
  assert.equal(report.server.listenScope, 'loopback');
  assert.equal(report.server.managementKeyConfigured, true);
  assert.equal(report.server.endpointCandidate, '');
  assert.equal(report.relay.recommended, true);
  assert.equal(report.issues.some((issue) => issue.code === 'management_key_missing'), false);
  assert.equal(report.issues.some((issue) => issue.code === 'server_loopback_only'), true);
});

test('buildNodeDoctorReport selects overlay endpoint candidate for wildcard server', () => {
  const report = buildNodeDoctorReport({ controlUrl: 'https://control.example.com' }, makeDeps({
    readServerConfig: () => ({
      host: '0.0.0.0',
      port: 9527,
      managementKey: 'node-secret'
    }),
    networkInterfaces: () => ({
      en0: [{ family: 'IPv4', address: '192.168.3.8', internal: false }],
      ts0: [{ family: 'IPv4', address: '100.88.1.20', internal: false }]
    })
  }));

  assert.equal(report.server.endpointCandidate, 'http://100.88.1.20:9527');
  assert.equal(report.server.endpointKind, 'overlay');
  assert.equal(report.relay.recommended, false);
  assert.match(report.service.installHint, /aih node relay service install https:\/\/control\.example\.com --node-id lab-node-[a-f0-9]{8}/);
});

test('buildNodeDoctorReport includes relay service running state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-doctor-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unit = path.join(
    root,
    '.config',
    'systemd',
    'user',
    'com.clawdcodex.ai_home.node-relay.nat-node.service'
  );
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, '[Service]\nExecStart=aih node relay connect\n');

  const baseSpawn = createSpawnSync({
    node: '/usr/local/bin/node',
    npm: '/usr/local/bin/npm',
    aih: '/usr/local/bin/aih'
  }, {
    node: 'v24.1.0',
    npm: '11.0.0'
  });
  const report = buildNodeDoctorReport({
    controlUrl: 'https://control.example.com',
    nodeId: 'nat-node'
  }, makeDeps({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    spawnSync(command, args) {
      if (command === 'systemctl' && args[0] === '--user' && args[1] === 'is-enabled') {
        return { status: 0, stdout: 'enabled\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === '--user' && args[1] === 'is-active') {
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === '--version') {
        return { status: 0, stdout: 'systemd 255\n', stderr: '' };
      }
      return baseSpawn(command, args);
    }
  }));

  assert.equal(report.service.state, 'running');
  assert.equal(report.service.running, true);
  assert.equal(report.service.issues.length, 0);
  assert.match(report.service.commands.logs, /journalctl --user -u com\.clawdcodex\.ai_home\.node-relay\.nat-node\.service/);
});

test('runNodeDoctor json report does not leak management key', () => {
  const result = runNodeDoctor(['--json'], makeDeps({
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: 9527,
      managementKey: 'super-secret'
    })
  }));
  const serialized = JSON.stringify(result);

  assert.equal(result.json, true);
  assert.equal(result.report.server.managementKeyConfigured, true);
  assert.equal(serialized.includes('super-secret'), false);
});

test('buildNodeDoctorReport reports Windows startup bootstrap constraints', () => {
  const report = buildNodeDoctorReport({}, makeDeps({
    spawnSync: createSpawnSync({
      node: 'C:\\Node\\node.exe',
      npm: 'C:\\Node\\npm.cmd',
      aih: 'C:\\Users\\model\\AppData\\Roaming\\npm\\aih.cmd'
    }, {
      node: 'v24.1.0',
      npm: '11.0.0'
    }),
    processObj: {
      platform: 'win32',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: 'C:\\Node\\node.exe',
      env: { PATH: 'C:\\Node' }
    }
  }));

  assert.equal(report.service.supported, true);
  assert.equal(report.service.type, 'windows-startup');
  assert.equal(report.issues.some((issue) => issue.code === 'windows_bootstrap_note'), true);
});

test('runNodeCommandRouter prints doctor report through node command', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter(['node', 'doctor', '--control-url', 'https://control.example.com'], {
    ...makeDeps(),
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  const output = writes.join('\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.match(output, /\[aih\] node doctor/);
  assert.match(output, /default node: Lab Node \(lab-node-[a-f0-9]{8}\)/);
  assert.equal(output.includes('node-secret'), false);
});
