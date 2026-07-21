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
const {
  buildNodeSupervisorInstallPlan,
  buildNodeSupervisorUninstallPlan,
  parseNodeSupervisorServiceArgs,
  runNodeSupervisorService
} = require('../lib/cli/services/node/supervisor-service');
const { runNodeCommandRouter } = require('../lib/cli/commands/node-router');
const {
  readRegistryAgentManagementKey,
  writeRegistryAgentManagementKey
} = require('../lib/cli/services/fabric/registry-agent-management-key-store');

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

test('parseNodeSupervisorServiceArgs accepts status, install, and uninstall actions', () => {
  assert.deepEqual(parseNodeSupervisorServiceArgs([
    'status',
    '--control-url',
    'https://control.example.com/',
    '--node-id',
    'Nat_Node',
    '--json'
  ]), {
    action: 'status',
    controlUrl: 'https://control.example.com',
    nodeId: 'Nat_Node',
    json: true
  });

  const managementKeyFile = path.join(os.tmpdir(), 'aih-fabric-node.token');
  assert.deepEqual(parseNodeSupervisorServiceArgs([
    'install',
    'https://control.example.com/',
    '--node-id',
    'Nat_Node',
    '--management-key-file',
    managementKeyFile,
    '--dry-run',
    '--json',
    '--heartbeat-ms',
    '2000',
    '--transport',
    'relay=online',
    '--probe-transport',
    'relay=tcp://127.0.0.1:8766'
  ]), {
    action: 'install',
    controlUrl: 'https://control.example.com',
    nodeId: 'Nat_Node',
    managementKeyFile,
    json: true,
    yes: false,
    dryRun: true,
    relay: {
      heartbeatMs: '2000',
      connectTimeoutMs: '',
      reconnectDelayMs: ''
    },
    webrtc: {
      connectTimeoutMs: '',
      reconnectDelayMs: ''
    },
    registryAgent: {
      status: '',
      relayStatus: '',
      transports: ['relay=online'],
      probeTransports: ['relay=tcp://127.0.0.1:8766'],
      probeTimeoutMs: '',
      probeMethod: '',
      probeCount: '',
      probePayloadSize: '',
      intervalMs: ''
    }
  });

  assert.deepEqual(parseNodeSupervisorServiceArgs([
    'uninstall',
    '--node-id',
    'Nat_Node',
    '--dry-run',
    '--json'
  ]), {
    action: 'uninstall',
    nodeId: 'Nat_Node',
    json: true,
    yes: false,
    dryRun: true
  });

  assert.throws(
    () => parseNodeSupervisorServiceArgs(['unknown']),
    { code: 'unknown_node_service_action' }
  );
});

test('buildNodeSupervisorInstallPlan composes relay and registry agent service commands', () => {
  const plan = buildNodeSupervisorInstallPlan(parseNodeSupervisorServiceArgs([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--management-key-file',
    '/tmp/fabric-node.token',
    '--dry-run',
    '--heartbeat-ms',
    '2000',
    '--relay-status',
    'online',
    '--probe-transport',
    'relay=tcp://127.0.0.1:8766'
  ]));

  assert.equal(plan.action, 'install');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.writes, false);
  assert.equal(plan.requiresConfirmation, false);
  assert.deepEqual(plan.services.map((service) => service.key), ['relay', 'registryAgent', 'webrtc']);
  assert.match(plan.services[0].command, /aih node relay service install https:\/\/control\.example\.com --node-id nat-node/);
  assert.match(plan.services[0].command, /--heartbeat-ms 2000/);
  assert.match(plan.services[1].command, /aih fabric registry agent service install https:\/\/control\.example\.com --node-id nat-node --management-key-file \/tmp\/fabric-node\.token/);
  assert.match(plan.services[1].command, /--relay-status online/);
  assert.match(plan.services[1].command, /--probe-transport relay=tcp:\/\/127\.0\.0\.1:8766/);
  assert.match(plan.services[1].command, /--runtime-diagnostics/);
  assert.match(plan.services[2].command, /aih node webrtc service install https:\/\/control\.example\.com --node-id nat-node/);
});

test('node supervisor reuses a DB token without adding token-file to its install plan', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-service-db-token-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  writeRegistryAgentManagementKey('nat-node', 'stored-token', deps);

  const options = parseNodeSupervisorServiceArgs([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--dry-run'
  ], deps);
  const plan = buildNodeSupervisorInstallPlan(options);

  assert.equal(plan.services[1].command.includes('--management-key-file'), false);
});

