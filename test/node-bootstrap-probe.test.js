const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  buildNodeBootstrapProbeCommand,
  buildRemoteProbeCommand,
  formatNodeBootstrapProbeReport,
  parseNodeBootstrapProbeArgs,
  parseSshTarget,
  probeSshTarget,
  runNodeBootstrapProbe
} = require('../lib/cli/services/node/bootstrap-probe');
const {
  buildNodeBootstrapApplyCommand,
  buildNodeBootstrapApplyPreview,
  createStructuredRunner,
  formatNodeBootstrapApplyReport,
  parseNodeBootstrapApplyArgs,
  runNodeBootstrapApply
} = require('../lib/cli/services/node/bootstrap-apply');
const {
  buildLocalAssetInstallScript,
  buildNodeDistFileName,
  runSshLocalAssetBootstrap
} = require('../lib/cli/services/node/bootstrap-assets');
const { runNodeCommandRouter } = require('../lib/cli/commands/node-router');

test('buildNodeBootstrapProbeCommand renders parallel ssh tcp bootstrap template', () => {
  const command = buildNodeBootstrapProbeCommand({
    sshTargets: ['user@linux-host', 'user@mac-host'],
    tcpTargets: ['windows-host'],
    httpTargets: ['https://control.example.com/healthz'],
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
    repoUrl: 'https://example.com/ai_home.git',
    repoDir: '/opt/ai_home',
    repoSubdir: 'projects/feature/ai_home',
    transportKind: 'frp',
    endpoint: 'https://frp.example.com/node-a'
  });

  assert.match(command, /^aih node bootstrap probe --ssh user@linux-host --ssh user@mac-host --tcp windows-host/);
  assert.match(command, /--http https:\/\/control\.example\.com\/healthz/);
  assert.match(command, /--ports 22,445,3389,5985,5986/);
  assert.match(command, /--control-url https:\/\/control\.example\.com/);
  assert.match(command, /--invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=abc'/);
  assert.match(command, /--repo-url https:\/\/example\.com\/ai_home\.git --repo-dir \/opt\/ai_home/);
  assert.match(command, /--repo-subdir projects\/feature\/ai_home/);
  assert.match(command, /--transport frp --endpoint https:\/\/frp\.example\.com\/node-a -j 3 --timeout-ms 3000$/);
});

test('probeSshTarget keeps key-file authentication in generated bootstrap commands', async () => {
  const identityFile = '/Users/model/.ssh/aws key.pem';
  const result = await probeSshTarget(parseSshTarget('ubuntu@ec2.example.com:2222'), {
    timeoutMs: 3000,
    repoDir: '',
    sshIdentityFile: identityFile
  }, {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Linux',
      arch: 'x86_64',
      commands: { node: true, npm: true, git: true, aih: false },
      repo: { present: true }
    })
  });

  assert.match(result.bootstrapAction.remoteRunCommand, /ssh -i '\/Users\/model\/\.ssh\/aws key\.pem' -o IdentitiesOnly=yes -p 2222 ubuntu@ec2\.example\.com 'sh -s'/);
  assert.deepEqual(result.bootstrapAction.remoteRunExecution.sshArgs, [
    '-i',
    identityFile,
    '-o',
    'IdentitiesOnly=yes',
    '-p',
    '2222',
    'ubuntu@ec2.example.com',
    'sh -s'
  ]);
  assert.match(result.recommendation, /-o IdentitiesOnly=yes/);
});

test('parseNodeBootstrapProbeArgs accepts ssh, tcp, and http targets with late port selection', () => {
  const options = parseNodeBootstrapProbeArgs([
    '--ssh',
    'model@192.168.3.8',
    '--tcp',
    '192.168.3.76',
    '--http',
    '155.248.183.169:18381',
    '--ports',
    '22,445,3389',
    '-j',
    '2',
    '--timeout-ms',
    '3000',
    '--repo-dir',
    '/home/model/projects/feature/ai_home',
    '--repo-url',
    'https://example.com/ai_home.git',
    '--repo-subdir',
    'projects/feature/ai_home',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--transport',
    'frp',
    '--endpoint',
    'https://frp.example.com/node-a',
    '--target',
    'win32',
    '--json'
  ]);

  assert.equal(options.json, true);
  assert.equal(options.concurrency, 2);
  assert.equal(options.timeoutMs, 3000);
  assert.equal(options.repoDir, '/home/model/projects/feature/ai_home');
  assert.equal(options.repoUrl, 'https://example.com/ai_home.git');
  assert.equal(options.repoSubdir, 'projects/feature/ai_home');
  assert.equal(options.controlUrl, 'https://control.example.com');
  assert.equal(options.inviteUrl, 'https://control.example.com/v0/node-rpc/join?code=abc');
  assert.equal(options.transportKind, 'frp');
  assert.equal(options.endpoint, 'https://frp.example.com/node-a');
  assert.equal(options.bootstrapTarget, 'win32');
  assert.equal(options.sshTargets[0].user, 'model');
  assert.equal(options.sshTargets[0].host, '192.168.3.8');
  assert.deepEqual(options.tcpTargets[0].ports, [22, 445, 3389]);
  assert.equal(options.httpTargets[0].url, 'http://155.248.183.169:18381/healthz');
});

test('buildRemoteProbeCommand uses only normalized repo subdir defaults', () => {
  const valid = buildRemoteProbeCommand('', 'projects/feature/ai_home');
  const invalid = buildRemoteProbeCommand('', '/tmp/ai_home');

  assert.match(valid, /AIH_PROBE_REPO="\$HOME\/projects\/feature\/ai_home"/);
  assert.match(invalid, /AIH_PROBE_REPO=;/);
  assert.doesNotMatch(invalid, /\$HOME\/ai_home/);
});

