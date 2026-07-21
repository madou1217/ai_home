'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServerAutostartService } = require('../lib/cli/services/server/autostart');
const {
  readBackgroundSupervisorState,
  writeBackgroundSupervisorState
} = require('../lib/cli/services/background/supervisor-state-store');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-legacy-macos-migration-'));
}

function launchctlQueryResult(args, isLoaded) {
  const operation = String(args[0] || '');
  if (operation !== 'print' && operation !== 'list') return null;
  const target = String(args[1] || '');
  const label = operation === 'print' ? target.split('/').pop() : target;
  return isLoaded(label)
    ? { status: 0, stdout: '', stderr: '' }
    : { status: 1, stdout: '', stderr: `service not found: ${label}` };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function writeLegacyPlist(file, label, programArguments, logFile) {
  const argumentsXml = programArguments
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>StandardOutPath</key>
    <string>${escapeXml(logFile)}</string>
  </dict>
</plist>
`, 'utf8');
}

function createAutostart(root, spawnSync) {
  const aiHomeDir = path.join(root, '.ai_home');
  const launchdPlist = path.join(
    root,
    'Library',
    'LaunchAgents',
    'com.clawdcodex.ai_home.plist'
  );
  const processObj = {
    env: {
      AIH_CLI_PATH: '/opt/homebrew/bin/aih',
      HOME: root,
      PATH: '/opt/homebrew/bin:/usr/bin'
    },
    platform: 'darwin',
    cwd: () => root,
    getuid: () => 501
  };
  return {
    aiHomeDir,
    launchdPlist,
    service: createServerAutostartService({
      fs,
      path,
      spawnSync,
      processObj,
      ensureDir(directory) {
        fs.mkdirSync(directory, { recursive: true });
      },
      aiHomeDir,
      hostHomeDir: root,
      launchdLabel: 'com.clawdcodex.ai_home',
      launchdPlist,
      logFile: path.join(aiHomeDir, 'server.log'),
      resolveStartEntryFilePath: () => ({ entryFilePath: '/repo/lib/cli/app.js' }),
      resolveStartServeArgs: () => []
    })
  };
}

test('server autostart migrates legacy relay, registry, and WebRTC workers after supervisor bootstrap', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launchAgentsDir = path.join(root, 'Library', 'LaunchAgents');
  const legacy = [
    {
      label: 'com.clawdcodex.ai_home.node-relay.nat-node',
      args: [
        '/opt/homebrew/bin/aih',
        'node',
        'relay',
        'connect',
        'https://control.example.com/relay?a=1&b=2',
        '--node-id',
        'nat_node',
        '--heartbeat-ms',
        '2000'
      ],
      componentId: 'node-relay:nat_node'
    },
    {
      label: 'com.clawdcodex.ai_home.fabric-registry-agent.office-node',
      args: [
        '/opt/homebrew/bin/aih',
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'office-node',
        '--status',
        'online',
        '--transport',
        'relay=online,remote-request-ready=true,mode=management-rpc,evidence-ref=https://probe.example.com/path?region=ap-northeast-1,Authorization: Bearer legacy-header-secret',
        '--runtime-diagnostics',
        '--interval-ms',
        '2000'
      ],
      expectedArgs: [
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'office-node',
        '--status',
        'online',
        '--transport',
        'relay=online,remote-request-ready=true,mode=management-rpc,evidence-ref=https://probe.example.com/path?region=ap-northeast-1',
        '--runtime-diagnostics',
        '--interval-ms',
        '2000'
      ],
      componentId: 'fabric-registry-agent:office-node'
    },
    {
      label: 'com.clawdcodex.ai_home.node-webrtc.nat-node',
      args: [
        '/opt/homebrew/bin/aih',
        'node',
        'webrtc',
        'connect',
        'https://control.example.com',
        '--node-id',
        'nat-node',
        '--connect-timeout-ms',
        '15000'
      ],
      componentId: 'node-webrtc:nat-node'
    }
  ].map((item, index) => {
    const file = path.join(launchAgentsDir, `${item.label}.plist`);
    const oldLogFile = path.join(root, 'legacy-logs', `worker-${index}.log`);
    writeLegacyPlist(file, item.label, item.args, oldLogFile);
    return { ...item, file, oldLogFile };
  });
  const loadedLabels = new Set(legacy.map((item) => item.label));
  const calls = [];
  const { aiHomeDir, service } = createAutostart(root, (command, args) => {
    calls.push({ command, args: args.slice() });
    if (command === 'launchctl') {
      const queryResult = launchctlQueryResult(args, (label) => loadedLabels.has(label));
      if (queryResult) return queryResult;
      if (args[0] === 'bootout') {
        loadedLabels.delete(String(args[1] || '').split('/').pop());
      }
      if (args[0] === 'unload') {
        loadedLabels.delete(path.basename(String(args[1] || ''), '.plist'));
      }
      if (args[0] === 'bootstrap' || args[0] === 'load') {
        const plistFile = args[0] === 'bootstrap' ? args[2] : args[1];
        loadedLabels.add(path.basename(String(plistFile || ''), '.plist'));
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  service.install();

  const state = readBackgroundSupervisorState({ fs, path, aiHomeDir });
  assert.deepEqual(Object.keys(state.components).sort(), [
    'fabric-registry-agent:office-node',
    'node-relay:nat_node',
    'node-webrtc:nat-node',
    'server'
  ]);
  for (const item of legacy) {
    assert.deepEqual(state.components[item.componentId].args, item.expectedArgs || item.args.slice(1));
    assert.equal(Object.hasOwn(state.components[item.componentId], 'logFile'), false);
    assert.equal(fs.existsSync(item.file), false);
  }
  const serializedState = JSON.stringify(state);
  assert.equal(serializedState.includes('management-key'), false);
  assert.equal(serializedState.includes('legacy-header-secret'), false);
  assert.equal(legacy.some((item) => serializedState.includes(item.oldLogFile)), false);

  const bootstrapIndex = calls.findIndex((call) => (
    call.command === 'launchctl'
      && call.args[0] === 'bootstrap'
      && call.args[2].endsWith('com.clawdcodex.ai_home.plist')
  ));
  assert.notEqual(bootstrapIndex, -1);
  for (const item of legacy) {
    const cleanupIndex = calls.findIndex((call) => (
      call.command === 'launchctl'
        && call.args[0] === 'bootout'
        && call.args[1] === `gui/501/${item.label}`
    ));
    assert.ok(cleanupIndex > bootstrapIndex);
  }
});

test('server autostart rejects secret-bearing legacy worker arguments without persisting them', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const label = 'com.clawdcodex.ai_home.node-relay.nat-node';
  const legacyFile = path.join(root, 'Library', 'LaunchAgents', `${label}.plist`);
  writeLegacyPlist(legacyFile, label, [
    '/opt/homebrew/bin/aih',
    'node',
    'relay',
    'connect',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--management-key',
    'management-secret'
  ], path.join(root, 'legacy.log'));
  const calls = [];
  const { aiHomeDir, service } = createAutostart(root, (command, args) => {
    calls.push({ command, args: args.slice() });
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.throws(
    () => service.install(),
    (error) => {
      assert.equal(error.code, 'legacy_macos_service_secret_args');
      assert.equal(String(error.message).includes('management-secret'), false);
      return true;
    }
  );
  assert.deepEqual(readBackgroundSupervisorState({ fs, path, aiHomeDir }).components, {});
  assert.equal(fs.existsSync(legacyFile), true);
  assert.equal(calls.some((call) => call.command === 'launchctl' && call.args[0] === 'bootstrap'), false);
});

test('server autostart rejects secrets embedded in legacy composite transport targets', (t) => {
  const transportArguments = [
    {
      args: [
        '--probe-transport',
        'relay=https://relay.example.com/path?token=split-secret'
      ],
      secret: 'split-secret'
    },
    {
      args: [
        '--probe-transport=relay=https://relay.example.com/path?api_key=inline-secret'
      ],
      secret: 'inline-secret'
    },
    {
      args: [
        '--transport',
        'relay=degraded,https://probe.example.com/path?token=last-error-secret'
      ],
      secret: 'last-error-secret'
    },
    {
      args: [
        '--transport',
        'relay=online,evidence-ref=https://safe.example/path?region=x,token=promotion-tail-secret'
      ],
      secret: 'promotion-tail-secret'
    },
    {
      args: [
        '--transport',
        'relay=degraded;token=semicolon-tail-secret'
      ],
      secret: 'semicolon-tail-secret'
    }
  ];

  for (const { args: transportArgs, secret } of transportArguments) {
    const root = makeTempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const label = 'com.clawdcodex.ai_home.fabric-registry-agent.office-node';
    const legacyFile = path.join(root, 'Library', 'LaunchAgents', `${label}.plist`);
    writeLegacyPlist(legacyFile, label, [
      '/opt/homebrew/bin/aih',
      'fabric',
      'registry',
      'agent',
      'https://control.example.com',
      '--node-id',
      'office-node',
      ...transportArgs
    ], path.join(root, 'legacy.log'));
    const calls = [];
    const { aiHomeDir, service } = createAutostart(root, (command, args) => {
      calls.push({ command, args: args.slice() });
      return { status: 0, stdout: '', stderr: '' };
    });

    assert.throws(
      () => service.install(),
      (error) => {
        assert.equal(error.code, 'legacy_macos_service_secret_args');
        assert.equal(String(error.message).includes(secret), false);
        return true;
      }
    );
    assert.deepEqual(readBackgroundSupervisorState({ fs, path, aiHomeDir }).components, {});
    assert.equal(fs.existsSync(legacyFile), true);
    assert.equal(calls.some((call) => call.command === 'launchctl' && call.args[0] === 'bootstrap'), false);
  }
});

test('server autostart restores desired state and preserves legacy workers when supervisor bootstrap fails', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const label = 'com.clawdcodex.ai_home.node-webrtc.nat-node';
  const legacyFile = path.join(root, 'Library', 'LaunchAgents', `${label}.plist`);
  writeLegacyPlist(legacyFile, label, [
    '/opt/homebrew/bin/aih',
    'node',
    'webrtc',
    'connect',
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ], path.join(root, 'old-webrtc.log'));
  const parsedLegacyContent = fs.readFileSync(legacyFile, 'utf8');

  const calls = [];
  const expectedAiHomeDir = path.join(root, '.ai_home');
  let stateAtBootstrap = null;
  let stateAtRollbackBootstrap = null;
  const loadedLabels = new Set(['com.clawdcodex.ai_home', label]);
  const { aiHomeDir, launchdPlist, service } = createAutostart(root, (command, args) => {
    calls.push({ command, args: args.slice() });
    if (command === 'launchctl') {
      const queryResult = launchctlQueryResult(args, (serviceLabel) => loadedLabels.has(serviceLabel));
      if (queryResult) return queryResult;
      if (args[0] === 'bootout') {
        loadedLabels.delete(String(args[1] || '').split('/').pop());
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'unload') {
        loadedLabels.delete(path.basename(String(args[1] || ''), '.plist'));
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    if (command === 'launchctl' && (args[0] === 'bootstrap' || args[0] === 'load')) {
      const plistFile = args[0] === 'bootstrap' ? args[2] : args[1];
      const plist = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, 'utf8') : '';
      if (plist === 'previous-supervisor-plist') {
        if (args[0] === 'bootstrap') {
          stateAtRollbackBootstrap = readBackgroundSupervisorState({ fs, path, aiHomeDir: expectedAiHomeDir });
        }
        loadedLabels.add('com.clawdcodex.ai_home');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap' && !stateAtBootstrap) {
        stateAtBootstrap = readBackgroundSupervisorState({ fs, path, aiHomeDir: expectedAiHomeDir });
      }
      return { status: 1, stdout: '', stderr: 'bootstrap failed' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const previousState = writeBackgroundSupervisorState({
    schemaVersion: 1,
    components: {
      'node-relay:existing': {
        id: 'node-relay:existing',
        args: [
          'node',
          'relay',
          'connect',
          'https://existing.example.com',
          '--node-id',
          'existing'
        ],
        logFile: ''
      }
    }
  }, { fs, path, aiHomeDir });
  fs.mkdirSync(path.dirname(launchdPlist), { recursive: true });
  fs.writeFileSync(launchdPlist, 'previous-supervisor-plist', 'utf8');

  assert.throws(
    () => service.install(),
    { code: 'background_supervisor_bootstrap_failed' }
  );

  assert.ok(stateAtBootstrap.components['node-webrtc:nat-node']);
  assert.deepEqual(stateAtRollbackBootstrap, previousState);
  assert.deepEqual(readBackgroundSupervisorState({ fs, path, aiHomeDir }), previousState);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), parsedLegacyContent);
  assert.equal(fs.readFileSync(launchdPlist, 'utf8'), 'previous-supervisor-plist');
  assert.equal(calls.some((call) => (
    call.command === 'launchctl'
      && call.args[0] === 'bootout'
      && call.args[1] === `gui/501/${label}`
  )), false);
  assert.equal(calls.some((call) => (
    call.command === 'launchctl'
      && call.args[0] === 'unload'
      && call.args[1] === legacyFile
  )), false);
});
