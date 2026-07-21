'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstallDryRunCommand,
  buildRegistryReadbackCommand,
  buildManagementKeyStateCommand,
  buildRemoteCodeReadinessCommand,
  buildServerHostHomeCommand,
  normalizeRegistryReadback,
  parseArgs,
  parseRemoteCodeReadiness,
  parseServerHostHomes,
  parseManagementKeyState,
  splitResidueProcesses,
  summarizePreflight
} = require('../scripts/fabric-m3-daemon-preflight');

function readyRegistryPayload(nodeId = 'aws-current-node') {
  return {
    ok: true,
    http: 200,
    counts: {
      nodes: 2,
      relayNodes: 2,
      projects: 2,
      runtimes: 4,
      transports: 2,
      nodeInventory: 2
    },
    targetNode: {
      id: nodeId,
      runtimeHost: false,
      runtimeProviders: [],
      runtimeGaps: [
        'codex:missing_provider_runtime:codex',
        'claude:missing_provider_runtime:claude',
        'agy:missing_provider_runtime:agy',
        'opencode:missing_provider_runtime:opencode'
      ]
    }
  };
}

test('parseArgs defaults to AWS current target and default port', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(parsed.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(parsed.nodeId, 'aws-current-node');
  assert.equal(parsed.port, 9527);
});

test('buildInstallDryRunCommand never writes services or passes raw secrets', () => {
  const parsed = parseArgs([
    '--remote-dir',
    '/home/ubuntu/aih-fabric-current',
    '--node-id',
    'aws-current-node'
  ]);
  const command = buildInstallDryRunCommand(parsed);
  assert.match(command, /node bin\/ai-home\.js node service install/);
  assert.match(command, /--dry-run/);
  assert.doesNotMatch(command, /--yes/);
  assert.doesNotMatch(command, /--management-key/);
  assert.doesNotMatch(command, /--token-file/);
  assert.match(command, /relay=ws:\/\/127\.0\.0\.1:9527\/v0\/fabric\/transport\/echo/);
});

test('buildRemoteCodeReadinessCommand checks the 7.3 safety entrypoint without writing', () => {
  const parsed = parseArgs([]);
  const command = buildRemoteCodeReadinessCommand(parsed);
  assert.match(command, /export PATH='\/home\/ubuntu\/aih-fabric-current\/\.node-runtime\/node-v22\.16\.0-linux-x64\/bin':\$PATH/);
  assert.match(command, /grep -q -- '--generate-management-key'/);
  assert.match(command, /13-m3-supervised-daemon-runbook\.md/);
  assert.doesNotMatch(command, />/);
  assert.doesNotMatch(command, /server config set/);
  assert.doesNotMatch(command, /node service install/);
});

test('buildServerHostHomeCommand checks running server env without printing secrets', () => {
  const command = buildServerHostHomeCommand();
  assert.match(command, /\/proc\/\$pid\/environ/);
  assert.match(command, /AIH_HOST_HOME/);
  assert.doesNotMatch(command, /cat .*token/);
  assert.doesNotMatch(command, /control-plane-device-secrets/);
});