test('runNodeBootstrapProbe probes ssh and tcp targets without mutating remotes', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await runNodeBootstrapProbe([
    '--ssh',
    'model@linux.local',
    '--tcp',
    'win.local',
    '--ports',
    '22,445,3389,5985',
    '--repo-dir',
    '/repo',
    '--repo-url',
    'https://example.com/ai_home.git',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '-j',
    '2'
  ], {
    sshProbe: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        status: 'reachable',
        platform: 'Linux',
        arch: 'x86_64',
        commands: { node: false, npm: false, git: true, aih: false },
        repo: { present: false }
      };
    },
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({
        port,
        open: port === 445 || port === 3389,
        error: port === 445 || port === 3389 ? '' : 'timeout'
      }))
    })
  });

  assert.equal(result.ok, true);
  assert.equal(maxActive <= 2, true);
  assert.equal(result.report.summary.total, 2);
  assert.equal(result.report.summary.reachableSsh, 1);
  assert.equal(result.report.summary.localManual, 1);
  assert.deepEqual(result.report.executionPlan.map((step) => ({
    order: step.order,
    status: step.status,
    channel: step.channel,
    target: step.target
  })), [
    { order: 1, status: 'ready', channel: 'ssh', target: 'model@linux.local' },
    { order: 2, status: 'manual', channel: 'local-manual', target: 'win.local' }
  ]);
  assert.match(result.report.executionPlan[0].command, /ssh model@linux\.local 'sh -s'/);
  assert.equal(result.report.executionPlan[0].execution.kind, 'ssh-pipe');
  assert.doesNotMatch(JSON.stringify(result.report), /remoteRunExecution/);
  assert.doesNotMatch(JSON.stringify(result.report), /"execution":/);
  assert.match(result.report.executionPlan[1].command, /aih node bootstrap --target win32 --script-only/);
  assert.match(result.report.results[0].bootstrapCommand, /aih node bootstrap --target linux --script-only --control-url https:\/\/control\.example\.com/);
  assert.match(result.report.results[0].bootstrapCommand, /--invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=abc'/);
  assert.match(result.report.results[0].bootstrapCommand, /--repo-url https:\/\/example\.com\/ai_home\.git --repo-dir \/repo --transport relay/);
  assert.equal(result.report.results[0].bootstrapAction.channel, 'ssh');
  assert.match(result.report.results[0].bootstrapAction.remoteRunCommand, /aih node bootstrap --target linux --script-only/);
  assert.match(result.report.results[0].bootstrapAction.remoteRunCommand, /\| ssh model@linux\.local 'sh -s'/);
  assert.match(result.report.results[0].recommendation, /Run bootstrap over SSH: aih node bootstrap --target linux --script-only/);
  assert.equal(result.report.results[1].bootstrapTarget, 'win32');
  assert.match(result.report.results[1].bootstrapCommand, /aih node bootstrap --target win32 --script-only/);
  assert.equal(result.report.results[1].bootstrapAction.channel, 'local-manual');
  assert.match(result.report.results[1].bootstrapAction.generateScriptCommand, /aih node bootstrap --target win32 --script-only/);
  assert.match(result.report.results[1].bootstrapAction.targetAction, /Copy and run the generated PowerShell script/);
  assert.match(result.report.results[1].bootstrapAction.note, /Local manual bootstrap only/);
  assert.match(result.report.results[1].recommendation, /local console/);
});

test('runNodeBootstrapProbe probes HTTP ingress without adding bootstrap execution steps', async () => {
  const result = await runNodeBootstrapProbe([
    '--ssh',
    'model@linux.local',
    '--http',
    'http://155.248.183.169:18381',
    '--http',
    'https://control.example.com/custom-health',
    '-j',
    '2'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Linux',
      arch: 'x86_64',
      commands: { node: true, npm: true, git: true, aih: true },
      repo: { present: true }
    }),
    httpProbe: async (target) => ({
      httpStatus: target.url.includes('custom-health') ? 200 : 0,
      timedOut: !target.url.includes('custom-health'),
      error: target.url.includes('custom-health') ? '' : 'timeout',
      latencyMs: target.url.includes('custom-health') ? 42 : 5000
    })
  });

  assert.equal(result.report.summary.total, 3);
  assert.equal(result.report.summary.httpReady, 1);
  assert.equal(result.report.summary.httpFailed, 1);
  assert.equal(result.report.summary.unreachable, 0);
  assert.deepEqual(result.report.results.filter((item) => item.kind === 'http').map((item) => ({
    target: item.target,
    url: item.url,
    status: item.status,
    ok: item.ok
  })), [
    {
      target: 'http://155.248.183.169:18381',
      url: 'http://155.248.183.169:18381/healthz',
      status: 'timeout',
      ok: false
    },
    {
      target: 'https://control.example.com/custom-health',
      url: 'https://control.example.com/custom-health',
      status: 'reachable',
      ok: true
    }
  ]);
  assert.equal(result.report.executionPlan.length, 1);
  assert.equal(result.report.executionPlan[0].kind, 'ssh');

  const output = formatNodeBootstrapProbeReport(result.report);
  assert.match(output, /http-ready:1, http-failed:1/);
  assert.match(output, /http http:\/\/155\.248\.183\.169:18381: timeout/);
  assert.match(output, /HTTP timed out/);
  assert.match(output, /http https:\/\/control\.example\.com\/custom-health: reachable/);
});

test('runNodeBootstrapProbe uses repo subdir for cross-platform default paths', async () => {
  const result = await runNodeBootstrapProbe([
    '--ssh',
    'model@linux.local',
    '--ssh',
    'madou@win.local',
    '--repo-subdir',
    'projects/feature/ai_home'
  ], {
    sshProbe: async (target) => ({
      status: 'reachable',
      platform: target.host.includes('win') ? 'Windows' : 'Linux',
      arch: target.host.includes('win') ? 'AMD64' : 'x86_64',
      commands: { node: true, npm: true, git: true, aih: true },
      repo: { present: true }
    })
  });

  const linux = result.report.results.find((item) => item.target === 'model@linux.local');
  const windows = result.report.results.find((item) => item.target === 'madou@win.local');

  assert.equal(linux.repo.checked, true);
  assert.equal(linux.repo.path, '~/projects/feature/ai_home');
  assert.equal(windows.repo.checked, true);
  assert.equal(windows.repo.path, '~\\projects\\feature\\ai_home');
  assert.match(linux.bootstrapCommand, /--repo-subdir projects\/feature\/ai_home/);
  assert.match(windows.bootstrapAction.remoteRunCommand, /--repo-subdir projects\/feature\/ai_home/);
});

test('runNodeBootstrapProbe falls back to Windows SSH diagnostics when POSIX probe fails', async () => {
  const calls = [];
  const result = await runNodeBootstrapProbe([
    '--ssh',
    'madou@win.local',
    '--repo-dir',
    'C:\\Users\\madou\\ai_home'
  ], {
    spawnImpl: (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        const remoteCommand = args[args.length - 1];
        if (String(remoteCommand).includes('-EncodedCommand')) {
          child.stdout.end([
            'platform=Windows',
            'arch=AMD64',
            'node=present',
            'npm=present',
            'git=present',
            'aih=present',
            'repo=present'
          ].join('\n'));
          child.stderr.end('');
          child.emit('close', 0);
          return;
        }
        child.stdout.end('');
        child.stderr.end('printf is not recognized as an internal or external command');
        child.emit('close', 1);
      });
      return child;
    }
  });

  const win = result.report.results[0];
  assert.equal(calls.length, 2);
  assert.equal(win.status, 'reachable');
  assert.equal(win.bootstrapTarget, 'win32');
  assert.equal(win.commands.node, true);
  assert.equal(win.commands.aih, true);
  assert.equal(win.repo.present, true);
  assert.equal(win.bootstrapAction.channel, 'ssh');
  assert.match(win.bootstrapAction.remoteRunCommand, /powershell -NoProfile -ExecutionPolicy Bypass -Command -/);
  assert.equal(result.report.executionPlan[0].status, 'ready');
  assert.equal(result.report.executionPlan[0].channel, 'ssh');
  assert.equal(result.report.executionPlan[0].execution.kind, 'ssh-pipe');
  assert.deepEqual(result.report.executionPlan[0].execution.sshArgs.slice(-2), [
    'madou@win.local',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command -'
  ]);
});

