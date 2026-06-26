'use strict';

const { normalizeTransportKind } = require('../../../server/remote/transport-registry');
const { normalizeId } = require('../../../server/remote/node-registry');
const {
  getDefaultRepoSubdir,
  normalizeRepoSubdir,
  toWindowsRepoSubdir
} = require('../../../server/remote/repo-paths');
const { getLoopbackControlEndpointWarning } = require('../../../control-endpoint');
const {
  buildBootstrapServerConfigOptions,
  buildEnsureManagementKeyNodeScript
} = require('./bootstrap-assets');

const SUPPORTED_BOOTSTRAP_TARGETS = Object.freeze(['linux', 'darwin', 'win32']);
const DEFAULT_TRANSPORT_KIND = 'relay';

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function normalizeHttpUrl(value, code) {
  const raw = nonEmptyString(value).replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return parsed.toString().replace(/\/+$/, '');
}

function getLoopbackControlUrlWarning(controlUrl) {
  return getLoopbackControlEndpointWarning(
    controlUrl,
    'control-url points to loopback; remote targets will treat it as themselves. Use a LAN, overlay, FRP, tunnel, or public Control Endpoint before running remote bootstrap.'
  );
}

function parseNodeBootstrapArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    target: '',
    channel: '',
    controlUrl: '',
    inviteUrl: '',
    endpoint: '',
    nodeId: '',
    repoUrl: '',
    repoDir: '',
    repoSubdir: '',
    transportKind: DEFAULT_TRANSPORT_KIND,
    installService: true,
    scriptOnly: false,
    json: false
  };

  for (let index = 0; index < args.length;) {
    const token = nonEmptyString(args[index]);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--no-service') {
      options.installService = false;
      index += 1;
      continue;
    }
    if (token === '--script-only' || token === '--print-script' || token === '--print-script-only') {
      options.scriptOnly = true;
      index += 1;
      continue;
    }
    if (token === '--target' || token.startsWith('--target=')) {
      const next = readOptionValue(args, index, '--target');
      options.target = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--channel' || token.startsWith('--channel=')) {
      const next = readOptionValue(args, index, '--channel');
      options.channel = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--control-url' || token.startsWith('--control-url=')) {
      const next = readOptionValue(args, index, '--control-url');
      options.controlUrl = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--invite-url' || token.startsWith('--invite-url=')) {
      const next = readOptionValue(args, index, '--invite-url');
      options.inviteUrl = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(args, index, '--endpoint');
      options.endpoint = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')
      || token === '--id' || token.startsWith('--id=')) {
      const flag = token.startsWith('--id') ? '--id' : '--node-id';
      const next = readOptionValue(args, index, flag);
      options.nodeId = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--repo-url' || token.startsWith('--repo-url=')) {
      const next = readOptionValue(args, index, '--repo-url');
      options.repoUrl = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--repo-dir' || token.startsWith('--repo-dir=')) {
      const next = readOptionValue(args, index, '--repo-dir');
      options.repoDir = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--repo-subdir' || token.startsWith('--repo-subdir=')) {
      const next = readOptionValue(args, index, '--repo-subdir');
      options.repoSubdir = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--transport' || token.startsWith('--transport=')
      || token === '--transport-kind' || token.startsWith('--transport-kind=')) {
      const flag = token.startsWith('--transport-kind') ? '--transport-kind' : '--transport';
      const next = readOptionValue(args, index, flag);
      options.transportKind = next.value;
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.controlUrl) {
      const error = new Error('too_many_control_urls');
      error.code = 'too_many_control_urls';
      throw error;
    }
    options.controlUrl = token;
    index += 1;
  }

  options.target = normalizeBootstrapTarget(options.target);
  options.channel = normalizeBootstrapChannel(options.channel, options.target);
  options.controlUrl = normalizeHttpUrl(options.controlUrl, 'invalid_control_url');
  options.inviteUrl = normalizeHttpUrl(options.inviteUrl, 'invalid_invite_url');
  options.endpoint = normalizeHttpUrl(options.endpoint, 'invalid_endpoint');
  options.transportKind = normalizeBootstrapTransport(options.transportKind);
  options.nodeId = normalizeId(options.nodeId);
  options.repoUrl = nonEmptyString(options.repoUrl);
  options.repoDir = nonEmptyString(options.repoDir);
  options.repoSubdir = normalizeRepoSubdir(options.repoSubdir);

  return options;
}

