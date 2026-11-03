'use strict';

// SSH 开发机连通性探针：只回答「能不能连、是什么系统、常用命令在不在」。
// 原实现放在 node bootstrap 探针里；node/bootstrap 命令移除后，SSH 开发机页面仍需要
// 同一份只读诊断，所以把最小必要逻辑收在这里，不再带任何 bootstrap/invite 语义。

const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 12000;

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function buildRemoteProbeCommand() {
  return [
    'printf "platform=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
    'for c in node npm git aih; do if command -v "$c" >/dev/null 2>&1; then printf "%s=present\\n" "$c"; else printf "%s=missing\\n" "$c"; fi; done'
  ].join('; ');
}

function buildWindowsRemoteProbeCommand() {
  const script = `$ErrorActionPreference = 'SilentlyContinue'
Write-Output 'platform=Windows'
Write-Output ('arch=' + [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE'))
foreach ($CommandName in @('node', 'npm', 'git', 'aih')) {
  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    Write-Output ($CommandName + '=present')
  } else {
    Write-Output ($CommandName + '=missing')
  }
}
`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function buildSshArgs(target, options = {}, remoteCommand = buildRemoteProbeCommand()) {
  const timeoutSeconds = Math.max(1, Math.ceil((Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000));
  const destination = target.user ? `${target.user}@${target.host}` : target.host;
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeoutSeconds}`,
    '-o', 'StrictHostKeyChecking=accept-new'
  ];
  const identityFile = nonEmptyString(options.sshIdentityFile);
  if (identityFile) args.push('-i', identityFile);
  if (target.port) args.push('-p', String(target.port));
  args.push(destination, remoteCommand);
  return args;
}

function detectAuthRequired(result) {
  if (result && result.timedOut) return false;
  const stderr = nonEmptyString(result && result.stderr).toLowerCase();
  return stderr.includes('permission denied')
    && (stderr.includes('password') || stderr.includes('keyboard-interactive') || stderr.includes('publickey'));
}

function runProcess(command, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timer = null;
    const done = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: Number(result.status || 0),
        signal: result.signal || '',
        stdout,
        stderr,
        timedOut: Boolean(result.timedOut)
      });
    };
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      done({ status: 1, stderr: String((error && error.message) || error || '') });
      return;
    }
    timer = setTimeout(() => {
      try {
        if (child && typeof child.kill === 'function') child.kill('SIGTERM');
      } catch (_error) { /* gone */ }
      done({ status: 124, timedOut: true });
    }, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    }
    if (typeof child.on === 'function') {
      child.on('error', (error) => {
        stderr += String((error && error.message) || error || '');
        done({ status: 1 });
      });
      child.on('close', (code, signal) => done({ status: code === null ? 1 : Number(code), signal }));
    } else {
      done({ status: 1 });
    }
  });
}

function parseFacts(stdout) {
  const facts = {};
  String(stdout || '').split(/\r?\n/).forEach((line) => {
    const index = line.indexOf('=');
    if (index <= 0) return;
    facts[line.slice(0, index)] = line.slice(index + 1);
  });
  return facts;
}

function recommendationFor(status, facts) {
  if (status === 'auth-required') return 'SSH 可达，但需要认证；请检查私钥、agent 或密码。';
  if (status === 'unreachable') return 'SSH 不可达；请检查主机地址、端口和防火墙。';
  const missing = ['node', 'npm', 'git', 'aih'].filter((name) => facts[name] !== 'present');
  if (missing.length > 0) return `SSH 正常；远端缺少 ${missing.join(' / ')}，部分功能可能不可用。`;
  return 'SSH 连接正常。';
}

async function probeSshTarget(target, options = {}, deps = {}) {
  if (typeof deps.sshProbe === 'function') {
    return deps.sshProbe(target, options);
  }
  let result = await runProcess('ssh', buildSshArgs(target, options, buildRemoteProbeCommand()), {
    timeoutMs: options.timeoutMs,
    spawnImpl: deps.spawnImpl
  });
  let facts = parseFacts(result.stdout);
  if (result.status !== 0 && !result.timedOut) {
    const windowsResult = await runProcess('ssh', buildSshArgs(target, options, buildWindowsRemoteProbeCommand()), {
      timeoutMs: options.timeoutMs,
      spawnImpl: deps.spawnImpl
    });
    const windowsFacts = parseFacts(windowsResult.stdout);
    if (windowsResult.status === 0 || windowsFacts.platform) {
      result = windowsResult;
      facts = windowsFacts;
    }
  }
  const authRequired = result.status !== 0 && detectAuthRequired(result);
  const status = result.status === 0 ? 'reachable' : (authRequired ? 'auth-required' : 'unreachable');
  return {
    kind: 'ssh',
    target: target.label || (target.user ? `${target.user}@${target.host}` : target.host),
    host: target.host,
    user: target.user || '',
    port: Number(target.port) || 22,
    status,
    platform: nonEmptyString(facts.platform),
    arch: nonEmptyString(facts.arch),
    commands: {
      node: facts.node === 'present',
      npm: facts.npm === 'present',
      git: facts.git === 'present',
      aih: facts.aih === 'present'
    },
    repo: { checked: false, present: null, path: '' },
    stderr: nonEmptyString(result.stderr).slice(0, 1000),
    timedOut: Boolean(result.timedOut),
    recommendation: recommendationFor(status, facts),
    bootstrapTarget: '',
    bootstrapCommand: '',
    bootstrapAction: null
  };
}

module.exports = {
  buildRemoteProbeCommand,
  buildSshArgs,
  probeSshTarget
};