test('runNodeBootstrapProbe reports password ssh as auth required instead of unreachable', async () => {
  const result = await runNodeBootstrapProbe([
    '--ssh',
    'madou@192.168.3.76'
  ], {
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.end('');
        child.stderr.end('madou@192.168.3.76: Permission denied (publickey,password,keyboard-interactive).');
        child.emit('close', 255);
      });
      return child;
    }
  });

  const win = result.report.results[0];
  assert.equal(win.status, 'auth-required');
  assert.equal(result.report.summary.reachableSsh, 0);
  assert.equal(result.report.summary.authRequiredSsh, 1);
  assert.equal(result.report.summary.unreachable, 0);
  assert.equal(win.bootstrapAction.channel, 'ssh-auth');
  assert.equal(win.bootstrapAction.targetCommand, 'ssh madou@192.168.3.76');
  assert.deepEqual(
    win.bootstrapAction.manualCommands.map((item) => item.key),
    ['windows-interactive-ssh', 'linux-interactive-ssh', 'macos-interactive-ssh']
  );
  assert.match(
    win.bootstrapAction.manualCommands[0].command,
    /^aih node bootstrap --target win32 --script-only --transport relay \| ssh madou@192\.168\.3\.76 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'$/
  );
  assert.match(win.bootstrapAction.manualCommands[0].note, /does not store/);
  assert.match(win.bootstrapAction.note, /does not store SSH passwords/);
  assert.match(win.recommendation, /requires interactive authentication/);
  assert.equal(result.report.executionPlan[0].status, 'needs-input');
  assert.equal(result.report.executionPlan[0].channel, 'ssh-auth');
  assert.match(result.report.executionPlan[0].summary, /will not store SSH passwords/);
  assert.equal(result.report.executionPlan[0].manualCommands[0].key, 'windows-interactive-ssh');

  const output = formatNodeBootstrapProbeReport(result.report);
  assert.match(output, /\[aih\] summary: ssh:0, ssh-auth:1, ssh-port:0, winrm:0, local-manual:0, http-ready:0, http-failed:0, unreachable:0/);
  assert.match(output, /ssh madou@192\.168\.3\.76: auth-required/);
  assert.match(output, /SSH authentication required: madou@192\.168\.3\.76/);
  assert.match(output, /target command: ssh madou@192\.168\.3\.76/);
  assert.match(output, /manual commands:/);
  assert.match(output, /Windows interactive SSH: aih node bootstrap --target win32 --script-only --transport relay \| ssh madou@192\.168\.3\.76 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'/);
});

test('runNodeBootstrapProbe narrows password ssh bootstrap commands with target hint', async () => {
  const result = await runNodeBootstrapProbe([
    '--target',
    'win32',
    '--ssh',
    'madou@192.168.3.76',
    '--repo-subdir',
    'projects/feature/ai_home'
  ], {
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.end('');
        child.stderr.end('madou@192.168.3.76: Permission denied (publickey,password,keyboard-interactive).');
        child.emit('close', 255);
      });
      return child;
    }
  });

  const win = result.report.results[0];
  assert.equal(win.status, 'auth-required');
  assert.equal(win.bootstrapTarget, 'win32');
  assert.equal(win.repo.path, '~\\projects\\feature\\ai_home');
  assert.deepEqual(
    win.bootstrapAction.manualCommands.map((item) => item.key),
    ['windows-interactive-ssh']
  );
  assert.match(
    win.bootstrapAction.manualCommands[0].command,
    /^aih node bootstrap --target win32 --script-only --repo-subdir projects\/feature\/ai_home --transport relay \| ssh madou@192\.168\.3\.76 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'$/
  );
  assert.match(win.recommendation, /platform-specific SSH bootstrap command/);

  const output = formatNodeBootstrapProbeReport(result.report);
  assert.match(output, /Windows interactive SSH: aih node bootstrap --target win32 --script-only/);
  assert.doesNotMatch(output, /Linux interactive SSH/);
  assert.doesNotMatch(output, /macOS interactive SSH/);
});

test('runNodeBootstrapProbe keeps Windows local-manual fallback when password ssh also exists', async () => {
  const result = await runNodeBootstrapProbe([
    '--target',
    'win32',
    '--ssh',
    'madou@win.local',
    '--tcp',
    'win.local',
    '--ports',
    '22,3389,445',
    '--repo-subdir',
    'projects/feature/ai_home'
  ], {
    sshProbe: async () => ({
      status: 'auth-required',
      platform: '',
      arch: '',
      commands: { node: false, npm: false, git: false, aih: false },
      repo: { present: false },
      stderr: 'madou@win.local: Permission denied (publickey,password,keyboard-interactive).'
    }),
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({ port, open: port === 22 || port === 3389 || port === 445 }))
    })
  });

  assert.equal(result.report.summary.authRequiredSsh, 1);
  assert.equal(result.report.summary.sshPort, 0);
  assert.equal(result.report.summary.localManual, 1);
  assert.equal(result.report.results.length, 2);
  assert.deepEqual(result.report.executionPlan.map((step) => ({
    status: step.status,
    channel: step.channel,
    target: step.target
  })), [
    { status: 'needs-input', channel: 'ssh-auth', target: 'madou@win.local' },
    { status: 'manual', channel: 'local-manual', target: 'win.local' }
  ]);

  const apply = buildNodeBootstrapApplyPreview(result.report);
  assert.equal(apply.plan.summary.total, 2);
  assert.equal(apply.plan.summary.needsInput, 1);
  assert.equal(apply.plan.summary.manual, 1);
  assert.equal(apply.plan.summary.blocked, 0);
  assert.equal(apply.plan.actions[0].manualCommands[0].key, 'windows-interactive-ssh');

  const output = formatNodeBootstrapProbeReport(result.report);
  assert.match(output, /ssh madou@win\.local: auth-required/);
  assert.match(output, /tcp win\.local: local-manual/);
  assert.match(output, /Manual PowerShell bootstrap: win\.local/);
  assert.doesNotMatch(output, /SSH port detected: win\.local/);
});

