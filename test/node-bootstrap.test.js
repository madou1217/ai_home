const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNodeBootstrapPlan,
  formatNodeJoinCommand,
  parseNodeBootstrapArgs,
  runNodeBootstrap
} = require('../lib/cli/services/node/bootstrap');
const { runNodeCommandRouter } = require('../lib/cli/commands/node-router');

test('parseNodeBootstrapArgs normalizes target, urls, node id, and relay defaults', () => {
  assert.deepEqual(parseNodeBootstrapArgs([
    '--target',
    'win32',
    '--control-url',
    'https://control.example.com/',
    '--invite-url',
    'https://control.example.com/invite/abc',
    '--node-id',
    'Office_PC',
    '--repo-url',
    'git@github.com:madou1217/ai_home.git',
    '--json'
  ]), {
    target: 'win32',
    channel: 'local-manual',
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/invite/abc',
    endpoint: '',
    nodeId: 'office_pc',
    repoUrl: 'git@github.com:madou1217/ai_home.git',
    repoDir: '',
    repoSubdir: '',
    transportKind: 'relay',
    installService: true,
    scriptOnly: false,
    json: true
  });
});

test('buildNodeBootstrapPlan expands repo subdir per target platform', () => {
  const linux = buildNodeBootstrapPlan({
    target: 'linux',
    repoUrl: 'https://example.com/ai_home.git',
    repoSubdir: 'projects/feature/ai_home'
  });
  const windows = buildNodeBootstrapPlan({
    target: 'win32',
    repoUrl: 'https://example.com/ai_home.git',
    repoSubdir: 'projects/feature/ai_home'
  });

  assert.match(linux.script.content, /AIH_REPO_DIR=\$\{AIH_REPO_DIR:-"\$HOME\/projects\/feature\/ai_home"\}/);
  assert.match(windows.script.content, /\$AihRepoDir = if \(\$env:AIH_REPO_DIR\) \{ \$env:AIH_REPO_DIR \} else \{ Join-Path \$env:USERPROFILE 'projects\\feature\\ai_home' \}/);
});

test('buildNodeBootstrapPlan emits macOS user-local Node fallback', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'darwin',
    repoUrl: 'https://example.com/ai_home.git'
  });

  assert.equal(
    plan.prerequisites.some((item) => item.includes('curl-based user-local Node.js')),
    true
  );
  assert.match(plan.script.content, /install_aih_user_node_lts\(\)/);
  assert.match(plan.script.content, /NVM_DIR="\$\{NVM_DIR:-\$HOME\/\.nvm\}"/);
  assert.match(plan.script.content, /nvm install --lts/);
  assert.match(plan.script.content, /brew install node/);
  assert.match(plan.script.content, /Install Git or Apple Command Line Tools/);
});

test('buildNodeBootstrapPlan emits Linux relay bootstrap without secrets', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'linux',
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
    nodeId: 'linux-node',
    repoUrl: 'git@github.com:madou1217/ai_home.git'
  });
  const serialized = JSON.stringify(plan);

  assert.equal(plan.target, 'linux');
  assert.equal(plan.channel, 'ssh');
  assert.equal(plan.transportKind, 'relay');
  assert.equal(plan.security.containsSecrets, false);
  assert.deepEqual(plan.requiredInputs, []);
  assert.deepEqual(plan.readinessChecks.map((check) => check.id), [
    'target-node-identity',
    'target-management-key',
    'control-endpoint',
    'persistent-relay-service'
  ]);
  assert.equal(plan.readinessChecks.find((check) => check.id === 'target-management-key').status, 'checked-by-script');
  assert.equal(plan.transportGuidance.some((item) => item.includes('Lowest-configuration default')), true);
  assert.equal(plan.transportGuidance.some((item) => item.includes('AIH Relay is the managed data-plane')), true);
  assert.equal(plan.prerequisites.some((item) => item.includes('configured management key')), true);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.match(plan.script.content, /crypto\.randomBytes\(32\)/);
  assert.match(plan.script.content, /const bootstrapOpenNetwork = false;/);
  assert.match(plan.script.content, /aih server start/);
  assert.match(plan.script.content, /AIH_DOCTOR_JSON="\$\('aih' 'node' 'doctor' '--json' '--control-url' 'https:\/\/control\.example\.com' '--node-id' 'linux-node'\)"/);
  assert.match(plan.script.content, /AIH node preflight failed/);
  assert.match(plan.script.content, /'aih' 'node' 'doctor' '--control-url' 'https:\/\/control\.example\.com' '--node-id' 'linux-node'/);
  assert.match(plan.script.content, /sudo apt-get install -y nodejs npm git/);
  assert.match(plan.script.content, /sudo dnf install -y nodejs npm git/);
  assert.match(plan.script.content, /'aih' 'node' 'join' 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=abc' '--transport' 'relay' '--node-id' 'linux-node'/);
  assert.match(plan.script.content, /'aih' 'node' 'relay' 'service' 'install' 'https:\/\/control\.example\.com' '--node-id' 'linux-node'/);
});

