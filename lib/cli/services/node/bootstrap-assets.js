'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  getDefaultRepoSubdir,
  normalizeRepoSubdir
} = require('../../../server/remote/repo-paths');

const DEFAULT_NODE_DIST_DIR = '/tmp/aih-node-dist';
const DEFAULT_ASSET_MODE = 'script';
const LOCAL_ASSET_MODE = 'local';

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function normalizeAssetMode(value) {
  const mode = nonEmptyString(value || DEFAULT_ASSET_MODE).toLowerCase();
  if (mode === DEFAULT_ASSET_MODE || mode === LOCAL_ASSET_MODE) return mode;
  const error = new Error(`invalid_asset_mode:${mode}`);
  error.code = 'invalid_asset_mode';
  error.mode = mode;
  throw error;
}

function normalizeNodeVersion(value, processObj = process) {
  const raw = nonEmptyString(value || (processObj && processObj.version) || process.version);
  return raw.replace(/^v/i, '');
}

function normalizeNodePlatform(target) {
  const value = nonEmptyString(target).toLowerCase();
  if (value === 'linux' || value === 'darwin') return value;
  if (value === 'win32' || value === 'windows' || value === 'win') return 'win';
  return '';
}

function normalizeNodeArch(value) {
  const arch = nonEmptyString(value).toLowerCase();
  if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  return '';
}

function parseUrlHost(value) {
  const raw = nonEmptyString(value);
  if (!raw) return '';
  try {
    return nonEmptyString(new URL(raw).hostname).replace(/^\[|\]$/g, '');
  } catch (_error) {
    return '';
  }
}

function parseIpv4(value) {
  const parts = nonEmptyString(value).split('.');
  if (parts.length !== 4) return [];
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : [];
}

function shouldBypassProxyForHost(host) {
  const normalized = nonEmptyString(host).toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized.endsWith('.local')) return true;
  const octets = parseIpv4(normalized);
  if (octets.length === 0) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function uniqueStrings(values = []) {
  const seen = new Set();
  return values
    .map((value) => nonEmptyString(value))
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function transportNeedsHttpEndpoint(kind) {
  return nonEmptyString(kind || 'relay').toLowerCase() !== 'relay';
}

function buildBootstrapServerConfigOptions(options = {}) {
  const openNetwork = transportNeedsHttpEndpoint(options.transportKind);
  const endpointHost = parseUrlHost(options.endpoint);
  const controlHost = parseUrlHost(options.controlUrl);
  const noProxyEntries = openNetwork
    ? uniqueStrings([
        'localhost',
        '127.0.0.1',
        '0.0.0.0',
        shouldBypassProxyForHost(controlHost) ? controlHost : '',
        shouldBypassProxyForHost(endpointHost) ? endpointHost : ''
      ])
    : [];
  return {
    openNetwork,
    noProxyEntries
  };
}

function buildNodeDistFileName(input = {}) {
  const version = normalizeNodeVersion(input.nodeVersion, input.processObj);
  const platform = normalizeNodePlatform(input.target);
  const arch = normalizeNodeArch(input.arch || (input.processObj && input.processObj.arch));
  if (!version || !platform || !arch) return '';
  const extension = platform === 'win' ? 'zip' : 'tar.xz';
  return `node-v${version}-${platform}-${arch}.${extension}`;
}

function parseBootstrapOption(args = [], flags = []) {
  const names = Array.isArray(flags) ? flags : [flags];
  for (let index = 0; index < args.length; index += 1) {
    const token = nonEmptyString(args[index]);
    const matched = names.find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!matched) continue;
    if (token.startsWith(`${matched}=`)) return token.slice(matched.length + 1);
    return nonEmptyString(args[index + 1]);
  }
  return '';
}

