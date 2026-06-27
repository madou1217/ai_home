'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstallDryRunCommand,
  getTokenFile,
  parseArgs,
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

test('summarizePreflight reports remaining 7.3 gate from real status surfaces', () => {
  const parsed = parseArgs([]);
  const summary = summarizePreflight(parsed, {
    tokenStat: {
      stdout: 'token_path=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token mode=600 bytes=44\n'
    },
    readyz: { stdout: '200' },
    serverProcesses: { stdout: '121002 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527\n' },
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