test('buildNodeSupervisorUninstallPlan composes registry agent and relay rollback commands', () => {
  const plan = buildNodeSupervisorUninstallPlan(parseNodeSupervisorServiceArgs([
    'uninstall',
    '--node-id',
    'nat-node',
    '--dry-run'
  ]));

  assert.equal(plan.action, 'uninstall');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.writes, false);
  assert.equal(plan.requiresConfirmation, false);
  assert.deepEqual(plan.services.map((service) => service.key), ['webrtc', 'registryAgent', 'relay']);
  assert.equal(plan.services[0].command, 'aih node webrtc service uninstall --node-id nat-node');
  assert.equal(plan.services[1].command, 'aih fabric registry agent service uninstall --node-id nat-node');
  assert.equal(plan.services[2].command, 'aih node relay service uninstall --node-id nat-node');
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
      if (command === 'systemctl'
        && args[0] === '--user'
        && args[1] === 'is-enabled'
        && args[2] === 'com.clawdcodex.ai_home.node-relay.nat-node.service') {
        return { status: 0, stdout: 'enabled\n', stderr: '' };
      }
      if (command === 'systemctl'
        && args[0] === '--user'
        && args[1] === 'is-active'
        && args[2] === 'com.clawdcodex.ai_home.node-relay.nat-node.service') {
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
  assert.equal(report.services.relay.state, 'running');
  assert.equal(report.services.registryAgent.state, 'missing');
  assert.equal(report.services.webrtc.state, 'missing');
  assert.equal(report.services.registryAgent.installHint, "aih fabric registry agent service install https://control.example.com --node-id nat-node --management-key-file '<management-key-file>'");
  assert.equal(report.nodeSupervisor.ready, false);
  assert.equal(report.nodeSupervisor.issues.some((issue) => issue.code === 'registry_agent_service_not_running'), true);
  assert.equal(report.nodeSupervisor.issues.some((issue) => issue.code === 'webrtc_service_not_running'), true);
  assert.equal(report.nextSteps.some((step) => step.includes('fabric registry agent service install')), true);
  assert.equal(report.nextSteps.some((step) => step.includes('node webrtc service install')), true);
  assert.match(report.service.commands.logs, /journalctl --user -u com\.clawdcodex\.ai_home\.node-relay\.nat-node\.service/);
});

test('buildNodeDoctorReport reports supervisor ready when relay and registry agent services run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-doctor-supervisor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceDir = path.join(root, '.config', 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(
    path.join(serviceDir, 'com.clawdcodex.ai_home.node-relay.nat-node.service'),
    '[Service]\nExecStart=aih node relay connect\n'
  );
  fs.writeFileSync(
    path.join(serviceDir, 'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service'),
    '[Service]\nExecStart=aih fabric registry agent\n'
  );
  fs.writeFileSync(
    path.join(serviceDir, 'com.clawdcodex.ai_home.node-webrtc.nat-node.service'),
    '[Service]\nExecStart=aih node webrtc connect\n'
  );
  fs.writeFileSync(
    path.join(serviceDir, 'com.clawdcodex.ai_home.node-webrtc.nat-node.service'),
    '[Service]\nExecStart=aih node webrtc connect\n'
  );

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
      if (command === 'systemctl' && args[0] === '--version') {
        return { status: 0, stdout: 'systemd 255\n', stderr: '' };
      }
      if (command === 'systemctl'
        && args[0] === '--user'
        && (args[1] === 'is-enabled' || args[1] === 'is-active')
        && [
          'com.clawdcodex.ai_home.node-relay.nat-node.service',
          'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service',
          'com.clawdcodex.ai_home.node-webrtc.nat-node.service'
        ].includes(args[2])) {
        return { status: 0, stdout: args[1] === 'is-active' ? 'active\n' : 'enabled\n', stderr: '' };
      }
      return baseSpawn(command, args);
    }
  }));

  assert.equal(report.services.relay.running, true);
  assert.equal(report.services.registryAgent.running, true);
  assert.equal(report.services.webrtc.running, true);
  assert.equal(report.nodeSupervisor.ready, true);
  assert.equal(report.nodeSupervisor.issues.length, 0);
  assert.deepEqual(report.nodeSupervisor.required.map((item) => [item.key, item.ready]), [
    ['relay', true],
    ['registry_agent', true],
    ['webrtc', true]
  ]);
});