test('buildRegistryReadbackCommand reads registry through the DB Management Key without printing secrets', () => {
  const parsed = parseArgs([]);
  const command = buildRegistryReadbackCommand(parsed);
  assert.match(command, /\/v0\/fabric\/registry/);
  assert.match(command, /aws-current-node/);
  assert.match(command, /readRegistryAgentManagementKey/);
  assert.match(command, /Bearer/);
  assert.doesNotMatch(command, /cat .*token/);
  assert.doesNotMatch(command, /console\.log\(token/);
  assert.match(command, /runtimeGaps/);
});

test('normalizeRegistryReadback keeps runtime gaps but gates on target node presence', () => {
  assert.deepEqual(
    normalizeRegistryReadback(readyRegistryPayload(), 'aws-current-node'),
    {
      ok: true,
      http: 200,
      counts: {
        nodes: 2,
        relayNodes: 2,
        projects: 2,
        runtimes: 4,
        transports: 2,
        nodeInventory: 2
      },
      targetNode: {
        id: 'aws-current-node',
        present: true,
        runtimeHost: false,
        runtimeProviders: [],
        runtimeGaps: [
          'codex:missing_provider_runtime:codex',
          'claude:missing_provider_runtime:claude',
          'agy:missing_provider_runtime:agy',
          'opencode:missing_provider_runtime:opencode'
        ]
      },
      error: ''
    }
  );

  assert.equal(
    normalizeRegistryReadback({
      ok: true,
      http: 200,
      counts: { nodes: 1 },
      targetNode: { id: 'other-node' }
    }, 'aws-current-node').targetNode.present,
    false
  );
});

test('DB Management Key state reports presence without reading Management Key contents', () => {
  const command = buildManagementKeyStateCommand(parseArgs([]));
  assert.match(command, /registry-agent-management-key-store/);
  assert.doesNotMatch(command, /management_key_path|\.key/);
  assert.deepEqual(
    parseManagementKeyState('management_key_source=app-state.db present=yes\n'),
    {
      ok: true,
      source: 'app-state.db',
      present: true
    }
  );
});

test('parseServerHostHomes marks only the expected host home as ready', () => {
  assert.deepEqual(
    parseServerHostHomes(
      [
        'pid=121002 AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home',
        'pid=121003 AIH_HOST_HOME=/home/ubuntu/.ai_home'
      ].join('\n'),
      '/home/ubuntu/aih-fabric-current/.aih-host-home'
    ),
    [
      {
        pid: 121002,
        hostHome: '/home/ubuntu/aih-fabric-current/.aih-host-home',
        ok: true
      },
      {
        pid: 121003,
        hostHome: '/home/ubuntu/.ai_home',
        ok: false
      }
    ]
  );
});

test('splitResidueProcesses keeps supervised relay, registry agent, and WebRTC connector out of residue', () => {
  const parsed = parseArgs([]);
  assert.deepEqual(
    splitResidueProcesses([
      '140408 node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node',
      '225639 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node',
      '225640 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node',
      '225777 node scripts/fabric-real-broker-smoke.js'
    ].join('\n'), parsed, {
      relay: { running: true },
      registryAgent: { running: true },
      webrtc: { running: true }
    }),
    {
      supervised: [
        '140408 node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node',
        '225639 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node',
        '225640 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node'
      ],
      unexpected: [
        '225777 node scripts/fabric-real-broker-smoke.js'
      ],
      duplicateSupervised: []
    }
  );
});

test('parseRemoteCodeReadiness extracts generate-management-key and runbook capability', () => {
  assert.deepEqual(
    parseRemoteCodeReadiness('generate_management_key=yes runbook=no\n'),
    {
      ready: false,
      generateManagementKey: true,
      supervisedDaemonRunbook: false
    }
  );
  assert.deepEqual(
    parseRemoteCodeReadiness('generate_management_key=yes runbook=yes\n'),
    {
      ready: true,
      generateManagementKey: true,
      supervisedDaemonRunbook: true
    }
  );
});

test('summarizePreflight reports remaining 7.3 gate from real status surfaces', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    managementKeyState: {
      stdout: 'management_key_source=app-state.db present=yes\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    serverHostHome: { stdout: 'pid=121002 AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home\n' },
    remoteCode: { stdout: 'generate_management_key=yes runbook=yes\n' },
    residue: { stdout: '' },
    registryPayload: readyRegistryPayload(),
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }, { key: 'webrtc' }]
      }
    },
    statusPayload: {
      ok: false,
      status: {
        server: { managementKeyConfigured: false },
        supervisor: { ready: false },
        services: {
          relay: { state: 'missing', running: false, unit: 'relay.service' },
          registryAgent: { state: 'missing', running: false, unit: 'registry.service' },
          webrtc: { state: 'missing', running: false, unit: 'webrtc.service' }
        },
        issues: [{ code: 'management_key_missing' }]
      }
    }
  });

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.server.hostHomes, [{
    pid: 121002,
    hostHome: '/home/ubuntu/aih-fabric-current/.aih-host-home',
    ok: true
  }]);
  assert.equal(summary.serviceStatus.managementKeyConfigured, false);
  assert.deepEqual(summary.installDryRun.services, ['relay', 'registryAgent', 'webrtc']);
  assert.deepEqual(summary.remainingGate, [
    'management_key_missing',
    'relay_service_not_running',
    'registry_agent_service_not_running',
    'webrtc_service_not_running'
  ]);
});