test('runNodeBootstrapProbe warns when generated remote commands use loopback control url', async () => {
  const result = await runNodeBootstrapProbe([
    '--ssh',
    'model@linux.local',
    '--tcp',
    'win.local',
    '--ports',
    '3389',
    '--control-url',
    'http://127.0.0.1:9527',
    '--repo-url',
    'https://example.com/ai_home.git'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Linux',
      arch: 'x86_64',
      commands: { node: false, npm: false, git: true, aih: false },
      repo: { present: false }
    }),
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({ port, open: port === 3389 }))
    })
  });

  const output = formatNodeBootstrapProbeReport(result.report);

  assert.equal(result.report.warnings.some((warning) => warning.includes('control-url points to loopback')), true);
  assert.match(result.report.executionPlan[0].note, /remote targets will treat it as themselves/);
  assert.match(result.report.executionPlan[1].note, /remote targets will treat it as themselves/);
  assert.match(result.report.results[0].recommendation, /remote targets will treat it as themselves/);
  assert.match(result.report.results[1].recommendation, /remote targets will treat it as themselves/);
  assert.match(output, /\[aih\] warnings:/);
  assert.match(output, /control-url points to loopback/);
});

test('runNodeBootstrapProbe explains Windows local-manual when SSH and WinRM are closed', async () => {
  const result = await runNodeBootstrapProbe([
    '--tcp',
    '192.168.3.76',
    '--ports',
    '22,3389,445,5985,5986',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=win',
    '--repo-url',
    'https://example.com/ai_home.git'
  ], {
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({
        port,
        open: port === 3389 || port === 445,
        error: port === 3389 || port === 445 ? '' : 'ECONNREFUSED'
      }))
    })
  });

  const win = result.report.results[0];
  assert.equal(win.accessMode, 'local-manual');
  assert.deepEqual([...win.openPorts].sort((left, right) => left - right), [445, 3389]);
  assert.equal(win.bootstrapAction.channel, 'local-manual');
  assert.match(win.bootstrapAction.generateScriptCommand, /aih node bootstrap --target win32 --script-only/);
  assert.match(win.bootstrapAction.generateScriptCommand, /--invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=win'/);
  assert.match(win.bootstrapAction.targetCommand, /powershell -ExecutionPolicy Bypass/);
  assert.match(win.bootstrapAction.note, /Local manual bootstrap only/);

  const output = formatNodeBootstrapProbeReport(result.report);
  assert.match(output, /tcp 192\.168\.3\.76: local-manual/);
  assert.match(output, /\[aih\] execution plan:/);
  assert.match(output, /Manual PowerShell bootstrap: 192\.168\.3\.76/);
  assert.match(output, /open ports: (3389, 445|445, 3389)/);
  assert.match(output, /closed ports: 22, 5985, 5986/);
  assert.match(output, /channel: local-manual/);
  assert.match(output, /generate script: aih node bootstrap --target win32 --script-only/);
  assert.match(output, /run on target: Copy and run the generated PowerShell script/);
  assert.match(output, /Local manual bootstrap only/);
});