test('buildNodeBootstrapPlan warns when control url is loopback for remote targets', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'linux',
    controlUrl: 'http://127.0.0.1:9527',
    inviteUrl: 'http://127.0.0.1:9527/v0/node-rpc/join?code=abc',
    nodeId: 'linux-node',
    repoUrl: 'https://example.com/ai_home.git'
  });

  assert.equal(plan.warnings.some((warning) => warning.includes('control-url points to loopback')), true);
  assert.equal(plan.warnings.some((warning) => warning.includes('remote targets will treat it as themselves')), true);
});

test('formatNodeJoinCommand preserves invite transport in standalone command', () => {
  assert.equal(
    formatNodeJoinCommand({
      target: 'linux',
      inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
      transportKind: 'relay'
    }),
    "'aih' 'node' 'join' 'https://control.example.com/v0/node-rpc/join?code=abc' '--transport' 'relay'"
  );

  assert.equal(
    formatNodeJoinCommand({
      target: 'win32',
      inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
      transportKind: 'frp',
      endpoint: 'https://frp.example.com/node-a',
      nodeId: 'Win_Node'
    }),
    "& 'aih' 'node' 'join' 'https://control.example.com/v0/node-rpc/join?code=abc' '--transport' 'frp' '--endpoint' 'https://frp.example.com/node-a' '--node-id' 'win_node'"
  );
});

test('buildNodeBootstrapPlan emits Windows local-manual PowerShell script', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'win32',
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/invite/abc',
    nodeId: 'win-node',
    repoUrl: 'git@github.com:madou1217/ai_home.git'
  });

  assert.equal(plan.channel, 'local-manual');
  assert.equal(plan.script.type, 'powershell');
  assert.equal(plan.warnings.some((warning) => warning.includes('local console access')), true);
  assert.match(plan.script.content, /winget install --id OpenJS\.NodeJS\.LTS/);
  assert.match(plan.script.content, /winget install --id Git\.Git/);
  assert.match(plan.script.content, /Join-Path \$env:USERPROFILE 'ai_home'/);
  assert.match(plan.script.content, /\$env:PATH = \[Environment\]::GetEnvironmentVariable/);
  assert.match(plan.script.content, /& 'aih' 'node' 'doctor' '--control-url' 'https:\/\/control\.example\.com' '--node-id' 'win-node'/);
  assert.match(plan.script.content, /\$AihPreflight = & 'aih' 'node' 'doctor' '--json' '--control-url' 'https:\/\/control\.example\.com' '--node-id' 'win-node' \| ConvertFrom-Json/);
  assert.match(plan.script.content, /AIH node preflight failed/);
  assert.match(plan.script.content, /& 'aih' 'node' 'join' 'https:\/\/control\.example\.com\/invite\/abc' '--transport' 'relay' '--node-id' 'win-node'/);
});

test('buildNodeBootstrapPlan derives target node id inside generated script', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'linux',
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/invite/abc',
    repoUrl: 'https://example.com/ai_home.git'
  });

  assert.equal(plan.requiredInputs.includes('node-id'), false);
  assert.equal(plan.readinessChecks.find((check) => check.id === 'target-node-identity').status, 'target-derived');
  assert.match(plan.steps.find((step) => step.id === 'join-node').command, /<target-derived-node-id>/);
  assert.match(plan.script.content, /AIH_NODE_ID=\$\{AIH_NODE_ID:-''\}/);
  assert.match(plan.script.content, /aih node doctor --json/);
  assert.match(plan.script.content, /'aih' 'node' 'join' 'https:\/\/control\.example\.com\/invite\/abc' '--transport' 'relay' '--node-id' "\$AIH_NODE_ID"/);
  assert.match(plan.script.content, /'aih' 'node' 'relay' 'service' 'install' 'https:\/\/control\.example\.com' '--node-id' "\$AIH_NODE_ID"/);
});