function parseLocalAssetBootstrapOptions(execution = {}) {
  const args = Array.isArray(execution.bootstrapArgs)
    ? execution.bootstrapArgs.map((item) => String(item))
    : [];
  const target = nonEmptyString(execution.bootstrapTarget || parseBootstrapOption(args, '--target'));
  return {
    target,
    controlUrl: parseBootstrapOption(args, '--control-url'),
    inviteUrl: parseBootstrapOption(args, '--invite-url'),
    endpoint: parseBootstrapOption(args, '--endpoint'),
    nodeId: parseBootstrapOption(args, ['--node-id', '--id']),
    repoDir: parseBootstrapOption(args, '--repo-dir'),
    repoSubdir: normalizeRepoSubdir(parseBootstrapOption(args, '--repo-subdir')),
    transportKind: parseBootstrapOption(args, ['--transport', '--transport-kind']) || 'relay',
    installService: !args.includes('--no-service')
  };
}

function buildRemoteRepoDirExpression(options = {}) {
  if (nonEmptyString(options.repoDir)) return shellQuote(options.repoDir);
  return `"$HOME/${getDefaultRepoSubdir(options.repoSubdir)}"`;
}

function buildEnsureManagementKeyNodeScript(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const openNetwork = Boolean(source.openNetwork);
  const noProxyEntries = uniqueStrings(source.noProxyEntries);
  return `const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readServerConfig, writeServerConfig } = require('./lib/server/server-config-store');
const aiHomeDir = String(process.env.AIH_HOME_DIR || process.env.AIH_HOME || path.join(os.homedir(), '.ai_home'));
const bootstrapOpenNetwork = ${openNetwork ? 'true' : 'false'};
const bootstrapNoProxyEntries = ${JSON.stringify(noProxyEntries)};
function mergeCsv(current, additions) {
  const seen = new Set();
  return String(current || '').split(',')
    .concat(additions || [])
    .map((item) => String(item || '').trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .join(',');
}
const next = { ...readServerConfig({ fs, aiHomeDir }) };
if (!String(next.managementKey || '').trim()) next.managementKey = crypto.randomBytes(32).toString('base64url');
if (bootstrapOpenNetwork) {
  next.host = '0.0.0.0';
  next.openNetwork = true;
}
if (bootstrapNoProxyEntries.length > 0) {
  next.noProxy = mergeCsv(next.noProxy, bootstrapNoProxyEntries);
}
writeServerConfig(next, { fs, aiHomeDir });
`;
}

function buildShellCommand(args = []) {
  return args.map(shellQuote).join(' ');
}

function buildShellCommandWithNodeId(args = [], explicitNodeId = '') {
  const prefix = buildShellCommand(args.concat('--node-id'));
  return `${prefix} ${explicitNodeId ? shellQuote(explicitNodeId) : '"$AIH_NODE_ID"'}`;
}

function powerShellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildPowerShellArray(args = []) {
  return `@(${args.map(powerShellSingleQuote).join(', ')})`;
}

function buildPowerShellAihInvocation(args = [], explicitNodeId = '') {
  const tokens = args.slice();
  tokens.push('--node-id');
  const prefix = tokens.map(powerShellSingleQuote).join(', ');
  return explicitNodeId
    ? `& $env:AIH_CLI_PATH @(${prefix}, ${powerShellSingleQuote(explicitNodeId)})`
    : `& $env:AIH_CLI_PATH @(${prefix}, $AIH_NODE_ID)`;
}

function buildWindowsRepoDirExpression(options = {}) {
  if (nonEmptyString(options.repoDir)) return powerShellSingleQuote(options.repoDir);
  return `(Join-Path $HOME ${powerShellSingleQuote(getDefaultRepoSubdir(options.repoSubdir))})`;
}