test('formatNodeBootstrapProbeReport renders actionable ssh and tcp output', async () => {
  const result = await runNodeBootstrapProbe([
    '--ssh',
    'model@mac.local',
    '--tcp',
    'win.local:5985',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=xyz'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Darwin',
      arch: 'x86_64',
      commands: { node: true, npm: true, git: true, aih: true },
      repo: { present: true }
    }),
    tcpProbe: async () => ({
      ports: [{ port: 5985, open: true }]
    })
  });

  const output = formatNodeBootstrapProbeReport(result.report);
  assert.match(output, /\[aih\] node bootstrap probe/);
  assert.match(output, /\[aih\] summary: ssh:1, ssh-auth:0, ssh-port:0, winrm:1, local-manual:0, http-ready:0, http-failed:0, unreachable:0/);
  assert.match(output, /\[aih\] execution plan:/);
  assert.match(output, /1\. SSH remote bootstrap: model@mac\.local/);
  assert.match(output, /2\. WinRM PowerShell bootstrap: win\.local:5985/);
  assert.match(output, /ssh model@mac\.local: reachable/);
  assert.match(output, /commands: node:ok, npm:ok, git:ok, aih:ok/);
  assert.match(output, /final join script with: aih node bootstrap --target darwin --script-only --invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=xyz'/);
  assert.match(output, /run over ssh: aih node bootstrap --target darwin --script-only --invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=xyz' --transport relay \| ssh model@mac\.local 'sh -s'/);
  assert.match(output, /tcp win\.local:5985: winrm/);
  assert.match(output, /bootstrap: aih node bootstrap --target win32 --script-only --invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=xyz' --transport relay/);
  assert.match(output, /channel: winrm/);
  assert.match(output, /generate the PowerShell bootstrap/);
});

test('parseNodeBootstrapApplyArgs separates apply flags from probe args', () => {
  const parsed = parseNodeBootstrapApplyArgs([
    '--ssh',
    'model@linux.local',
    '--tcp',
    'win.local',
    '--execute',
    '--yes',
    '--execute-concurrency',
    '3',
    '--execute-timeout-ms=60000',
    '--asset-mode',
    'local',
    '--node-dist-dir',
    '/tmp/aih-node-dist',
    '--node-version',
    '22.16.0',
    '--source-ref',
    'HEAD',
    '--json'
  ]);

  assert.equal(parsed.execute, true);
  assert.equal(parsed.assumeYes, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.executeConcurrency, 3);
  assert.equal(parsed.executeTimeoutMs, 60000);
  assert.equal(parsed.assetMode, 'local');
  assert.equal(parsed.nodeDistDir, '/tmp/aih-node-dist');
  assert.equal(parsed.nodeVersion, '22.16.0');
  assert.equal(parsed.sourceRef, 'HEAD');
  assert.deepEqual(parsed.probeArgs, [
    '--ssh',
    'model@linux.local',
    '--tcp',
    'win.local',
    '--json'
  ]);
});

test('buildNodeBootstrapApplyCommand renders dry-run apply command from probe options', () => {
  const command = buildNodeBootstrapApplyCommand({
    sshTargets: ['model@linux.local'],
    tcpTargets: ['win.local'],
    ports: [22, 3389],
    controlUrl: 'https://control.example.com',
    inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
    repoUrl: 'https://example.com/ai_home.git',
    transportKind: 'relay',
    concurrency: 2,
    timeoutMs: 1000
  });

  assert.match(command, /^aih node bootstrap apply --ssh model@linux\.local --tcp win\.local/);
  assert.match(command, /--ports 22,3389/);
  assert.match(command, /--invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=abc'/);
  assert.match(command, /-j 2 --timeout-ms 1000$/);
});

test('buildNodeBootstrapApplyCommand renders explicit execute command with bounded ssh concurrency', () => {
  const command = buildNodeBootstrapApplyCommand({
    sshTargets: ['model@linux.local', 'model@mac.local'],
    tcpTargets: ['win.local'],
    ports: [22, 3389],
    transportKind: 'relay',
    concurrency: 3,
    timeoutMs: 1000
  }, {
    execute: true,
    assumeYes: true,
    assetMode: 'local',
    nodeDistDir: '/tmp/aih-node-dist',
    nodeVersion: '22.16.0',
    sourceRef: 'HEAD',
    executeConcurrency: 2,
    executeTimeoutMs: 600000
  });

  assert.match(command, /^aih node bootstrap apply --execute --yes --asset-mode local --node-dist-dir \/tmp\/aih-node-dist --node-version 22\.16\.0 --source-ref HEAD --execute-concurrency 2 --execute-timeout-ms 600000/);
  assert.match(command, /--ssh model@linux\.local --ssh model@mac\.local --tcp win\.local/);
  assert.match(command, /-j 3 --timeout-ms 1000$/);
});

test('buildNodeDistFileName maps target platform and architecture to Node runtime archive', () => {
  assert.equal(
    buildNodeDistFileName({ target: 'linux', arch: 'x86_64', nodeVersion: 'v22.16.0' }),
    'node-v22.16.0-linux-x64.tar.xz'
  );
  assert.equal(
    buildNodeDistFileName({ target: 'darwin', arch: 'arm64', nodeVersion: '22.16.0' }),
    'node-v22.16.0-darwin-arm64.tar.xz'
  );
  assert.equal(
    buildNodeDistFileName({ target: 'win32', arch: 'AMD64', nodeVersion: '22.16.0' }),
    'node-v22.16.0-win-x64.zip'
  );
});

test('buildLocalAssetInstallScript uses local runtime, management key guard, and relay join commands', () => {
  const script = buildLocalAssetInstallScript({
    remoteStage: '.cache/aih-bootstrap/test',
    options: {
      target: 'linux',
      controlUrl: 'https://control.example.com',
      inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
      nodeId: 'linux-node',
      repoSubdir: 'projects/feature/ai_home',
      transportKind: 'relay',
      installService: true
    }
  });

  assert.match(script, /AIH_STAGE="\$HOME\/\.cache\/aih-bootstrap\/test"/);
  assert.match(script, /tar -xzf "\$AIH_STAGE\/source\.tgz" -C "\$AIH_REPO_DIR"/);
  assert.match(script, /tar -xJf "\$AIH_STAGE\/node\.tar\.xz" -C "\$AIH_REPO_DIR\/\.node-local"/);
  assert.match(script, /crypto\.randomBytes\(32\)/);
  assert.match(script, /server-config-store/);
  assert.doesNotMatch(script, /server-config\.json/);
  assert.match(script, /aih server start/);
  assert.match(script, /'aih' 'node' 'join' 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=abc' '--transport' 'relay' '--node-id' 'linux-node'/);
  assert.match(script, /'aih' 'node' 'relay' 'service' 'install' 'https:\/\/control\.example\.com' '--node-id' 'linux-node'/);
});

test('buildLocalAssetInstallScript opens remote server for direct HTTP endpoint bootstrap', () => {
  const script = buildLocalAssetInstallScript({
    remoteStage: '.cache/aih-bootstrap/test',
    options: {
      target: 'linux',
      controlUrl: 'http://192.168.3.181:9527',
      inviteUrl: 'http://192.168.3.181:9527/v0/node-rpc/join?code=abc',
      endpoint: 'http://192.168.3.8:9527',
      nodeId: 'linux-node',
      repoSubdir: 'projects/feature/ai_home',
      transportKind: 'direct',
      installService: true
    }
  });

  assert.match(script, /const bootstrapOpenNetwork = true;/);
  assert.match(script, /next\.host = '0\.0\.0\.0'/);
  assert.match(script, /"192\.168\.3\.181"/);
  assert.match(script, /"192\.168\.3\.8"/);
  assert.match(script, /'aih' 'node' 'join' 'http:\/\/192\.168\.3\.181:9527\/v0\/node-rpc\/join\?code=abc' '--transport' 'direct' '--endpoint' 'http:\/\/192\.168\.3\.8:9527' '--node-id' 'linux-node'/);
});

test('buildLocalAssetInstallScript supports Windows local runtime bootstrap', () => {
  const script = buildLocalAssetInstallScript({
    remoteStage: '.cache/aih-bootstrap/test',
    options: {
      target: 'win32',
      controlUrl: 'https://control.example.com',
      inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
      nodeId: 'win-node',
      repoDir: 'C:\\Users\\madou\\projects\\feature\\ai_home',
      transportKind: 'relay',
      installService: true
    }
  });

  assert.match(script, /\$AIH_STAGE = Join-Path \$HOME '\.cache\/aih-bootstrap\/test'/);
  assert.match(script, /tar -xzf \(Join-Path \$AIH_STAGE 'source\.tgz'\) -C \$AIH_REPO_DIR/);
  assert.match(script, /Expand-Archive -Force -Path \(Join-Path \$AIH_STAGE 'node\.zip'\)/);
  assert.match(script, /npm link/);
  assert.match(script, /npm prefix -g/);
  assert.match(script, /crypto\.randomBytes\(32\)/);
  assert.match(script, /server-config-store/);
  assert.doesNotMatch(script, /server-config\.json/);
  assert.match(script, /& \$env:AIH_CLI_PATH @\('node', 'join', 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=abc', '--transport', 'relay', '--node-id', 'win-node'\)/);
  assert.match(script, /& \$env:AIH_CLI_PATH @\('node', 'relay', 'service', 'install', 'https:\/\/control\.example\.com', '--node-id', 'win-node'\)/);
  assert.match(script, /Start-Process -FilePath \$env:AIH_CLI_PATH -ArgumentList \$relayArgs -WindowStyle Hidden/);
  assert.doesNotMatch(script, /node-secret|obsolete-secret|managementKey.*node-secret/);
});

test('runSshLocalAssetBootstrap transfers Windows zip assets and runs PowerShell', async () => {
  const calls = [];
  const result = await runSshLocalAssetBootstrap({
    bootstrapTarget: 'win32',
    arch: 'x64',
    bootstrapArgs: [
      'node',
      'bootstrap',
      '--target',
      'win32',
      '--control-url',
      'https://control.example.com',
      '--invite-url',
      'https://control.example.com/v0/node-rpc/join?code=abc',
      '--repo-dir',
      'C:\\Users\\madou\\projects\\feature\\ai_home',
      '--transport',
      'relay'
    ],
    sshArgs: [
      '-o',
      'BatchMode=yes',
      'madou@win.local',
      'powershell -NoProfile -ExecutionPolicy Bypass -Command -'
    ]
  }, {
    timeoutMs: 1000
  }, {
    prepareLocalAssets: async () => ({
      sourceArchive: '/tmp/source.tgz',
      nodeArchive: '/tmp/node.zip',
      cleanup() {}
    }),
    spawnImpl: (command, args) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      let input = '';
      child.stdin.on('data', (chunk) => { input += String(chunk); });
      child.stdin.on('finish', () => {
        calls.push({ command, args, input });
        child.stdout.end('');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    }
  });

  assert.equal(result.status, 0);
  assert.deepEqual(calls.map((call) => call.command), ['ssh', 'scp', 'scp', 'ssh']);
  assert.match(calls[0].args.at(-1), /New-Item -ItemType Directory/);
  assert.equal(calls[1].args.at(-2), '/tmp/source.tgz');
  assert.match(calls[1].args.at(-1), /^madou@win\.local:~\/\.cache\/aih-bootstrap\/.+\/source\.tgz$/);
  assert.equal(calls[2].args.at(-2), '/tmp/node.zip');
  assert.match(calls[2].args.at(-1), /^madou@win\.local:~\/\.cache\/aih-bootstrap\/.+\/node\.zip$/);
  assert.equal(calls[3].args.at(-1), 'powershell -NoProfile -ExecutionPolicy Bypass -Command -');
  assert.match(calls[3].input, /Expand-Archive -Force/);
  assert.match(calls[3].input, /Start-Process -FilePath \$env:AIH_CLI_PATH/);
});

test('buildNodeBootstrapApplyPreview derives dry-run actions from probe report', async () => {
  const probe = await runNodeBootstrapProbe([
    '--ssh',
    'model@linux.local',
    '--tcp',
    'win.local',
    '--ports',
    '3389,445'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Linux',
      arch: 'x86_64',
      commands: { node: false, npm: false, git: true, aih: false },
      repo: { present: false }
    }),
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({ port, open: port === 3389 || port === 445 }))
    })
  });

  const apply = buildNodeBootstrapApplyPreview(probe.report);
  assert.equal(apply.mode, 'dry-run');
  assert.equal(apply.plan.summary.executable, 1);
  assert.equal(apply.plan.summary.dryRun, 1);
  assert.equal(apply.plan.summary.manual, 1);
  assert.equal(apply.plan.actions[0].executionState, 'dry-run');
  assert.equal(apply.plan.actions[0].execution.kind, 'ssh-pipe');
  assert.equal(Object.keys(apply.plan.actions[0]).includes('execution'), false);
  assert.doesNotMatch(JSON.stringify(apply), /"execution":/);
  assert.equal(apply.plan.actions[1].executionState, 'manual');
});

test('buildNodeBootstrapApplyPreview treats WinRM as manual until a runner exists', async () => {
  const probe = await runNodeBootstrapProbe([
    '--tcp',
    'win.local:5985'
  ], {
    tcpProbe: async () => ({
      ports: [{ port: 5985, open: true }]
    })
  });

  const apply = buildNodeBootstrapApplyPreview(probe.report);

  assert.equal(probe.report.executionPlan[0].channel, 'winrm');
  assert.equal(probe.report.executionPlan[0].status, 'manual');
  assert.equal(apply.plan.summary.executable, 0);
  assert.equal(apply.plan.summary.manual, 1);
  assert.equal(apply.plan.summary.blocked, 0);
  assert.equal(apply.plan.actions[0].executionState, 'manual');
});

test('buildNodeBootstrapApplyPreview treats Windows SSH bootstrap as executable', async () => {
  const probe = await runNodeBootstrapProbe([
    '--ssh',
    'madou@win.local'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Windows',
      arch: 'AMD64',
      commands: { node: true, npm: true, git: true, aih: true },
      repo: { present: true }
    })
  });

  const apply = buildNodeBootstrapApplyPreview(probe.report);
  assert.equal(probe.report.executionPlan[0].status, 'ready');
  assert.equal(probe.report.executionPlan[0].channel, 'ssh');
  assert.equal(probe.report.executionPlan[0].execution.sshArgs.at(-1), 'powershell -NoProfile -ExecutionPolicy Bypass -Command -');
  assert.equal(apply.plan.summary.executable, 1);
  assert.equal(apply.plan.actions[0].executionState, 'dry-run');
});