test('buildNodeDoctorReport injects user systemd env for server diagnostics', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-doctor-systemd-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceDir = path.join(root, '.config', 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });
  [
    'com.clawdcodex.ai_home.node-relay.nat-node.service',
    'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service',
    'com.clawdcodex.ai_home.node-webrtc.nat-node.service'
  ].forEach((file) => {
    fs.writeFileSync(path.join(serviceDir, file), '[Service]\nExecStart=aih\n');
  });

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
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      getuid: () => 1000
    },
    spawnSync(command, args, options = {}) {
      if (command === 'systemctl' && args[0] === '--version') {
        return { status: 0, stdout: 'systemd 255\n', stderr: '' };
      }
      if (command === 'systemctl'
        && args[0] === '--user'
        && (args[1] === 'is-enabled' || args[1] === 'is-active')) {
        assert.equal(options.env.XDG_RUNTIME_DIR, '/run/user/1000');
        assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
        return { status: 0, stdout: args[1] === 'is-active' ? 'active\n' : 'enabled\n', stderr: '' };
      }
      return baseSpawn(command, args);
    }
  }));

  assert.equal(report.services.relay.running, true);
  assert.equal(report.services.registryAgent.running, true);
  assert.equal(report.services.webrtc.running, true);
  assert.equal(report.nodeSupervisor.ready, true);
});

test('runNodeSupervisorService summarizes both supervised services without leaking secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-service-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceDir = path.join(root, '.config', 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(
    path.join(serviceDir, 'com.clawdcodex.ai_home.node-relay.nat-node.service'),
    '[Service]\nExecStart=aih node relay connect\n'
  );
  fs.writeFileSync(
    path.join(serviceDir, 'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service'),
    '[Service]\nExecStart=aih fabric registry agent\n'
  );

  const baseSpawn = createSpawnSync({
    node: '/usr/local/bin/node',
    npm: '/usr/local/bin/npm',
    aih: '/usr/local/bin/aih'
  }, {
    node: 'v24.1.0',
    npm: '11.0.0'
  });
  const result = runNodeSupervisorService([
    'status',
    '--control-url',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--json'
  ], makeDeps({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: 9527,
      managementKey: 'super-secret'
    }),
    spawnSync(command, args) {
      if (command === 'systemctl' && args[0] === '--version') {
        return { status: 0, stdout: 'systemd 255\n', stderr: '' };
      }
      if (command === 'systemctl'
        && args[0] === '--user'
        && (args[1] === 'is-enabled' || args[1] === 'is-active')
        && [
          'com.clawdcodex.ai_home.node-relay.nat-node.service',
          'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service',
          'com.clawdcodex.ai_home.node-webrtc.nat-node.service'
        ].includes(args[2])) {
        return { status: 0, stdout: args[1] === 'is-active' ? 'active\n' : 'enabled\n', stderr: '' };
      }
      return baseSpawn(command, args);
    }
  }));

  const serialized = JSON.stringify(result);
  assert.equal(result.ok, true);
  assert.equal(result.json, true);
  assert.equal(result.action, 'status');
  assert.equal(result.nodeId, 'nat-node');
  assert.equal(result.status.supervisor.ready, true);
  assert.equal(result.status.services.relay.running, true);
  assert.equal(result.status.services.registryAgent.running, true);
  assert.equal(result.status.services.webrtc.running, true);
  assert.equal(result.status.server.managementKeyConfigured, true);
  assert.equal(serialized.includes('super-secret'), false);
});

test('runNodeSupervisorService install dry-run returns plan without writing service files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-service-install-dry-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runNodeSupervisorService([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--management-key-file',
    path.join(root, 'missing.token'),
    '--dry-run',
    '--json'
  ], makeDeps({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        AIH_CLI_PATH: '/usr/local/bin/aih'
      },
      cwd() {
        return root;
      }
    },
    spawnSync(command) {
      if (command === 'systemctl') return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  }));

  const serviceDir = path.join(root, '.config', 'systemd', 'user');
  assert.equal(result.ok, true);
  assert.equal(result.json, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.services.length, 3);
  assert.equal(fs.existsSync(serviceDir), false);
});