test('summarizePreflight fails when AWS current lacks the 7.3 safety code', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    managementKeyState: {
      stdout: 'management_key_source=app-state.db present=yes\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    serverHostHome: { stdout: 'pid=121002 AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home\n' },
    remoteCode: { stdout: 'generate_management_key=no runbook=no\n' },
    residue: { stdout: '' },
    registryPayload: readyRegistryPayload(),
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }, { key: 'webrtc' }]
      }
    },
    statusPayload: {
      ok: false,
      status: {
        server: { managementKeyConfigured: false },
        supervisor: { ready: false },
        services: {
          relay: { state: 'missing', running: false, unit: 'relay.service' },
          registryAgent: { state: 'missing', running: false, unit: 'registry.service' },
          webrtc: { state: 'missing', running: false, unit: 'webrtc.service' }
        },
        issues: [{ code: 'management_key_missing' }]
      }
    }
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.verdict, 'preflight_failed');
  assert.deepEqual(summary.remoteCode, {
    ready: false,
    generateManagementKey: false,
    supervisedDaemonRunbook: false
  });
  assert.deepEqual(summary.remainingGate, [
    'remote_code_missing_generate_management_key',
    'remote_runbook_missing',
    'management_key_missing',
    'relay_service_not_running',
    'registry_agent_service_not_running',
    'webrtc_service_not_running'
  ]);
});

test('summarizePreflight fails when running server uses a different AIH_HOST_HOME', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    managementKeyState: {
      stdout: 'management_key_source=app-state.db present=yes\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    serverHostHome: { stdout: 'pid=121002 AIH_HOST_HOME=/home/ubuntu/.ai_home\n' },
    remoteCode: { stdout: 'generate_management_key=yes runbook=yes\n' },
    residue: { stdout: '' },
    registryPayload: readyRegistryPayload(),
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }, { key: 'webrtc' }]
      }
    },
    statusPayload: {
      ok: true,
      status: {
        server: { managementKeyConfigured: true },
        supervisor: { ready: true },
        services: {
          relay: { state: 'running', running: true, unit: 'relay.service' },
          registryAgent: { state: 'running', running: true, unit: 'registry.service' },
          webrtc: { state: 'running', running: true, unit: 'webrtc.service' }
        },
        issues: []
      }
    }
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.verdict, 'preflight_failed');
  assert.deepEqual(summary.server.hostHomes, [{
    pid: 121002,
    hostHome: '/home/ubuntu/.ai_home',
    ok: false
  }]);
  assert.deepEqual(summary.remainingGate, ['server_host_home_mismatch']);
});

test('summarizePreflight allows expected supervised processes after service install', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    managementKeyState: {
      stdout: 'management_key_source=app-state.db present=yes\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    serverHostHome: { stdout: 'pid=121002 AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home\n' },
    remoteCode: { stdout: 'generate_management_key=yes runbook=yes\n' },
    residue: {
      stdout: [
        '140408 node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node',
        '225639 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node',
        '225640 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node'
      ].join('\n')
    },
    registryPayload: readyRegistryPayload(),
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }, { key: 'webrtc' }]
      }
    },
    statusPayload: {
      ok: true,
      status: {
        server: { managementKeyConfigured: true },
        supervisor: { ready: true },
        services: {
          relay: { state: 'running', running: true, unit: 'relay.service' },
          registryAgent: { state: 'running', running: true, unit: 'registry.service' },
          webrtc: { state: 'running', running: true, unit: 'webrtc.service' }
        },
        issues: []
      }
    }
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.remainingGate, []);
  assert.equal(summary.supervisedProcesses.length, 3);
  assert.deepEqual(summary.duplicateSupervisedProcesses, []);
  assert.deepEqual(summary.residue, []);
});