test('buildNodeBootstrapApplyPreview surfaces password ssh manual commands', async () => {
  const probe = await runNodeBootstrapProbe([
    '--target',
    'win32',
    '--ssh',
    'madou@192.168.3.76',
    '--repo-subdir',
    'projects/feature/ai_home'
  ], {
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.end('');
        child.stderr.end('madou@192.168.3.76: Permission denied (publickey,password,keyboard-interactive).');
        child.emit('close', 255);
      });
      return child;
    }
  });

  const apply = buildNodeBootstrapApplyPreview(probe.report);

  assert.equal(apply.plan.summary.needsInput, 1);
  assert.equal(apply.plan.actions[0].executionState, 'needs-input');
  assert.equal(apply.plan.actions[0].manualCommands[0].key, 'windows-interactive-ssh');

  const output = formatNodeBootstrapApplyReport(apply);
  assert.match(output, /NEEDS-INPUT SSH authentication required: madou@192\.168\.3\.76/);
  assert.match(output, /manual commands:/);
  assert.match(output, /Windows interactive SSH: aih node bootstrap --target win32 --script-only --repo-subdir projects\/feature\/ai_home --transport relay \| ssh madou@192\.168\.3\.76 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'/);
});

test('createStructuredRunner executes ssh bootstrap pipeline without shell', async () => {
  const calls = [];
  const runner = createStructuredRunner({
    processObj: { env: {}, platform: 'darwin' },
    spawnImpl: (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        if (command === 'aih') {
          child.stdout.end('#!/bin/sh\necho bootstrap\n');
          child.stderr.end('');
          child.emit('close', 0);
          return;
        }
        if (command === 'ssh') {
          child.stdout.end('remote ok\n');
          child.stderr.end('');
          child.emit('close', 0);
          return;
        }
        child.stderr.end(`unexpected ${command}`);
        child.emit('close', 9);
      });
      return child;
    }
  });

  const result = await runner('display-only', {
    timeoutMs: 1000,
    action: {
      execution: {
        kind: 'ssh-pipe',
        bootstrapCommand: 'aih',
        bootstrapArgs: ['node', 'bootstrap', '--target', 'linux', '--script-only'],
        sshCommand: 'ssh',
        sshArgs: ['model@linux.local', 'sh -s']
      }
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /remote ok/);
  assert.deepEqual(calls.map((call) => call.command), ['aih', 'ssh']);
  assert.equal(calls.some((call) => call.command === '/bin/sh' || call.command === 'powershell.exe'), false);
  assert.deepEqual(calls[0].args, ['node', 'bootstrap', '--target', 'linux', '--script-only']);
  assert.deepEqual(calls[1].args, ['model@linux.local', 'sh -s']);
});

test('createStructuredRunner returns bootstrap failure status', async () => {
  const runner = createStructuredRunner({
    processObj: { env: {}, platform: 'linux' },
    spawnImpl: (command) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        if (command === 'aih') {
          child.stderr.end('bootstrap failed\n');
          child.stdout.end('');
          child.emit('close', 7);
          return;
        }
        child.stdout.end('');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    }
  });

  const result = await runner('display-only', {
    timeoutMs: 1000,
    action: {
      execution: {
        kind: 'ssh-pipe',
        bootstrapCommand: 'aih',
        bootstrapArgs: ['node', 'bootstrap', '--target', 'linux', '--script-only'],
        sshCommand: 'ssh',
        sshArgs: ['model@linux.local', 'sh -s']
      }
    }
  });

  assert.equal(result.status, 7);
  assert.match(result.stderr, /bootstrap failed/);
});