test('runNodeSupervisorService install requires explicit confirmation and readable token file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-service-install-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missingManagementKeyFile = path.join(root, 'missing.token');

  const deps = makeDeps({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    readServerConfig: () => ({ managementKey: 'super-secret' }),
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        AIH_CLI_PATH: '/usr/local/bin/aih'
      },
      cwd() {
        return root;
      }
    },
    spawnSync(command) {
      if (command === 'systemctl') return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  });

  assert.throws(
    () => runNodeSupervisorService([
      'install',
      'https://control.example.com',
      '--node-id',
      'nat-node',
      '--management-key-file',
      missingManagementKeyFile
    ], deps),
    { code: 'node_service_install_confirmation_required' }
  );

  assert.throws(
    () => runNodeSupervisorService([
      'install',
      'https://control.example.com',
      '--node-id',
      'nat-node',
      '--management-key-file',
      missingManagementKeyFile,
      '--yes'
    ], deps),
    { code: 'management_key_file_unreadable', file: missingManagementKeyFile }
  );
});

test('runNodeSupervisorService install writes supervised systemd units without leaking secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-service-install-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managementKeyFile = path.join(root, 'fabric-node.token');
  fs.writeFileSync(managementKeyFile, 'management-secret');
  const calls = [];
  const deps = makeDeps({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    readServerConfig: () => ({ managementKey: 'super-secret' }),
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        AIH_CLI_PATH: '/opt/aih/bin/aih'
      },
      cwd() {
        return root;
      }
    },
    spawnSync(command, args) {
      calls.push({ command, args });
      if (command === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  });

  const result = runNodeSupervisorService([
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--management-key-file',
    managementKeyFile,
    '--yes',
    '--json',
    '--reconnect-delay-ms',
    '5000',
    '--relay-status',
    'online',
    '--probe-transport',
    'relay=tcp://127.0.0.1:8766'
  ], deps);

  const relayUnit = path.join(root, '.config', 'systemd', 'user', 'com.clawdcodex.ai_home.node-relay.nat-node.service');
  const registryUnit = path.join(root, '.config', 'systemd', 'user', 'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service');
  const webrtcUnit = path.join(root, '.config', 'systemd', 'user', 'com.clawdcodex.ai_home.node-webrtc.nat-node.service');
  const relayContent = fs.readFileSync(relayUnit, 'utf8');
  const registryContent = fs.readFileSync(registryUnit, 'utf8');
  const webrtcContent = fs.readFileSync(webrtcUnit, 'utf8');
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.json, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.status.supervisor.ready, true);
  assert.equal(result.result.relay.status.running, true);
  assert.equal(result.result.registryAgent.status.running, true);
  assert.equal(result.result.webrtc.status.running, true);
  assert.match(relayContent, /ExecStart="\/opt\/aih\/bin\/aih" "node" "relay" "connect" "https:\/\/control\.example\.com"/);
  assert.match(relayContent, /"--node-id" "nat-node"/);
  assert.match(relayContent, /"--reconnect-delay-ms" "5000"/);
  assert.match(registryContent, /ExecStart="\/opt\/aih\/bin\/aih" "fabric" "registry" "agent" "https:\/\/control\.example\.com"/);
  assert.match(registryContent, /"--node-id" "nat-node"/);
  assert.equal(registryContent.includes('--management-key-file'), false);
  assert.equal(registryContent.includes(managementKeyFile), false);
  assert.equal(readRegistryAgentManagementKey('nat-node', deps), 'management-secret');
  assert.match(registryContent, /"--probe-transport" "relay=tcp:\/\/127\.0\.0\.1:8766"/);
  assert.match(webrtcContent, /ExecStart="\/opt\/aih\/bin\/aih" "node" "webrtc" "connect" "https:\/\/control\.example\.com"/);
  assert.match(webrtcContent, /"--node-id" "nat-node"/);
  assert.match(webrtcContent, /"--reconnect-delay-ms" "5000"/);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(relayContent.includes('super-secret'), false);
  assert.equal(registryContent.includes('management-secret'), false);
  assert.equal(webrtcContent.includes('super-secret'), false);
  assert.equal(calls.filter((call) => call.command === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.node-relay.nat-node.service').length, 1);
  assert.equal(calls.filter((call) => call.command === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service').length, 1);
  assert.equal(calls.filter((call) => call.command === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.node-webrtc.nat-node.service').length, 1);
});

test('runNodeSupervisorService uninstall dry-run returns rollback plan without deleting files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-service-uninstall-dry-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceDir = path.join(root, '.config', 'systemd', 'user');
  const relayUnit = path.join(serviceDir, 'com.clawdcodex.ai_home.node-relay.nat-node.service');
  const registryUnit = path.join(serviceDir, 'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service');
  const webrtcUnit = path.join(serviceDir, 'com.clawdcodex.ai_home.node-webrtc.nat-node.service');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(relayUnit, '[Service]\nExecStart=aih node relay connect\n');
  fs.writeFileSync(registryUnit, '[Service]\nExecStart=aih fabric registry agent\n');
  fs.writeFileSync(webrtcUnit, '[Service]\nExecStart=aih node webrtc connect\n');

  const result = runNodeSupervisorService([
    'uninstall',
    '--node-id',
    'nat-node',
    '--dry-run',
    '--json'
  ], makeDeps({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        AIH_CLI_PATH: '/usr/local/bin/aih'
      },
      cwd() {
        return root;
      }
    },
    spawnSync(command) {
      if (command === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.json, true);
  assert.equal(result.action, 'uninstall');
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.plan.services.map((service) => service.key), ['webrtc', 'registryAgent', 'relay']);
  assert.equal(fs.existsSync(relayUnit), true);
  assert.equal(fs.existsSync(registryUnit), true);
  assert.equal(fs.existsSync(webrtcUnit), true);
});

test('runNodeSupervisorService uninstall requires confirmation and deletes supervised systemd units', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-service-uninstall-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceDir = path.join(root, '.config', 'systemd', 'user');
  const relayUnit = path.join(serviceDir, 'com.clawdcodex.ai_home.node-relay.nat-node.service');
  const registryUnit = path.join(serviceDir, 'com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service');
  const webrtcUnit = path.join(serviceDir, 'com.clawdcodex.ai_home.node-webrtc.nat-node.service');
  const calls = [];
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(relayUnit, '[Service]\nExecStart=aih node relay connect\n');
  fs.writeFileSync(registryUnit, '[Service]\nExecStart=aih fabric registry agent\n');
  fs.writeFileSync(webrtcUnit, '[Service]\nExecStart=aih node webrtc connect\n');

  const deps = makeDeps({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    processObj: {
      platform: 'linux',
      arch: 'x64',
      version: 'v24.1.0',
      execPath: '/usr/local/bin/node',
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        AIH_CLI_PATH: '/usr/local/bin/aih'
      },
      cwd() {
        return root;
      }
    },
    spawnSync(command, args) {
      calls.push({ command, args });
      if (command === 'systemctl' && args[0] === '--version') {
        return { status: 0, stdout: 'systemd 255\n', stderr: '' };
      }
      if (command === 'systemctl'
        && args[0] === '--user'
        && (args[1] === 'is-enabled' || args[1] === 'is-active')) {
        const unitExists = args[2] && args[2].includes('fabric-registry-agent')
          ? fs.existsSync(registryUnit)
          : (args[2] && args[2].includes('node-webrtc')
            ? fs.existsSync(webrtcUnit)
            : fs.existsSync(relayUnit));
        return unitExists
          ? { status: 0, stdout: args[1] === 'is-active' ? 'active\n' : 'enabled\n', stderr: '' }
          : { status: 1, stdout: 'inactive\n', stderr: '' };
      }
      if (command === 'systemctl') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  });

  assert.throws(
    () => runNodeSupervisorService([
      'uninstall',
      '--node-id',
      'nat-node'
    ], deps),
    { code: 'node_service_uninstall_confirmation_required' }
  );

  const result = runNodeSupervisorService([
    'uninstall',
    '--node-id',
    'nat-node',
    '--yes',
    '--json'
  ], deps);

  const serialized = JSON.stringify(result);
  assert.equal(result.ok, true);
  assert.equal(result.json, true);
  assert.equal(result.action, 'uninstall');
  assert.equal(result.dryRun, false);
  assert.equal(result.status.supervisor.ready, false);
  assert.equal(result.status.services.relay.state, 'missing');
  assert.equal(result.status.services.registryAgent.state, 'missing');
  assert.equal(result.status.services.webrtc.state, 'missing');
  assert.equal(fs.existsSync(relayUnit), false);
  assert.equal(fs.existsSync(registryUnit), false);
  assert.equal(fs.existsSync(webrtcUnit), false);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(calls.some((call) => call.command === 'systemctl' && call.args.join(' ') === '--user disable --now com.clawdcodex.ai_home.node-webrtc.nat-node.service'), true);
  assert.equal(calls.some((call) => call.command === 'systemctl' && call.args.join(' ') === '--user disable --now com.clawdcodex.ai_home.fabric-registry-agent.nat-node.service'), true);
  assert.equal(calls.some((call) => call.command === 'systemctl' && call.args.join(' ') === '--user disable --now com.clawdcodex.ai_home.node-relay.nat-node.service'), true);
});

test('runNodeCommandRouter prints node service status JSON', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'service',
    'status',
    '--control-url',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--json'
  ], {
    ...makeDeps(),
    runNodeSupervisorService: (args) => {
      assert.deepEqual(args, [
        'status',
        '--control-url',
        'https://control.example.com',
        '--node-id',
        'nat-node',
        '--json'
      ]);
      return {
        ok: false,
        json: true,
        action: 'status',
        nodeId: 'nat-node',
        status: {
          supervisor: {
            ready: false,
            required: [],
            issues: []
          },
          services: {
            relay: { state: 'missing', running: false },
            registryAgent: { state: 'missing', running: false },
            webrtc: { state: 'missing', running: false }
          },
          issues: [],
          nextSteps: []
        }
      };
    },
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  const payload = JSON.parse(writes.join(''));
  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.action, 'status');
  assert.equal(payload.nodeId, 'nat-node');
  assert.equal(payload.status.services.relay.state, 'missing');
  assert.equal(payload.status.services.webrtc.state, 'missing');
});

test('runNodeCommandRouter prints node service install JSON plan', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'service',
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--management-key-file',
    '/tmp/fabric-node.token',
    '--dry-run',
    '--json'
  ], {
    ...makeDeps(),
    runNodeSupervisorService: (args) => {
      assert.deepEqual(args, [
        'install',
        'https://control.example.com',
        '--node-id',
        'nat-node',
        '--management-key-file',
        '/tmp/fabric-node.token',
        '--dry-run',
        '--json'
      ]);
      return {
        ok: true,
        json: true,
        action: 'install',
        nodeId: 'nat-node',
        dryRun: true,
        plan: {
          services: [
            {
              key: 'relay',
              label: 'Relay service',
              command: 'aih node relay service install https://control.example.com --node-id nat-node'
            },
            {
              key: 'registryAgent',
              label: 'Fabric registry agent service',
              command: 'aih fabric registry agent service install https://control.example.com --node-id nat-node --management-key-file /tmp/fabric-node.token'
            },
            {
              key: 'webrtc',
              label: 'WebRTC connector service',
              command: 'aih node webrtc service install https://control.example.com --node-id nat-node'
            }
          ]
        },
        status: {
          supervisor: { ready: false, required: [], issues: [] },
          services: {
            relay: { state: 'missing', running: false },
            registryAgent: { state: 'missing', running: false },
            webrtc: { state: 'missing', running: false }
          },
          issues: [],
          nextSteps: []
        }
      };
    },
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  const payload = JSON.parse(writes.join(''));
  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'install');
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.plan.services.map((service) => service.key), ['relay', 'registryAgent', 'webrtc']);
});