function buildWindowsLocalAssetInstallScript(input = {}) {
  const options = input.options || {};
  const stage = nonEmptyString(input.remoteStage);
  const repoDir = buildWindowsRepoDirExpression(options);
  const explicitNodeId = nonEmptyString(options.nodeId);
  const controlUrl = nonEmptyString(options.controlUrl);
  const inviteUrl = nonEmptyString(options.inviteUrl);
  const transportKind = nonEmptyString(options.transportKind || 'relay');
  const serverConfigOptions = buildBootstrapServerConfigOptions(options);
  const joinArgs = ['node', 'join', inviteUrl, '--transport', transportKind];
  if (options.endpoint) joinArgs.push('--endpoint', options.endpoint);
  const doctorArgs = ['node', 'doctor'];
  if (controlUrl) doctorArgs.push('--control-url', controlUrl);
  const serviceArgs = ['node', 'relay', 'service', 'install', controlUrl];
  const serviceCommand = options.installService === false
    ? ''
    : `${buildPowerShellAihInvocation(serviceArgs, explicitNodeId)}
$relayArgs = ${buildPowerShellArray(['node', 'relay', 'connect', controlUrl, '--node-id'])} + @($AIH_NODE_ID)
Start-Process -FilePath $env:AIH_CLI_PATH -ArgumentList $relayArgs -WindowStyle Hidden
`;

  return `$ErrorActionPreference = 'Stop'
$AIH_STAGE = Join-Path $HOME ${powerShellSingleQuote(stage)}
$AIH_REPO_DIR = if ($env:AIH_REPO_DIR) { $env:AIH_REPO_DIR } else { ${repoDir} }
New-Item -ItemType Directory -Force -Path $AIH_REPO_DIR | Out-Null
tar -xzf (Join-Path $AIH_STAGE 'source.tgz') -C $AIH_REPO_DIR
$nodeDir = Join-Path $AIH_REPO_DIR '.node-local'
if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
$nodeExtractDir = Join-Path $AIH_STAGE 'node-extract'
if (Test-Path $nodeExtractDir) { Remove-Item -Recurse -Force $nodeExtractDir }
Expand-Archive -Force -Path (Join-Path $AIH_STAGE 'node.zip') -DestinationPath $nodeExtractDir
$nodeRoot = Get-ChildItem -Path $nodeExtractDir -Directory | Select-Object -First 1
if (-not $nodeRoot) { throw 'Node archive did not contain an install directory.' }
Copy-Item -Path (Join-Path $nodeRoot.FullName '*') -Destination $nodeDir -Recurse -Force
$env:PATH = "$nodeDir;$env:PATH"
Set-Location $AIH_REPO_DIR
npm install
npm link
$npmPrefix = ''
try { $npmPrefix = [string](& npm prefix -g | Select-Object -First 1) } catch {}
$aihCommand = if ($npmPrefix -and (Test-Path (Join-Path $npmPrefix 'aih.cmd'))) { Join-Path $npmPrefix 'aih.cmd' } else { '' }
if (-not $aihCommand) { $aihCommand = (Get-Command aih.cmd -ErrorAction SilentlyContinue).Source }
if (-not $aihCommand) { $aihCommand = (Get-Command aih -ErrorAction SilentlyContinue).Source }
if (-not $aihCommand) { throw 'aih command could not be resolved after npm link.' }
$env:AIH_CLI_PATH = $aihCommand
$ensureConfig = @'
${buildEnsureManagementKeyNodeScript(serverConfigOptions)}'@
$ensureConfig | node
& $env:AIH_CLI_PATH @('server', 'start') *> $null
$AIH_NODE_ID = if ($env:AIH_NODE_ID) { $env:AIH_NODE_ID } else { ${powerShellSingleQuote(explicitNodeId)} }
if (-not $AIH_NODE_ID) {
  $localDoctor = & $env:AIH_CLI_PATH @('node', 'doctor', '--json') | ConvertFrom-Json
  $AIH_NODE_ID = [string]$localDoctor.report.node.id
}
if (-not $AIH_NODE_ID) { throw 'AIH_NODE_ID could not be resolved.' }
$env:AIH_NODE_ID = $AIH_NODE_ID
$doctorJson = ${buildPowerShellAihInvocation(['node', 'doctor', '--json'].concat(controlUrl ? ['--control-url', controlUrl] : []), explicitNodeId)} | ConvertFrom-Json
$issues = @($doctorJson.report.issues)
$blockers = @($issues | Where-Object { $_.severity -eq 'blocker' })
if ($blockers.Count -gt 0) {
  throw ('AIH node preflight failed: ' + (($blockers | ForEach-Object { "$($_.code) - $($_.message)" }) -join '; '))
}
${buildPowerShellAihInvocation(doctorArgs, explicitNodeId)}
${buildPowerShellAihInvocation(joinArgs, explicitNodeId)}
${serviceCommand}`;
}