test('createStructuredRunner reuses current ai-home entrypoint for bootstrap generation', async () => {
  const calls = [];
  const runner = createStructuredRunner({
    processObj: {
      env: {},
      platform: 'darwin',
      execPath: '/usr/local/bin/node',
      argv: ['/usr/local/bin/node', '/repo/bin/ai-home.js']
    },
    spawnImpl: (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.end(command === '/usr/local/bin/node' ? '#!/bin/sh\n' : 'remote ok\n');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    }
  });

  const result = await runner('aih node bootstrap --target linux --script-only | ssh node sh -s', {
    timeoutMs: 1000,
    action: {
      execution: {
        kind: 'ssh-pipe',
        bootstrapCommand: 'aih',
        bootstrapArgs: ['node', 'bootstrap', '--target', 'linux', '--script-only'],
        sshCommand: 'ssh',
        sshArgs: ['model@linux.local', 'sh -s']
      }
    }
  });

  assert.equal(result.status, 0);
  assert.deepEqual(calls[0], {
    command: '/usr/local/bin/node',
    args: ['/repo/bin/ai-home.js', 'node', 'bootstrap', '--target', 'linux', '--script-only']
  });
  assert.deepEqual(calls[1], {
    command: 'ssh',
    args: ['model@linux.local', 'sh -s']
  });
});

test('createStructuredRunner reports spawn startup errors and cleans partial children', async () => {
  const killed = [];
  const runner = createStructuredRunner({
    processObj: { env: {}, platform: 'linux' },
    spawnImpl: (command) => {
      if (command === 'ssh') {
        throw new Error('spawn ssh ENOENT');
      }
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => { killed.push({ command, signal }); };
      return child;
    }
  });

  const result = await runner('display-only', {
    timeoutMs: 1000,
    action: {
      execution: {
        kind: 'ssh-pipe',
        bootstrapCommand: 'aih',
        bootstrapArgs: ['node', 'bootstrap', '--target', 'linux', '--script-only'],
        sshCommand: 'ssh',
        sshArgs: ['model@linux.local', 'sh -s']
      }
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /spawn ssh ENOENT/);
  assert.deepEqual(killed, [{ command: 'aih', signal: 'SIGTERM' }]);
});

test('createStructuredRunner kills bootstrap and ssh children on timeout', async () => {
  const killed = [];
  const runner = createStructuredRunner({
    processObj: { env: {}, platform: 'linux' },
    spawnImpl: (command) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => { killed.push({ command, signal }); };
      return child;
    }
  });

  const result = await runner('display-only', {
    timeoutMs: 1,
    action: {
      execution: {
        kind: 'ssh-pipe',
        bootstrapCommand: 'aih',
        bootstrapArgs: ['node', 'bootstrap', '--target', 'linux', '--script-only'],
        sshCommand: 'ssh',
        sshArgs: ['model@linux.local', 'sh -s']
      }
    }
  });

  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.deepEqual(killed, [
    { command: 'aih', signal: 'SIGTERM' },
    { command: 'ssh', signal: 'SIGTERM' }
  ]);
});

test('runNodeBootstrapApply defaults to dry-run without executing remote commands', async () => {
  const commands = [];
  const result = await runNodeBootstrapApply([
    '--ssh',
    'model@linux.local',
    '--tcp',
    'win.local',
    '--ports',
    '3389,445',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--repo-url',
    'https://example.com/ai_home.git'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Linux',
      arch: 'x86_64',
      commands: { node: false, npm: false, git: true, aih: false },
      repo: { present: false }
    }),
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({ port, open: port === 3389 || port === 445 }))
    }),
    commandRunner: async (command) => {
      commands.push(command);
      return { status: 0, stdout: '', stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'dry-run');
  assert.equal(commands.length, 0);
  assert.equal(result.plan.summary.executable, 1);
  assert.equal(result.plan.summary.dryRun, 1);
  assert.equal(result.plan.summary.manual, 1);
  assert.match(result.plan.actions[0].command, /ssh model@linux\.local 'sh -s'/);

  const output = formatNodeBootstrapApplyReport(result);
  assert.match(output, /\[aih\] node bootstrap apply/);
  assert.match(output, /mode: dry-run/);
  assert.match(output, /DRY-RUN SSH remote bootstrap: model@linux\.local/);
  assert.match(output, /MANUAL Manual PowerShell bootstrap: win\.local/);
  assert.match(output, /--execute --yes/);
});

test('runNodeBootstrapApply refuses execution without explicit confirmation', async () => {
  await assert.rejects(
    () => runNodeBootstrapApply(['--ssh', 'model@linux.local', '--execute'], {
      sshProbe: async () => {
        throw new Error('probe should not run before confirmation');
      }
    }),
    (error) => error && error.code === 'bootstrap_apply_confirmation_required'
  );
});

test('runNodeBootstrapApply refuses execution when bootstrap inputs are placeholders', async () => {
  await assert.rejects(
    () => runNodeBootstrapApply([
      '--ssh',
      'model@linux.local',
      '--execute',
      '--yes'
    ], {
      sshProbe: async () => {
        throw new Error('probe should not run when execute inputs are incomplete');
      }
    }),
    (error) => {
      assert.equal(error && error.code, 'bootstrap_apply_required_inputs_missing');
      assert.deepEqual(error.requiredInputs, ['control-url', 'invite-url', 'repo-url']);
      return true;
    }
  );
});

test('runNodeBootstrapApply local asset mode does not require remote repo url', async () => {
  const commands = [];
  const result = await runNodeBootstrapApply([
    '--ssh',
    'model@linux.local',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--asset-mode',
    'local',
    '--execute',
    '--yes'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Linux',
      arch: 'x86_64',
      commands: { node: false, npm: false, git: true, aih: false },
      repo: { present: false }
    }),
    commandRunner: async (command, context) => {
      commands.push({ command, execution: context.action.execution });
      return { status: 0, stdout: 'ok', stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.assetMode, 'local');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'local assets over ssh: model@linux.local');
  assert.equal(commands[0].execution.kind, 'ssh-local-assets');
  assert.equal(commands[0].execution.bootstrapTarget, 'linux');
});

test('runNodeBootstrapApply requires endpoint before executing external transports', async () => {
  await assert.rejects(
    () => runNodeBootstrapApply([
      '--ssh',
      'model@linux.local',
      '--transport',
      'frp',
      '--control-url',
      'https://control.example.com',
      '--invite-url',
      'https://control.example.com/v0/node-rpc/join?code=abc',
      '--repo-url',
      'https://example.com/ai_home.git',
      '--execute',
      '--yes'
    ], {
      sshProbe: async () => {
        throw new Error('probe should not run when endpoint is missing');
      }
    }),
    (error) => {
      assert.equal(error && error.code, 'bootstrap_apply_required_inputs_missing');
      assert.deepEqual(error.requiredInputs, ['endpoint']);
      return true;
    }
  );
});