test('runNodeCommandRouter prints node service uninstall JSON plan', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'service',
    'uninstall',
    '--node-id',
    'nat-node',
    '--dry-run',
    '--json'
  ], {
    ...makeDeps(),
    runNodeSupervisorService: (args) => {
      assert.deepEqual(args, [
        'uninstall',
        '--node-id',
        'nat-node',
        '--dry-run',
        '--json'
      ]);
      return {
        ok: true,
        json: true,
        action: 'uninstall',
        nodeId: 'nat-node',
        dryRun: true,
        plan: {
          services: [
            {
              key: 'webrtc',
              label: 'WebRTC connector service',
              command: 'aih node webrtc service uninstall --node-id nat-node'
            },
            {
              key: 'registryAgent',
              label: 'Fabric registry agent service',
              command: 'aih fabric registry agent service uninstall --node-id nat-node'
            },
            {
              key: 'relay',
              label: 'Relay service',
              command: 'aih node relay service uninstall --node-id nat-node'
            }
          ]
        },
        status: {
          supervisor: { ready: false, required: [], issues: [] },
          services: {
            relay: { state: 'installed', running: false },
            registryAgent: { state: 'installed', running: false },
            webrtc: { state: 'installed', running: false }
          },
          issues: [],
          nextSteps: []
        }
      };
    },
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  const payload = JSON.parse(writes.join(''));
  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'uninstall');
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.plan.services.map((service) => service.key), ['webrtc', 'registryAgent', 'relay']);
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