test('buildNodeBootstrapPlan requires endpoint for FRP bootstrap and includes it in join command', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'linux',
    transportKind: 'frp',
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/invite/abc',
    nodeId: 'frp-node',
    repoUrl: 'https://example.com/ai_home.git'
  });

  assert.equal(plan.requiredInputs.includes('endpoint'), true);
  assert.equal(plan.warnings.some((warning) => warning.includes('frp transport needs --endpoint')), true);
  assert.equal(plan.transportGuidance.some((item) => item.includes('FRP')), true);
  assert.equal(plan.steps.some((step) => step.title === 'Install optional outbound relay fallback'), true);

  const withEndpoint = buildNodeBootstrapPlan({
    target: 'linux',
    transportKind: 'frp',
    endpoint: 'https://frp.example.com/node-a',
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/invite/abc',
    nodeId: 'frp-node',
    repoUrl: 'https://example.com/ai_home.git'
  });

  assert.equal(withEndpoint.requiredInputs.includes('endpoint'), false);
  assert.match(withEndpoint.script.content, /'--endpoint' 'https:\/\/frp\.example\.com\/node-a'/);
  assert.match(withEndpoint.script.content, /const bootstrapOpenNetwork = true;/);
  assert.match(withEndpoint.script.content, /next\.host = '0\.0\.0\.0'/);
});

test('buildNodeBootstrapPlan opens remote server for direct HTTP endpoint bootstrap', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'linux',
    transportKind: 'direct',
    endpoint: 'http://192.168.3.8:9527',
    controlUrl: 'http://192.168.3.181:9527',
    inviteUrl: 'http://192.168.3.181:9527/v0/node-rpc/join?code=abc',
    nodeId: 'lan-node',
    repoUrl: 'https://example.com/ai_home.git'
  });

  assert.equal(plan.requiredInputs.includes('endpoint'), false);
  assert.match(plan.script.content, /const bootstrapOpenNetwork = true;/);
  assert.match(plan.script.content, /next\.host = '0\.0\.0\.0'/);
  assert.match(plan.script.content, /next\.openNetwork = true/);
  assert.match(plan.script.content, /"192\.168\.3\.181"/);
  assert.match(plan.script.content, /"192\.168\.3\.8"/);
  assert.match(plan.script.content, /'--endpoint' 'http:\/\/192\.168\.3\.8:9527'/);
});

test('buildNodeBootstrapPlan documents external underlay transports without managing them', () => {
  const plan = buildNodeBootstrapPlan({
    target: 'linux',
    transportKind: 'omr',
    endpoint: 'https://omr.example.com/node-a'
  });

  assert.equal(plan.transportGuidance.some((item) => item.includes('OpenMPTCPRouter')), true);
  assert.equal(plan.warnings.some((warning) => warning.includes('does not install FRP/VPN/OMR/MPTCP/SSH tooling')), true);
});

test('runNodeBootstrap reports placeholders when required inputs are missing', () => {
  const result = runNodeBootstrap(['--target', 'darwin', '--no-service'], {
    processObj: { platform: 'linux' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.target, 'darwin');
  assert.equal(result.plan.requiredInputs.includes('control-url'), true);
  assert.equal(result.plan.requiredInputs.includes('invite-url'), true);
  assert.equal(result.plan.requiredInputs.includes('repo-url'), true);
  assert.equal(result.plan.steps.some((step) => step.id === 'install-relay-service'), false);
  assert.match(result.plan.script.content, /Install Homebrew or curl first/);
});

test('runNodeBootstrap supports script-only output mode', () => {
  const result = runNodeBootstrap(['--target', 'linux', '--script-only'], {
    processObj: { platform: 'darwin' }
  });

  assert.equal(result.scriptOnly, true);
  assert.equal(result.plan.script.type, 'sh');
});

test('parseNodeBootstrapArgs rejects unsupported target', () => {
  assert.throws(
    () => parseNodeBootstrapArgs(['--target', 'freebsd']),
    { code: 'unsupported_bootstrap_target' }
  );
});

test('runNodeCommandRouter prints bootstrap plan through node command', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'bootstrap',
    '--target',
    'win32',
    '--control-url',
    'https://control.example.com',
    '--repo-url',
    'git@github.com:madou1217/ai_home.git'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code),
      platform: 'darwin'
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  const output = writes.join('\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.match(output, /\[aih\] node bootstrap plan/);
  assert.match(output, /target: win32/);
  assert.match(output, /Open local Windows console/);
  assert.match(output, /secrets in script: no/);
});

test('runNodeCommandRouter prints raw bootstrap script with --script-only', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'bootstrap',
    '--target',
    'linux',
    '--script-only',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/invite/abc',
    '--repo-url',
    'https://example.com/ai_home.git'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code),
      platform: 'darwin'
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  const output = writes.join('');
  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.match(output, /^#!\/usr\/bin\/env sh/);
  assert.doesNotMatch(output, /\[aih\] node bootstrap plan/);
  assert.match(output, /AIH_NODE_ID/);
});