function normalizeBootstrapTarget(value) {
  const target = nonEmptyString(value || process.platform).toLowerCase();
  if (SUPPORTED_BOOTSTRAP_TARGETS.includes(target)) return target;
  const error = new Error(`unsupported_bootstrap_target:${target || 'unknown'}`);
  error.code = 'unsupported_bootstrap_target';
  error.target = target;
  throw error;
}

function normalizeBootstrapChannel(value, target) {
  const channel = nonEmptyString(value).toLowerCase();
  if (channel) return channel;
  return target === 'win32' ? 'local-manual' : 'ssh';
}

function normalizeBootstrapTransport(value) {
  const kind = normalizeTransportKind(value || DEFAULT_TRANSPORT_KIND);
  if (kind) return kind;
  const error = new Error('invalid_transport_kind');
  error.code = 'invalid_transport_kind';
  throw error;
}

function placeholder(name) {
  return `<${name}>`;
}

function defaultRepoDir(target, repoSubdir) {
  const subdir = getDefaultRepoSubdir(repoSubdir);
  if (target === 'win32') return `Join-Path $env:USERPROFILE ${quotePowerShell(toWindowsRepoSubdir(subdir))}`;
  return `"$HOME/${subdir}"`;
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function transportNeedsEndpoint(kind) {
  return kind !== 'relay';
}

function buildJoinCommand(options, nodeId = options.nodeId) {
  const inviteUrl = options.inviteUrl || placeholder('invite-url');
  const args = ['aih', 'node', 'join', inviteUrl, '--transport', options.transportKind];
  if (options.endpoint) args.push('--endpoint', options.endpoint);
  if (nodeId) args.push('--node-id', nodeId);
  return args;
}

function formatNodeJoinCommand(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const target = normalizeBootstrapTarget(source.target || 'linux');
  const options = {
    inviteUrl: normalizeHttpUrl(source.inviteUrl, 'invalid_invite_url'),
    endpoint: nonEmptyString(source.endpoint) ? normalizeHttpUrl(source.endpoint, 'invalid_endpoint') : '',
    nodeId: normalizeId(source.nodeId),
    transportKind: normalizeBootstrapTransport(source.transportKind || DEFAULT_TRANSPORT_KIND)
  };
  const args = buildJoinCommand(options);
  return target === 'win32' ? powerShellCommand(args) : shellCommand(args);
}

function buildRelayServiceCommand(options, nodeId = options.nodeId || placeholder('node-id')) {
  const controlUrl = options.controlUrl || placeholder('control-url');
  return ['aih', 'node', 'relay', 'service', 'install', controlUrl, '--node-id', nodeId];
}

function buildDoctorCommand(options, nodeId = options.nodeId) {
  const args = ['aih', 'node', 'doctor'];
  if (options.controlUrl) args.push('--control-url', options.controlUrl);
  if (nodeId) args.push('--node-id', nodeId);
  return args;
}

function shellCommand(args) {
  return args.map(quoteShell).join(' ');
}

function powerShellCommand(args) {
  return `& ${args.map(quotePowerShell).join(' ')}`;
}

function shellCommandWithNodeId(args, nodeIdVariable, explicitNodeId) {
  const prefix = shellCommand(args.concat('--node-id'));
  return `${prefix} ${explicitNodeId ? quoteShell(explicitNodeId) : nodeIdVariable}`;
}

function powerShellCommandWithNodeId(args, nodeIdVariable, explicitNodeId) {
  const prefix = powerShellCommand(args.concat('--node-id'));
  return `${prefix} ${explicitNodeId ? quotePowerShell(explicitNodeId) : nodeIdVariable}`;
}

function buildScriptJoinCommand(options, target) {
  const inviteUrl = options.inviteUrl || placeholder('invite-url');
  const args = ['aih', 'node', 'join', inviteUrl, '--transport', options.transportKind];
  if (options.endpoint) args.push('--endpoint', options.endpoint);
  if (target === 'win32') return powerShellCommandWithNodeId(args, '$AihNodeId', options.nodeId);
  return shellCommandWithNodeId(args, '"$AIH_NODE_ID"', options.nodeId);
}

function buildScriptDoctorCommand(options, target) {
  const args = ['aih', 'node', 'doctor'];
  if (options.controlUrl) args.push('--control-url', options.controlUrl);
  if (target === 'win32') return powerShellCommandWithNodeId(args, '$AihNodeId', options.nodeId);
  return shellCommandWithNodeId(args, '"$AIH_NODE_ID"', options.nodeId);
}

function buildScriptRelayServiceCommand(options, target) {
  const controlUrl = options.controlUrl || placeholder('control-url');
  const args = ['aih', 'node', 'relay', 'service', 'install', controlUrl];
  if (target === 'win32') return powerShellCommandWithNodeId(args, '$AihNodeId', options.nodeId);
  return shellCommandWithNodeId(args, '"$AIH_NODE_ID"', options.nodeId);
}

function buildScriptDoctorJsonCommand(options, target) {
  const args = ['aih', 'node', 'doctor', '--json'];
  if (options.controlUrl) args.push('--control-url', options.controlUrl);
  if (target === 'win32') return powerShellCommandWithNodeId(args, '$AihNodeId', options.nodeId);
  return shellCommandWithNodeId(args, '"$AIH_NODE_ID"', options.nodeId);
}

function buildShellDoctorPreflight(options) {
  const command = buildScriptDoctorJsonCommand(options, options.target);
  return `AIH_DOCTOR_JSON="$(${command})"
printf '%s\\n' "$AIH_DOCTOR_JSON" | node -e 'const chunks=[];process.stdin.on("data",(c)=>chunks.push(c));process.stdin.on("end",()=>{const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));const report=data.report||{};const issues=Array.isArray(report.issues)?report.issues:[];const blockers=issues.filter((issue)=>issue&&issue.severity==="blocker");if(blockers.length){console.error("AIH node preflight failed: "+blockers.map((issue)=>[issue.code,issue.message].filter(Boolean).join(" - ")).join("; "));process.exit(1);}});'
`;
}

function buildPowerShellDoctorPreflight(options) {
  const command = buildScriptDoctorJsonCommand(options, options.target);
  return `$AihPreflight = ${command} | ConvertFrom-Json
$AihBlockers = @($AihPreflight.report.issues | Where-Object { $_.severity -eq 'blocker' })
if ($AihBlockers.Count -gt 0) {
  $AihBlockerText = ($AihBlockers | ForEach-Object { "$($_.code) - $($_.message)" }) -join '; '
  throw "AIH node preflight failed: $AihBlockerText"
}
`;
}

function buildShellEnsureManagementKeyBlock(options) {
  return `node <<'NODE'
${buildEnsureManagementKeyNodeScript(buildBootstrapServerConfigOptions(options))}NODE
`;
}

function buildPowerShellEnsureManagementKeyBlock(options) {
  const encoded = Buffer.from(
    buildEnsureManagementKeyNodeScript(buildBootstrapServerConfigOptions(options)),
    'utf16le'
  ).toString('base64');
  return `$AihManagementKeyScript = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
$AihManagementKeyScript | node
`;
}

function resolveRequiredInputs(options) {
  const required = [];
  if (!options.controlUrl) required.push('control-url');
  if (!options.inviteUrl) required.push('invite-url');
  if (transportNeedsEndpoint(options.transportKind) && !options.endpoint) required.push('endpoint');
  if (!options.repoUrl) required.push('repo-url');
  return required;
}

function buildShellScript(options) {
  const repoDirDefault = options.repoDir ? quoteShell(options.repoDir) : defaultRepoDir(options.target, options.repoSubdir);
  const repoUrl = options.repoUrl || placeholder('repo-url');
  const joinCommand = buildScriptJoinCommand(options, options.target);
  const doctorCommand = buildScriptDoctorCommand(options, options.target);
  const doctorPreflight = buildShellDoctorPreflight(options);
  const serviceCommand = buildScriptRelayServiceCommand(options, options.target);
  const installService = options.installService ? `${serviceCommand}\n` : '';
  const packageInstall = options.target === 'darwin'
    ? buildMacPackageInstallBlock()
    : buildLinuxPackageInstallBlock();

  return `#!/usr/bin/env sh
set -eu

AIH_REPO_URL=\${AIH_REPO_URL:-${quoteShell(repoUrl)}}
AIH_REPO_DIR=\${AIH_REPO_DIR:-${repoDirDefault}}

${packageInstall}

if [ ! -d "$AIH_REPO_DIR/.git" ]; then
  git clone "$AIH_REPO_URL" "$AIH_REPO_DIR"
else
  git -C "$AIH_REPO_DIR" pull --ff-only
fi

cd "$AIH_REPO_DIR"
npm install
npm link

${buildShellEnsureManagementKeyBlock(options)}
aih server start >/dev/null 2>&1 || true

AIH_NODE_ID=\${AIH_NODE_ID:-${quoteShell(options.nodeId)}}
if [ -z "$AIH_NODE_ID" ]; then
  AIH_NODE_ID="$(aih node doctor --json | node -e 'const chunks=[];process.stdin.on("data",(c)=>chunks.push(c));process.stdin.on("end",()=>{const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));process.stdout.write(String(data.report&&data.report.node&&data.report.node.id||""));});')"
fi
if [ -z "$AIH_NODE_ID" ]; then
  echo "AIH_NODE_ID could not be resolved." >&2
  exit 1
fi
export AIH_NODE_ID

${doctorPreflight}
${doctorCommand}
${joinCommand}
${installService}`;
}

function buildLinuxPackageInstallBlock() {
  return `if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y nodejs npm git
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm git
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y nodejs npm git
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y nodejs npm git
  else
    echo "Install node, npm, and git first, then rerun this script." >&2
    exit 1
  fi
fi`;
}

function buildMacPackageInstallBlock() {
  return `install_aih_user_node_lts() {
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    mkdir -p "$NVM_DIR"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null sh
  fi
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
}

if ! command -v git >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install git
  else
    echo "Install Git or Apple Command Line Tools first, then rerun this script." >&2
    exit 1
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install node
  elif install_aih_user_node_lts; then
    :
  else
    echo "Install Homebrew or curl first, then rerun this script." >&2
    exit 1
  fi
fi`;
}

function buildPowerShellScript(options) {
  const repoDirExpression = options.repoDir ? quotePowerShell(options.repoDir) : defaultRepoDir('win32', options.repoSubdir);
  const repoUrl = options.repoUrl || placeholder('repo-url');
  const joinCommand = buildScriptJoinCommand(options, options.target);
  const doctorCommand = buildScriptDoctorCommand(options, options.target);
  const doctorPreflight = buildPowerShellDoctorPreflight(options);
  const serviceCommand = buildScriptRelayServiceCommand(options, options.target);
  const installService = options.installService ? `${serviceCommand}\n` : '';

  return `$ErrorActionPreference = 'Stop'

$AihRepoUrl = if ($env:AIH_REPO_URL) { $env:AIH_REPO_URL } else { ${quotePowerShell(repoUrl)} }
$AihRepoDir = if ($env:AIH_REPO_DIR) { $env:AIH_REPO_DIR } else { ${repoDirExpression} }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  winget install --id Git.Git --exact --accept-package-agreements --accept-source-agreements
}
$env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')

if (-not (Test-Path (Join-Path $AihRepoDir '.git'))) {
  git clone $AihRepoUrl $AihRepoDir
} else {
  git -C $AihRepoDir pull --ff-only
}

Set-Location $AihRepoDir
npm install
npm link

${buildPowerShellEnsureManagementKeyBlock(options)}
try { & aih server start *> $null } catch {}

$AihNodeId = if ($env:AIH_NODE_ID) { $env:AIH_NODE_ID } else { ${quotePowerShell(options.nodeId)} }
if (-not $AihNodeId) {
  $AihDoctor = & aih node doctor --json | ConvertFrom-Json
  $AihNodeId = [string]$AihDoctor.report.node.id
}
if (-not $AihNodeId) {
  throw 'AIH_NODE_ID could not be resolved.'
}
$env:AIH_NODE_ID = $AihNodeId

${doctorPreflight}
${doctorCommand}
${joinCommand}
${installService}`;
}

function buildBootstrapScript(options) {
  if (options.target === 'win32') {
    return {
      type: 'powershell',
      command: 'powershell -ExecutionPolicy Bypass -File .\\aih-node-bootstrap.ps1',
      content: buildPowerShellScript(options)
    };
  }
  return {
    type: 'sh',
    command: 'sh ./aih-node-bootstrap.sh',
    content: buildShellScript(options)
  };
}

function buildBootstrapPrerequisites(target) {
  if (target === 'win32') {
    return [
      'local console access to run the PowerShell script when SSH/WinRM is not available',
      'winget access for Node.js LTS and Git installation',
      'target AI Home server has a configured management key before join',
      'outbound HTTPS/WebSocket access to the Control Plane'
    ];
  }
  if (target === 'darwin') {
    return [
      'SSH or local console access to run the shell script',
      'Homebrew or curl-based user-local Node.js install when Node.js is missing',
      'Git or Apple Command Line Tools before cloning the repository',
      'target AI Home server has a configured management key before join',
      'outbound HTTPS/WebSocket access to the Control Plane'
    ];
  }
  return [
    'SSH or local console access to run the shell script',
    'sudo access to install nodejs, npm, and git when missing',
    'target AI Home server has a configured management key before join',
    'outbound HTTPS/WebSocket access to the Control Plane'
  ];
}

function buildBootstrapWarnings(options) {
  const warnings = [];
  const controlUrlWarning = getLoopbackControlUrlWarning(options.controlUrl);
  if (controlUrlWarning) warnings.push(controlUrlWarning);
  if (options.target === 'win32' && options.channel === 'local-manual') {
    warnings.push('Windows SSH/WinRM is not assumed; use local console access for the first run.');
  }
  if (!options.repoUrl) {
    warnings.push('repo-url is a placeholder; set --repo-url or export AIH_REPO_URL before running the script.');
  }
  if (!options.inviteUrl) {
    warnings.push('invite-url is a placeholder; generate an invite on the Control Plane before running join.');
  }
  if (!options.nodeId) {
    warnings.push('node-id is omitted; the script will derive a stable id on the target machine.');
  }
  if (transportNeedsEndpoint(options.transportKind) && !options.endpoint) {
    warnings.push(`${options.transportKind} transport needs --endpoint with a Control Plane reachable http(s) URL.`);
  }
  if (transportNeedsEndpoint(options.transportKind)) {
    warnings.push(`${options.transportKind} is treated as an external data-plane; AI Home records it but does not install FRP/VPN/OMR/MPTCP/SSH tooling.`);
  }
  return warnings;
}

function buildTransportGuidance(kind) {
  const guidance = {
    relay: [
      'Lowest-configuration default for no-public-IP machines.',
      'Only outbound HTTPS/WebSocket access from node to Control Plane is required.',
      'AIH Relay is the managed data-plane.'
    ],
    frp: [
      'Run and verify your FRP client/server first.',
      'Pass --endpoint with the HTTP URL exposed by FRP for this node server.'
    ],
    ssh: [
      'Use SSH as a parallel bootstrap/probe channel, or build a reverse/forward tunnel yourself.',
      'Pass --endpoint with the HTTP URL the Control Plane can reach through that tunnel.'
    ],
    tailscale: [
      'Install and authenticate the overlay first on both sides.',
      'Pass --endpoint with the node server URL on the Tailscale address.'
    ],
    zerotier: [
      'Join the same ZeroTier network and verify IP routing first.',
      'Pass --endpoint with the node server URL on the ZeroTier address.'
    ],
    wireguard: [
      'Bring up WireGuard and verify routing first.',
      'Pass --endpoint with the node server URL on the WireGuard address.'
    ],
    omr: [
      'OpenMPTCPRouter is treated as an underlay route provider, not managed by AI Home.',
      'Pass --endpoint with the stable URL reachable through OMR.'
    ],
    mptcp: [
      'MPTCP is treated as an underlay transport optimization, not managed by AI Home.',
      'Pass --endpoint with the stable URL reachable over that path.'
    ],
    direct: [
      'Use only when the Control Plane can reach the node server directly.',
      'Pass --endpoint with a stable public/LAN URL.'
    ]
  };
  return guidance[kind] || guidance.relay;
}

function buildReadinessChecks(options) {
  return [
    {
      id: 'target-node-identity',
      required: true,
      status: options.nodeId ? 'provided' : 'target-derived',
      message: options.nodeId
        ? 'The bootstrap script will use the provided node id.'
        : 'The bootstrap script will derive a stable node id from the target machine.'
    },
    {
      id: 'target-management-key',
      required: true,
      status: 'checked-by-script',
      message: 'The bootstrap script runs node doctor preflight and stops before join/service install when the target server management key is missing.'
    },
    {
      id: 'control-endpoint',
      required: true,
      status: options.controlUrl ? 'provided' : 'placeholder',
      message: options.controlUrl
        ? 'Control Plane URL is embedded without secrets.'
        : 'Provide a reachable Control Plane URL before running the script.'
    },
    {
      id: 'persistent-relay-service',
      required: Boolean(options.installService),
      status: options.installService ? 'planned' : 'disabled',
      message: options.installService
        ? 'Relay service install reads the management key from local server config and never stores it in startup files.'
        : 'Persistent relay service install is disabled for this plan.'
    }
  ];
}

function relayServiceStepTitle(kind) {
  return kind === 'relay'
    ? 'Install persistent outbound relay'
    : 'Install optional outbound relay fallback';
}

function buildNodeBootstrapPlan(input = {}, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const processObj = deps.processObj || process;
  const target = normalizeBootstrapTarget(source.target || processObj.platform);
  const options = {
    target,
    channel: normalizeBootstrapChannel(source.channel, target),
    controlUrl: normalizeHttpUrl(source.controlUrl, 'invalid_control_url'),
    inviteUrl: normalizeHttpUrl(source.inviteUrl, 'invalid_invite_url'),
    endpoint: normalizeHttpUrl(source.endpoint, 'invalid_endpoint'),
    nodeId: normalizeId(source.nodeId),
    repoUrl: nonEmptyString(source.repoUrl),
    repoDir: nonEmptyString(source.repoDir),
    repoSubdir: normalizeRepoSubdir(source.repoSubdir),
    transportKind: normalizeBootstrapTransport(source.transportKind || DEFAULT_TRANSPORT_KIND),
    installService: source.installService !== false,
    scriptOnly: source.scriptOnly === true
  };
  const script = buildBootstrapScript(options);
  const planNodeId = options.nodeId || placeholder('target-derived-node-id');
  const joinCommand = options.target === 'win32'
    ? powerShellCommand(buildJoinCommand(options, planNodeId))
    : shellCommand(buildJoinCommand(options, planNodeId));
  const doctorCommand = options.target === 'win32'
    ? powerShellCommand(buildDoctorCommand(options, planNodeId))
    : shellCommand(buildDoctorCommand(options, planNodeId));
  const serviceCommand = options.target === 'win32'
    ? powerShellCommand(buildRelayServiceCommand(options, planNodeId))
    : shellCommand(buildRelayServiceCommand(options, planNodeId));

  return {
    ok: true,
    target: options.target,
    channel: options.channel,
    transportKind: options.transportKind,
    requiredInputs: resolveRequiredInputs(options),
    prerequisites: buildBootstrapPrerequisites(options.target),
    readinessChecks: buildReadinessChecks(options),
    transportGuidance: buildTransportGuidance(options.transportKind),
    warnings: buildBootstrapWarnings(options),
    steps: [
      {
        id: 'open-bootstrap-channel',
        title: options.target === 'win32' ? 'Open local Windows console' : 'Open SSH or local console',
        command: options.target === 'win32' ? 'copy and run the PowerShell script on the target' : 'ssh <user>@<host>'
      },
      {
        id: 'run-bootstrap-script',
        title: 'Run bootstrap script on the target machine',
        command: script.command
      },
      {
        id: 'verify-node-readiness',
        title: 'Verify local node readiness before join',
        command: doctorCommand
      },
      {
        id: 'join-node',
        title: 'Join this machine to the Control Plane',
        command: joinCommand
      },
      {
        id: 'install-relay-service',
        title: relayServiceStepTitle(options.transportKind),
        command: options.installService ? serviceCommand : ''
      }
    ].filter((step) => step.command),
    script,
    security: {
      containsSecrets: false,
      notes: [
        'The script intentionally does not include node management secrets or device tokens.',
        'Invite URLs are single-use bootstrap material; regenerate if exposed.',
        'Local manual bootstrap only prepares the node; AIH Relay or a real HTTP transport carries the data-plane.'
      ]
    }
  };
}

function formatNodeBootstrapPlan(plan) {
  const lines = [
    '[aih] node bootstrap plan',
    `[aih] target: ${plan.target}`,
    `[aih] bootstrap channel: ${plan.channel}`,
    `[aih] transport: ${plan.transportKind}`,
    `[aih] secrets in script: ${plan.security.containsSecrets ? 'yes' : 'no'}`
  ];

  if (plan.requiredInputs.length) {
    lines.push('[aih] required inputs:');
    plan.requiredInputs.forEach((item) => lines.push(`  - ${item}`));
  }

  if (plan.prerequisites.length) {
    lines.push('[aih] prerequisites:');
    plan.prerequisites.forEach((item) => lines.push(`  - ${item}`));
  }

  if (Array.isArray(plan.readinessChecks) && plan.readinessChecks.length) {
    lines.push('[aih] readiness checks:');
    plan.readinessChecks.forEach((item) => {
      lines.push(`  - ${item.id}: ${item.status} - ${item.message}`);
    });
  }

  if (plan.transportGuidance.length) {
    lines.push('[aih] transport guidance:');
    plan.transportGuidance.forEach((item) => lines.push(`  - ${item}`));
  }

  if (plan.warnings.length) {
    lines.push('[aih] warnings:');
    plan.warnings.forEach((item) => lines.push(`  - ${item}`));
  }

  lines.push('[aih] steps:');
  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.title}`);
    lines.push(`     ${step.command}`);
  });

  lines.push(`[aih] ${plan.script.type} script:`);
  lines.push(plan.script.content.trimEnd());
  return lines.join('\n');
}

function runNodeBootstrap(rawArgs = [], deps = {}) {
  const options = parseNodeBootstrapArgs(rawArgs);
  const plan = buildNodeBootstrapPlan(options, deps);
  return {
    ok: true,
    json: Boolean(options.json),
    scriptOnly: Boolean(options.scriptOnly),
    plan
  };
}

module.exports = {
  SUPPORTED_BOOTSTRAP_TARGETS,
  getLoopbackControlUrlWarning,
  parseNodeBootstrapArgs,
  formatNodeJoinCommand,
  buildNodeBootstrapPlan,
  formatNodeBootstrapPlan,
  runNodeBootstrap
};