function buildPosixLocalAssetInstallScript(input = {}) {
  const options = input.options || {};
  const stage = nonEmptyString(input.remoteStage);
  const repoDir = buildRemoteRepoDirExpression(options);
  const explicitNodeId = nonEmptyString(options.nodeId);
  const controlUrl = nonEmptyString(options.controlUrl);
  const inviteUrl = nonEmptyString(options.inviteUrl);
  const transportKind = nonEmptyString(options.transportKind || 'relay');
  const serverConfigOptions = buildBootstrapServerConfigOptions(options);
  const joinArgs = ['aih', 'node', 'join', inviteUrl, '--transport', transportKind];
  if (options.endpoint) joinArgs.push('--endpoint', options.endpoint);
  const doctorArgs = ['aih', 'node', 'doctor'];
  if (controlUrl) doctorArgs.push('--control-url', controlUrl);
  const serviceArgs = ['aih', 'node', 'relay', 'service', 'install', controlUrl];
  const serviceCommand = options.installService === false
    ? ''
    : `${buildShellCommandWithNodeId(serviceArgs, explicitNodeId)}\n`;

  return `set -eu
AIH_STAGE="$HOME/${stage}"
AIH_REPO_DIR=\${AIH_REPO_DIR:-${repoDir}}
mkdir -p "$AIH_REPO_DIR"
tar -xzf "$AIH_STAGE/source.tgz" -C "$AIH_REPO_DIR"
rm -rf "$AIH_REPO_DIR/.node-local"
mkdir -p "$AIH_REPO_DIR/.node-local"
tar -xJf "$AIH_STAGE/node.tar.xz" -C "$AIH_REPO_DIR/.node-local" --strip-components=1
export PATH="$AIH_REPO_DIR/.node-local/bin:$PATH"
export AIH_CLI_PATH="$AIH_REPO_DIR/.node-local/bin/aih"
cd "$AIH_REPO_DIR"
npm install
npm link
node <<'NODE'
${buildEnsureManagementKeyNodeScript(serverConfigOptions)}NODE
aih server start >/dev/null 2>&1 || true
AIH_NODE_ID=\${AIH_NODE_ID:-${shellQuote(explicitNodeId)}}
if [ -z "$AIH_NODE_ID" ]; then
  AIH_NODE_ID="$(aih node doctor --json | node -e 'const chunks=[];process.stdin.on("data",(c)=>chunks.push(c));process.stdin.on("end",()=>{const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));process.stdout.write(String(data.report&&data.report.node&&data.report.node.id||""));});')"
fi
if [ -z "$AIH_NODE_ID" ]; then
  echo "AIH_NODE_ID could not be resolved." >&2
  exit 1
fi
export AIH_NODE_ID
AIH_DOCTOR_JSON="$(${buildShellCommandWithNodeId(['aih', 'node', 'doctor', '--json'].concat(controlUrl ? ['--control-url', controlUrl] : []), explicitNodeId)})"
printf '%s\\n' "$AIH_DOCTOR_JSON" | node -e 'const chunks=[];process.stdin.on("data",(c)=>chunks.push(c));process.stdin.on("end",()=>{const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));const report=data.report||{};const issues=Array.isArray(report.issues)?report.issues:[];const blockers=issues.filter((issue)=>issue&&issue.severity==="blocker");if(blockers.length){console.error("AIH node preflight failed: "+blockers.map((issue)=>[issue.code,issue.message].filter(Boolean).join(" - ")).join("; "));process.exit(1);}});'
${buildShellCommandWithNodeId(doctorArgs, explicitNodeId)}
${buildShellCommandWithNodeId(joinArgs, explicitNodeId)}
${serviceCommand}`;
}

