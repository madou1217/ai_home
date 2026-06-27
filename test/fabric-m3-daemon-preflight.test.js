'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstallDryRunCommand,
  buildRemoteCodeReadinessCommand,
  getTokenFile,
  parseArgs,
  parseRemoteCodeReadiness,
  parseTokenStat,
  summarizePreflight
} = require('../scripts/fabric-m3-daemon-preflight');

test('parseArgs defaults to AWS current target and default port', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(parsed.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(parsed.nodeId, 'aws-current-node');
  assert.equal(parsed.port, 9527);
  assert.equal(getTokenFile(parsed), '/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token');
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
  assert.match(command, /--token-file '\/home\/ubuntu\/aih-fabric-current\/\.aih-host-home\/\.ai_home\/fabric\/aws-current-node\.token'/);
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

test('parseTokenStat extracts mode and size without reading token contents', () => {
  assert.deepEqual(
    parseTokenStat('token_path=/path/node.token mode=600 bytes=44\n'),
    {
      ok: true,
      path: '/path/node.token',
      mode: '600',
      bytes: 44
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
    tokenStat: {
      stdout: 'token_path=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token mode=600 bytes=44\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    remoteCode: { stdout: 'generate_management_key=yes runbook=yes\n' },
    residue: { stdout: '' },
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }]
      }
    },
    statusPayload: {
      ok: false,
      status: {
        server: { managementKeyConfigured: false },
        supervisor: { ready: false },
        services: {
          relay: { state: 'missing', running: false, unit: 'relay.service' },
          registryAgent: { state: 'missing', running: false, unit: 'registry.service' }
        },
        issues: [{ code: 'management_key_missing' }]
      }
    }
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.serviceStatus.managementKeyConfigured, false);
  assert.deepEqual(summary.installDryRun.services, ['relay', 'registryAgent']);
  assert.deepEqual(summary.remainingGate, [
    'management_key_missing',
    'relay_service_not_running',
    'registry_agent_service_not_running'
  ]);
});

test('summarizePreflight fails when AWS current lacks the 7.3 safety code', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    tokenStat: {
      stdout: 'token_path=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token mode=600 bytes=44\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
    remoteCode: { stdout: 'generate_management_key=no runbook=no\n' },
    residue: { stdout: '' },
    dryRunPayload: {
      ok: true,
      plan: {
        writes: false,
        services: [{ key: 'relay' }, { key: 'registryAgent' }]
      }
    },
    statusPayload: {
      ok: false,
      status: {
        server: { managementKeyConfigured: false },
        supervisor: { ready: false },
        services: {
          relay: { state: 'missing', running: false, unit: 'relay.service' },
          registryAgent: { state: 'missing', running: false, unit: 'registry.service' }
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
    'registry_agent_service_not_running'
  ]);
});