test('summarizePreflight fails when a supervised connector has duplicate processes', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    managementKeyState: {
      stdout: 'management_key_source=app-state.db present=yes\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    serverHostHome: { stdout: 'pid=121002 AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home\n' },
    remoteCode: { stdout: 'generate_management_key=yes runbook=yes\n' },
    residue: {
      stdout: [
        '140408 node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node',
        '225639 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node',
        '225640 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node',
        '225641 node bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node'
      ].join('\n')
    },
    registryPayload: readyRegistryPayload(),
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }, { key: 'webrtc' }]
      }
    },
    statusPayload: {
      ok: true,
      status: {
        server: { managementKeyConfigured: true },
        supervisor: { ready: true },
        services: {
          relay: { state: 'running', running: true, unit: 'relay.service' },
          registryAgent: { state: 'running', running: true, unit: 'registry.service' },
          webrtc: { state: 'running', running: true, unit: 'webrtc.service' }
        },
        issues: []
      }
    }
  });

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.remainingGate, ['duplicate_supervised_processes']);
  assert.deepEqual(summary.duplicateSupervisedProcesses, [{
    key: 'webrtc',
    count: 2,
    processes: [
      '225640 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node',
      '225641 node bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node'
    ]
  }]);
});

test('summarizePreflight fails on unexpected residue processes', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    managementKeyState: {
      stdout: 'management_key_source=app-state.db present=yes\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    serverHostHome: { stdout: 'pid=121002 AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home\n' },
    remoteCode: { stdout: 'generate_management_key=yes runbook=yes\n' },
    residue: { stdout: '225777 node scripts/fabric-real-broker-smoke.js\n' },
    registryPayload: readyRegistryPayload(),
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }, { key: 'webrtc' }]
      }
    },
    statusPayload: {
      ok: true,
      status: {
        server: { managementKeyConfigured: true },
        supervisor: { ready: true },
        services: {
          relay: { state: 'running', running: true, unit: 'relay.service' },
          registryAgent: { state: 'running', running: true, unit: 'registry.service' },
          webrtc: { state: 'running', running: true, unit: 'webrtc.service' }
        },
        issues: []
      }
    }
  });

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.residue, ['225777 node scripts/fabric-real-broker-smoke.js']);
  assert.deepEqual(summary.remainingGate, ['unexpected_residue_processes']);
});

test('summarizePreflight fails when registry readback misses the target node', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    managementKeyState: {
      stdout: 'management_key_source=app-state.db present=yes\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    serverHostHome: { stdout: 'pid=121002 AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home\n' },
    remoteCode: { stdout: 'generate_management_key=yes runbook=yes\n' },
    residue: { stdout: '' },
    registryPayload: {
      ok: true,
      http: 200,
      counts: {
        nodes: 0,
        relayNodes: 0,
        projects: 0,
        runtimes: 0,
        transports: 0,
        nodeInventory: 0
      },
      targetNode: null
    },
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }, { key: 'webrtc' }]
      }
    },
    statusPayload: {
      ok: true,
      status: {
        server: { managementKeyConfigured: true },
        supervisor: { ready: true },
        services: {
          relay: { state: 'running', running: true, unit: 'relay.service' },
          registryAgent: { state: 'running', running: true, unit: 'registry.service' },
          webrtc: { state: 'running', running: true, unit: 'webrtc.service' }
        },
        issues: []
      }
    }
  });

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.remainingGate, ['registry_target_node_missing']);
  assert.equal(summary.registry.counts.nodes, 0);
});