function buildLocalAssetInstallScript(input = {}) {
  const options = input.options || {};
  const target = nonEmptyString(options.target).toLowerCase();
  if (target === 'win32' || target === 'windows' || target === 'win') {
    return buildWindowsLocalAssetInstallScript(input);
  }
  return buildPosixLocalAssetInstallScript(input);
}

function runProcess(command, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let child;
    const done = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: Number(result.status || 0),
        stdout,
        stderr,
        signal: result.signal || '',
        timedOut: Boolean(result.timedOut)
      });
    };
    const timer = setTimeout(() => {
      try {
        if (child && typeof child.kill === 'function') child.kill('SIGTERM');
      } catch (_error) {}
      done({ status: 124, timedOut: true });
    }, Math.max(1000, Number(options.timeoutMs) || 30 * 60 * 1000));

    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      stderr += String((error && error.message) || error || '');
      done({ status: 1 });
      return;
    }

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    }
    if (child.stdin && typeof child.stdin.end === 'function') {
      child.stdin.end(options.input || '');
    }
    if (child.stdin && typeof child.stdin.on === 'function') {
      child.stdin.on('error', () => {});
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

async function createSourceArchive(options = {}, deps = {}) {
  if (typeof deps.createSourceArchive === 'function') return deps.createSourceArchive(options);
  const tmpDir = options.tmpDir;
  const archive = path.join(tmpDir, 'source.tgz');
  const processObj = deps.processObj || process;
  const cwd = nonEmptyString(options.sourceDir) || (
    processObj && typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd()
  );
  const sourceRef = nonEmptyString(options.sourceRef || 'HEAD');
  const result = await runProcess('git', ['archive', '--format=tar.gz', '-o', archive, sourceRef], {
    cwd,
    timeoutMs: options.timeoutMs,
    spawnImpl: deps.spawnImpl || spawn,
    env: processObj.env || process.env
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || 'git archive failed');
    error.code = 'source_archive_failed';
    throw error;
  }
  return archive;
}

async function resolveNodeDistPath(input = {}, deps = {}) {
  if (typeof deps.resolveNodeDistPath === 'function') return deps.resolveNodeDistPath(input);
  const processObj = deps.processObj || process;
  const fileName = buildNodeDistFileName({
    target: input.target,
    arch: input.arch,
    nodeVersion: input.nodeVersion,
    processObj
  });
  if (!fileName) {
    const error = new Error('unsupported_node_dist_target');
    error.code = 'unsupported_node_dist_target';
    throw error;
  }
  const dir = nonEmptyString(input.nodeDistDir || processObj.env && processObj.env.AIH_NODE_DIST_DIR)
    || DEFAULT_NODE_DIST_DIR;
  const filePath = path.join(dir, fileName);
  if (fs.existsSync(filePath)) return filePath;
  const error = new Error(`node_dist_missing:${filePath}`);
  error.code = 'node_dist_missing';
  error.filePath = filePath;
  throw error;
}

function splitSshArgs(sshArgs = []) {
  const args = Array.isArray(sshArgs) ? sshArgs.map((item) => String(item)) : [];
  const remoteCommand = args[args.length - 1] || '';
  const destination = args[args.length - 2] || '';
  const baseArgs = args.slice(0, -1);
  const scpArgs = [];
  for (let index = 0; index < args.length - 2; index += 1) {
    const token = args[index];
    if (token === '-p' && args[index + 1]) {
      scpArgs.push('-P', args[index + 1]);
      index += 1;
      continue;
    }
    scpArgs.push(token);
  }
  return { args, baseArgs, scpArgs, destination, remoteCommand };
}

function appendResult(target, label, result) {
  const prefix = `[${label}]`;
  return {
    status: result.status,
    stdout: `${target.stdout}${result.stdout ? `${prefix} ${result.stdout}` : ''}`,
    stderr: `${target.stderr}${result.stderr ? `${prefix} ${result.stderr}` : ''}`,
    timedOut: target.timedOut || result.timedOut
  };
}

function makeRemoteStage() {
  return `.cache/aih-bootstrap/${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function prepareLocalAssets(execution, options = {}, deps = {}) {
  if (typeof deps.prepareLocalAssets === 'function') return deps.prepareLocalAssets(execution, options);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-bootstrap-assets-'));
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_error) {}
  };
  const parsed = parseLocalAssetBootstrapOptions(execution);
  const sourceArchive = await createSourceArchive({
    tmpDir,
    sourceRef: options.sourceRef,
    sourceDir: options.sourceDir,
    timeoutMs: options.timeoutMs
  }, deps);
  const nodeArchive = await resolveNodeDistPath({
    target: parsed.target,
    arch: execution.arch,
    nodeVersion: options.nodeVersion,
    nodeDistDir: options.nodeDistDir
  }, deps);
  return { tmpDir, sourceArchive, nodeArchive, cleanup };
}

async function runSshLocalAssetBootstrap(execution = {}, options = {}, deps = {}) {
  const parsed = parseLocalAssetBootstrapOptions(execution);
  if (!['linux', 'darwin', 'win32'].includes(parsed.target)) {
    return {
      status: 1,
      stdout: '',
      stderr: 'local asset bootstrap supports linux, darwin, and win32 SSH targets',
      timedOut: false
    };
  }
  const ssh = splitSshArgs(execution.sshArgs);
  if (!ssh.destination) {
    return { status: 1, stdout: '', stderr: 'missing ssh destination', timedOut: false };
  }

  let assets;
  let output = { status: 0, stdout: '', stderr: '', timedOut: false };
  const spawnImpl = deps.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs;
  const isWindowsTarget = parsed.target === 'win32';
  try {
    assets = await prepareLocalAssets(execution, options, deps);
    const remoteStage = makeRemoteStage();
    const remoteMkdirCommand = isWindowsTarget
      ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "New-Item -ItemType Directory -Force -Path (Join-Path $HOME '${remoteStage}') | Out-Null"`
      : `mkdir -p "$HOME/${remoteStage}"`;
    const remoteInstallCommand = isWindowsTarget
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'
      : 'sh -s';
    const mkdirResult = await runProcess('ssh', ssh.baseArgs.concat(remoteMkdirCommand), {
      timeoutMs,
      spawnImpl
    });
    output = appendResult(output, 'ssh-mkdir', mkdirResult);
    if (mkdirResult.status !== 0) return output;

    const scpTargets = [
      [assets.sourceArchive, `${ssh.destination}:~/${remoteStage}/source.tgz`],
      [assets.nodeArchive, `${ssh.destination}:~/${remoteStage}/${isWindowsTarget ? 'node.zip' : 'node.tar.xz'}`]
    ];
    for (const item of scpTargets) {
      const scpResult = await runProcess('scp', ssh.scpArgs.concat(item), {
        timeoutMs,
        spawnImpl
      });
      output = appendResult(output, 'scp', scpResult);
      if (scpResult.status !== 0) return output;
    }

    const script = buildLocalAssetInstallScript({ options: parsed, remoteStage });
    const installResult = await runProcess('ssh', ssh.baseArgs.concat(remoteInstallCommand), {
      timeoutMs,
      spawnImpl,
      input: script
    });
    output = appendResult(output, 'ssh-install', installResult);
    return output;
  } catch (error) {
    return {
      status: 1,
      stdout: output.stdout,
      stderr: `${output.stderr}${String((error && error.message) || error || '')}`,
      timedOut: output.timedOut
    };
  } finally {
    if (assets && typeof assets.cleanup === 'function') assets.cleanup();
  }
}

module.exports = {
  DEFAULT_ASSET_MODE,
  DEFAULT_NODE_DIST_DIR,
  LOCAL_ASSET_MODE,
  normalizeAssetMode,
  normalizeNodeVersion,
  normalizeNodeArch,
  buildNodeDistFileName,
  buildBootstrapServerConfigOptions,
  buildEnsureManagementKeyNodeScript,
  parseLocalAssetBootstrapOptions,
  buildLocalAssetInstallScript,
  runSshLocalAssetBootstrap
};