test('runNodeBootstrapApply reports no-op execute plans without running commands', async () => {
  const commands = [];
  const result = await runNodeBootstrapApply([
    '--tcp',
    'win.local',
    '--ports',
    '3389,445',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--repo-url',
    'https://example.com/ai_home.git',
    '--execute',
    '--yes'
  ], {
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({ port, open: port === 3389 || port === 445 }))
    }),
    commandRunner: async (command) => {
      commands.push(command);
      return { status: 0, stdout: '', stderr: '' };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'execute');
  assert.equal(commands.length, 0);
  assert.equal(result.plan.error, 'bootstrap_apply_no_executable_actions');
  assert.match(result.plan.message, /No SSH-ready bootstrap actions/);
  assert.equal(result.plan.summary.executable, 0);
  assert.equal(result.plan.summary.manual, 1);
  assert.equal(result.plan.summary.failed, 0);
  assert.match(formatNodeBootstrapApplyReport(result), /No SSH-ready bootstrap actions/);
});

test('runNodeBootstrapApply executes only ssh-ready actions with bounded concurrency', async () => {
  const started = [];
  const completed = [];
  let active = 0;
  let maxActive = 0;
  const result = await runNodeBootstrapApply([
    '--ssh',
    'model@linux.local',
    '--ssh',
    'model@mac.local',
    '--tcp',
    'win.local',
    '--ports',
    '3389,445',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--repo-url',
    'https://example.com/ai_home.git',
    '--execute',
    '--yes',
    '--execute-concurrency',
    '2'
  ], {
    sshProbe: async (target) => ({
      status: 'reachable',
      platform: target.host.includes('mac') ? 'Darwin' : 'Linux',
      arch: 'x86_64',
      commands: { node: false, npm: false, git: true, aih: false },
      repo: { present: false }
    }),
    tcpProbe: async (target) => ({
      ports: target.ports.map((port) => ({ port, open: port === 3389 || port === 445 }))
    }),
    commandRunner: async (command, context) => {
      started.push({ command, target: context.target });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      completed.push(context.target);
      return { status: 0, stdout: `ok:${context.target}`, stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'execute');
  assert.equal(maxActive <= 2, true);
  assert.equal(started.length, 2);
  assert.deepEqual(completed.sort(), ['model@linux.local', 'model@mac.local']);
  assert.equal(result.plan.summary.executed, 2);
  assert.equal(result.plan.summary.manual, 1);
  assert.equal(result.plan.actions.some((action) => action.target === 'win.local' && action.executionState === 'manual'), true);
});

test('runNodeBootstrapApply reports execution failures', async () => {
  const result = await runNodeBootstrapApply([
    '--ssh',
    'model@linux.local',
    '--control-url',
    'https://control.example.com',
    '--invite-url',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--repo-url',
    'https://example.com/ai_home.git',
    '--execute',
    '--yes'
  ], {
    sshProbe: async () => ({
      status: 'reachable',
      platform: 'Linux',
      arch: 'x86_64',
      commands: { node: false, npm: false, git: true, aih: false },
      repo: { present: false }
    }),
    commandRunner: async () => ({ status: 12, stdout: '', stderr: 'install failed' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.plan.summary.failed, 1);
  assert.equal(result.plan.actions[0].executionState, 'failed');
  assert.equal(result.plan.actions[0].exitCode, 12);
  assert.match(formatNodeBootstrapApplyReport(result), /stderr: install failed/);
});

test('runNodeCommandRouter routes node bootstrap probe', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'bootstrap',
    'probe',
    '--ssh',
    'model@linux.local'
  ], {
    runNodeBootstrapProbe: async () => ({
      ok: true,
      json: false,
      report: {
        ok: true,
        concurrency: 1,
        timeoutMs: 1000,
        repoDir: '',
        warnings: [],
        results: [{
          kind: 'ssh',
          target: 'model@linux.local',
          host: 'linux.local',
          user: 'model',
          status: 'unreachable',
          platform: '',
          arch: '',
          commands: { node: false, npm: false, git: false, aih: false },
          repo: { checked: false, present: null, path: '' },
          stderr: 'timeout',
          recommendation: 'SSH is not reachable'
        }],
        summary: { total: 1 }
      }
    }),
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.match(writes.join(''), /node bootstrap probe/);
  assert.match(writes.join(''), /SSH is not reachable/);
});

test('runNodeCommandRouter routes node bootstrap apply', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'bootstrap',
    'apply',
    '--ssh',
    'model@linux.local'
  ], {
    runNodeBootstrapApply: async () => ({
      ok: true,
      json: false,
      mode: 'dry-run',
      executeTimeoutMs: 60000,
      executeConcurrency: 1,
      probe: { ok: true, report: { ok: true, results: [], executionPlan: [], summary: { total: 0 }, warnings: [] } },
      plan: {
        ok: true,
        warnings: [],
        summary: { total: 0, executable: 0, dryRun: 0, executed: 0, failed: 0, manual: 0, needsInput: 0, blocked: 0 },
        actions: []
      }
    }),
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.match(writes.join(''), /node bootstrap apply/);
});

test('runNodeCommandRouter reports missing bootstrap apply execute inputs', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'bootstrap',
    'apply',
    '--ssh',
    'model@linux.local',
    '--execute',
    '--yes'
  ], {
    runNodeBootstrapApply: async () => {
      const error = new Error('bootstrap_apply_required_inputs_missing');
      error.code = 'bootstrap_apply_required_inputs_missing';
      error.requiredInputs = ['control-url', 'invite-url', 'repo-url'];
      throw error;
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

  assert.equal(writes.length, 0);
  assert.deepEqual(exits, [1]);
  assert.match(errors.join(''), /complete bootstrap inputs/);
  assert.match(errors.join(''), /control-url, invite-url, repo-url/);
});

test('runNodeCommandRouter prints node usage for bootstrap apply help', async () => {
  const writes = [];
  const errors = [];
  const exits = [];

  await runNodeCommandRouter([
    'node',
    'bootstrap',
    'apply',
    '--help'
  ], {
    runNodeBootstrapApply: async () => {
      throw new Error('bootstrap apply runner should not be called for help');
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

  assert.equal(errors.length, 0);
  assert.deepEqual(exits, [0]);
  assert.match(writes.join(''), /AI Home Node/);
  assert.match(writes.join(''), /node bootstrap apply/);
  assert.match(writes.join(''), /relay is the default data-plane for no-public-IP machines/);
  assert.match(writes.join(''), /node id and display name default to the target machine identity and hostname/);
  assert.match(writes.join(''), /OpenMPTCPRouter\/MPTCP are underlay optimizers only/);
  assert.match(writes.join(''), /Desktop\/Web clients connect with Server URL \+ Management Key/);
});
