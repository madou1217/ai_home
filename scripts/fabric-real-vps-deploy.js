#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_PORT = 9527;
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const EXCLUDES = [
  '.git',
  'node_modules',
  'web/node_modules',
  'tmp',
  'output',
  'logs',
  '*.log',
  '*.db',
  '*.db-shm',
  '*.db-wal'
];

function showHelp() {
  console.log(`AIH Fabric real VPS deploy

Usage:
  node scripts/fabric-real-vps-deploy.js --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com --ssh-key ~/.ssh/aws.pem --remote-dir /home/ubuntu/aih-fabric-current --node-runtime tmp/node-v22.16.0-linux-x64.tar.xz --skip-import --skip-start

Options:
  --ssh <user@host>       Required SSH target.
  --ssh-key <pem>         Optional identity file for ssh/scp.
  --accounts <zip>        Real account export zip from "aih export"; required unless --skip-import is set.
  --remote-dir <path>     Remote deployment directory, default ${DEFAULT_REMOTE_DIR}.
  --node-runtime <tar.xz>  Optional Linux Node.js runtime archive to unpack under remote-dir.
  --port <n>              Temporary server port, default ${DEFAULT_PORT}.
  --broker-token-file <path>
                          Remote file containing AIH_FABRIC_BROKER_TOKEN for broker control links.
  --source-transfer <mode> Source transfer mode: cache or stream, default cache.
  --no-source-cache        Alias for --source-transfer stream.
  --skip-build            Do not run local npm run web:build.
  --skip-import           Transfer only; do not run remote aih import.
  --skip-start            Do not start the temporary remote server.
  --dry-run               Print steps without executing them.
  -h, --help              Show this help.

This script is intentionally conservative: it does not install systemd units,
does not edit firewall rules, does not install system packages, and does not
delete remote directories.
`);
}

function parseArgs(argv) {
  const options = {
    sshTarget: '',
    sshKey: '',
    accountsZip: '',
    nodeRuntimeArchive: '',
    remoteDir: DEFAULT_REMOTE_DIR,
    port: DEFAULT_PORT,
    brokerTokenFile: '',
    skipBuild: false,
    skipImport: false,
    skipStart: false,
    sourceTransfer: 'cache',
    dryRun: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--ssh') {
      if (!next) throw new Error('--ssh requires a value');
      options.sshTarget = next;
      index += 1;
      continue;
    }
    if (arg === '--ssh-key') {
      if (!next) throw new Error('--ssh-key requires a value');
      options.sshKey = path.resolve(String(next).replace(/^~(?=\/|$)/, process.env.HOME || ''));
      index += 1;
      continue;
    }
    if (arg === '--accounts') {
      if (!next) throw new Error('--accounts requires a value');
      options.accountsZip = next;
      index += 1;
      continue;
    }
    if (arg === '--node-runtime') {
      if (!next) throw new Error('--node-runtime requires a value');
      options.nodeRuntimeArchive = next;
      index += 1;
      continue;
    }
    if (arg === '--remote-dir') {
      if (!next) throw new Error('--remote-dir requires a value');
      options.remoteDir = next;
      index += 1;
      continue;
    }
    if (arg === '--port') {
      if (!next) throw new Error('--port requires a value');
      const port = Number(next);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid --port');
      options.port = port;
      index += 1;
      continue;
    }
    if (arg === '--broker-token-file' || arg.startsWith('--broker-token-file=')) {
      if (arg.startsWith('--broker-token-file=')) {
        options.brokerTokenFile = arg.slice('--broker-token-file='.length);
        continue;
      }
      if (!next) throw new Error('--broker-token-file requires a value');
      options.brokerTokenFile = next;
      index += 1;
      continue;
    }
    if (arg === '--source-transfer') {
      if (!next) throw new Error('--source-transfer requires a value');
      const mode = String(next).trim();
      if (mode !== 'cache' && mode !== 'stream') throw new Error('--source-transfer must be cache or stream');
      options.sourceTransfer = mode;
      index += 1;
      continue;
    }
    if (arg === '--no-source-cache') {
      options.sourceTransfer = 'stream';
      continue;
    }
    if (arg === '--skip-build') {
      options.skipBuild = true;
      continue;
    }
    if (arg === '--skip-import') {
      options.skipImport = true;
      continue;
    }
    if (arg === '--skip-start') {
      options.skipStart = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (options.help) return options;
  if (!options.sshTarget) throw new Error('--ssh is required');
  if (options.sshKey && !fs.existsSync(options.sshKey)) throw new Error(`ssh key not found: ${options.sshKey}`);
  if (!options.skipImport && !options.accountsZip) throw new Error('--accounts is required unless --skip-import is set');
  if (options.accountsZip && !fs.existsSync(options.accountsZip)) throw new Error(`accounts zip not found: ${options.accountsZip}`);
  if (options.nodeRuntimeArchive && !fs.existsSync(options.nodeRuntimeArchive)) {
    throw new Error(`node runtime archive not found: ${options.nodeRuntimeArchive}`);
  }
  if (options.nodeRuntimeArchive && !/\.tar\.xz$/i.test(options.nodeRuntimeArchive)) {
    throw new Error('--node-runtime must be a .tar.xz archive');
  }
  if (!path.isAbsolute(options.remoteDir)) throw new Error('--remote-dir must be absolute');
  if (options.brokerTokenFile && !path.posix.isAbsolute(options.brokerTokenFile)) {
    throw new Error('--broker-token-file must be an absolute remote path');
  }
  return options;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function log(step, message) {
  console.log(`[fabric-real-vps-deploy] ${step}: ${message}`);
}

function run(command, args, options = {}) {
  if (options.dryRun) {
    log('dry-run', [command, ...args].join(' '));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit'
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${status}${signal ? ` signal=${signal}` : ''}`));
    });
  });
}

function runSsh(options, remoteCommand) {
  return run('ssh', [
    ...buildSshArgs(options),
    options.sshTarget,
    remoteCommand
  ], { dryRun: options.dryRun });
}

function buildSshArgs(options) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...(options.sshKey ? ['-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-i', options.sshKey] : [])
  ];
}

function trimNodeArchiveSuffix(fileName) {
  return String(fileName || '').replace(/\.tar\.xz$/i, '');
}

function getRemoteNodeHome(options) {
  if (!options.nodeRuntimeArchive) return '';
  return path.posix.join(
    options.remoteDir,
    '.node-runtime',
    trimNodeArchiveSuffix(path.basename(options.nodeRuntimeArchive))
  );
}

function getRemoteRuntimeCacheArchive(options) {
  if (!options.nodeRuntimeArchive) return '';
  return path.posix.join(
    path.posix.dirname(options.remoteDir),
    '.aih-node-runtime-cache',
    path.basename(options.nodeRuntimeArchive)
  );
}

function getRemoteHostHome(options) {
  return path.posix.join(options.remoteDir, '.aih-host-home');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256Files(filePaths) {
  const hash = crypto.createHash('sha256');
  filePaths.forEach((filePath) => {
    hash.update(path.basename(filePath));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  });
  return hash.digest('hex');
}

function getLocalDependencyCacheKey(cwd = process.cwd()) {
  return sha256Files([
    path.join(cwd, 'package.json'),
    path.join(cwd, 'package-lock.json')
  ]).slice(0, 16);
}

function getRemoteDependencyCacheDir(options, cacheKey) {
  return path.posix.join(
    path.posix.dirname(options.remoteDir),
    '.aih-node-modules-cache',
    cacheKey
  );
}

function getRemoteSourceCacheDir(options) {
  return path.posix.join(
    path.posix.dirname(options.remoteDir),
    '.aih-source-cache'
  );
}

function getRemoteSourceCacheArchive(options, sourceSha256) {
  const hash = String(sourceSha256 || '').trim();
  if (!hash) return '';
  return path.posix.join(
    getRemoteSourceCacheDir(options),
    `source-${hash}.tar.gz`
  );
}

function buildRemoteEnvPrefix(options) {
  return `${buildRemoteEnvCommand(options)}; `;
}

function buildRemoteEnvCommand(options) {
  const remoteHostHome = getRemoteHostHome(options);
  const nodeHome = getRemoteNodeHome(options);
  const commands = [
    `mkdir -p ${shQuote(remoteHostHome)}`,
    `export AIH_HOST_HOME=${shQuote(remoteHostHome)}`
  ];
  if (options.brokerTokenFile) {
    commands.push(
      `test -s ${shQuote(options.brokerTokenFile)}`,
      `export AIH_FABRIC_BROKER_TOKEN="$(cat ${shQuote(options.brokerTokenFile)})"`
    );
  }
  if (nodeHome) {
    commands.push(`export PATH=${shQuote(`${nodeHome}/bin`)}:${shQuote(path.posix.join(options.remoteDir, 'node_modules', '.bin'))}:$PATH`);
  }
  return commands.join(' && ');
}

function buildRemoteNodeCommand(options, command) {
  return `${buildRemoteEnvPrefix(options)}${command}`;
}

function buildRemoteStartCommand(options, remoteLog, remotePid) {
  const stopPrevious = `if [ -f ${shQuote(remotePid)} ]; then old_pid=$(cat ${shQuote(remotePid)} 2>/dev/null || true); if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then kill "$old_pid"; sleep 2; fi; fi`;
  const stopStaleServer = [
    `server_pids=$(ps -axo pid=,command= | awk -v port=${shQuote(`--port ${options.port}`)} '$2 ~ /(^|\\/)node$/ && $0 ~ /bin\\/ai-home\\.js server serve/ && index($0, port) { print $1 }')`,
    `if [ -n "$server_pids" ]; then kill $server_pids; sleep 2; fi`,
    `if ss -lntp 2>/dev/null | grep -q ${shQuote(`:${options.port}`)}; then echo ${shQuote(`port_${options.port}_still_in_use`)} >&2; ss -lntp 2>/dev/null | grep ${shQuote(`:${options.port}`)} >&2 || true; exit 91; fi`
  ].join('; ');
  const launch = [
    `AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1 AIH_SERVER_STRICT_PORT=1 nohup node bin/ai-home.js server serve --host 0.0.0.0 --port ${options.port} > ${shQuote(remoteLog)} 2>&1 & new_pid=$!`,
    `echo "$new_pid" > ${shQuote(remotePid)}`,
    'sleep 2',
    `if ! kill -0 "$new_pid" 2>/dev/null; then tail -80 ${shQuote(remoteLog)} || true; exit 92; fi`,
    `if grep -q 'server serve failed' ${shQuote(remoteLog)} 2>/dev/null; then tail -80 ${shQuote(remoteLog)} || true; exit 93; fi`,
    `ready=0; for _ in 1 2 3 4 5; do if curl --noproxy '*' -fsS --max-time 5 ${shQuote(`http://127.0.0.1:${options.port}/readyz`)} >/dev/null; then ready=1; break; fi; sleep 1; done; if [ "$ready" != "1" ]; then tail -80 ${shQuote(remoteLog)} || true; exit 94; fi`
  ].join('; ');
  return [
    `cd ${shQuote(options.remoteDir)}`,
    buildRemoteEnvCommand(options),
    stopPrevious,
    stopStaleServer,
    `( ${launch} )`,
    `cat ${shQuote(remotePid)}`,
    `tail -40 ${shQuote(remoteLog)} || true`
  ].filter(Boolean).join(' && ');
}

function buildRemoteNodeProbeCommand(options) {
  const fallback = options.nodeRuntimeArchive
    ? 'echo node-runtime-archive-selected'
    : 'echo missing_node_runtime >&2; exit 86';
  return [
    'echo ssh-ok',
    `if command -v node >/dev/null 2>&1; then command -v node && node --version; else ${fallback}; fi`,
    `if command -v npm >/dev/null 2>&1; then command -v npm && npm --version; else ${fallback}; fi`
  ].join(' && ');
}

function buildRemoteRuntimeInstallCommand(options, remoteArchive) {
  const nodeHome = getRemoteNodeHome(options);
  if (!nodeHome) return '';
  return [
    `if [ -x ${shQuote(path.posix.join(nodeHome, 'bin', 'node'))} ] && [ -x ${shQuote(path.posix.join(nodeHome, 'bin', 'npm'))} ]; then echo node-runtime-ready; else mkdir -p ${shQuote(path.posix.dirname(nodeHome))} && tar -xJf ${shQuote(remoteArchive)} -C ${shQuote(path.posix.dirname(nodeHome))}; fi`,
    buildRemoteNodeCommand(options, 'node --version')
  ].join(' && ');
}

function buildRemoteRuntimeCacheProbeCommand(remoteArchive, expectedSha256) {
  return [
    `if [ ! -f ${shQuote(remoteArchive)} ]; then echo node-runtime-cache-miss; exit 75; fi`,
    'if ! command -v sha256sum >/dev/null 2>&1; then echo node-runtime-cache-unverified; exit 75; fi',
    `test "$(sha256sum ${shQuote(remoteArchive)} | awk '{print $1}')" = ${shQuote(expectedSha256)}`,
    'echo node-runtime-cache-hit'
  ].join(' && ');
}

function buildRemoteDependencyInstallCommand(options, cacheDir) {
  const cachedNodeModules = path.posix.join(cacheDir, 'node_modules');
  const npmCache = path.posix.join(path.posix.dirname(options.remoteDir), '.aih-npm-cache');
  return [
    `mkdir -p ${shQuote(cacheDir)} ${shQuote(npmCache)}`,
    [
      `if [ -d ${shQuote(cachedNodeModules)} ]; then`,
      `if [ ! -e node_modules ]; then ln -s ${shQuote(cachedNodeModules)} node_modules; fi;`,
      'echo node-modules-cache-hit;',
      'else',
      `npm install --ignore-scripts --cache ${shQuote(npmCache)} &&`,
      `mv node_modules ${shQuote(cachedNodeModules)} &&`,
      `ln -s ${shQuote(cachedNodeModules)} node_modules &&`,
      'echo node-modules-cache-store;',
      'fi'
    ].join(' ')
  ].join(' && ');
}

async function ensureRemoteNodeRuntimeArchive(options) {
  const remoteArchive = getRemoteRuntimeCacheArchive(options);
  const expectedSha256 = sha256File(options.nodeRuntimeArchive);
  const cacheDir = path.posix.dirname(remoteArchive);

  await runSsh(options, `mkdir -p ${shQuote(cacheDir)}`);
  try {
    await runSsh(options, buildRemoteRuntimeCacheProbeCommand(remoteArchive, expectedSha256));
    log('transfer-node-runtime', `cache hit ${remoteArchive}`);
    return remoteArchive;
  } catch (_error) {
    log('transfer-node-runtime', `${options.nodeRuntimeArchive} -> ${remoteArchive}`);
  }

  await run('scp', [
    ...buildSshArgs(options),
    options.nodeRuntimeArchive,
    `${options.sshTarget}:${remoteArchive}`
  ], { dryRun: options.dryRun });
  await runSsh(options, buildRemoteRuntimeCacheProbeCommand(remoteArchive, expectedSha256));
  return remoteArchive;
}

function buildSourceTarArgs(output = '-') {
  return [
    '--format',
    'ustar',
    '--no-xattrs',
    ...EXCLUDES.flatMap((item) => ['--exclude', item]),
    '-czf',
    output,
    '.'
  ];
}

function buildSourceRawTarArgs(output = '-') {
  return [
    '--format',
    'ustar',
    '--no-xattrs',
    ...EXCLUDES.flatMap((item) => ['--exclude', item]),
    '-cf',
    output,
    '.'
  ];
}

function buildRemoteSourceCacheProbeCommand(remoteArchive, expectedSha256) {
  return [
    `if [ ! -f ${shQuote(remoteArchive)} ]; then echo source-cache-miss; exit 75; fi`,
    'if ! command -v sha256sum >/dev/null 2>&1; then echo source-cache-unverified; exit 75; fi',
    `test "$(sha256sum ${shQuote(remoteArchive)} | awk '{print $1}')" = ${shQuote(expectedSha256)}`,
    'echo source-cache-hit'
  ].join(' && ');
}

function buildRemoteSourceExtractCommand(options, remoteArchive) {
  return [
    `mkdir -p ${shQuote(options.remoteDir)}`,
    `tar -xzf ${shQuote(remoteArchive)} -C ${shQuote(options.remoteDir)}`
  ].join(' && ');
}

function createLocalSourceArchive(cwd = process.cwd()) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-source-'));
  const archivePath = path.join(tmpDir, 'source.tar.gz');
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', buildSourceRawTarArgs('-'), {
      cwd,
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1'
      },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    const gzip = spawn('gzip', ['-n'], {
      stdio: ['pipe', 'pipe', 'inherit']
    });
    const output = fs.createWriteStream(archivePath);
    let settled = false;
    let tarStatus = null;
    let gzipStatus = null;
    let outputFinished = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { tar.kill('SIGTERM'); } catch (_error) {}
      try { gzip.kill('SIGTERM'); } catch (_error) {}
      try { output.destroy(); } catch (_error) {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
      reject(error);
    };
    const maybeDone = () => {
      if (settled || tarStatus === null || gzipStatus === null || !outputFinished) return;
      settled = true;
      if (tarStatus !== 0 || gzipStatus !== 0) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(new Error(`source archive failed: tar=${tarStatus} gzip=${gzipStatus}`));
        return;
      }
      resolve({
        archivePath,
        tmpDir,
        sha256: sha256File(archivePath),
        bytes: fs.statSync(archivePath).size
      });
    };

    tar.on('error', fail);
    gzip.on('error', fail);
    output.on('error', fail);
    tar.stdout.on('error', fail);
    gzip.stdin.on('error', fail);
    gzip.stdout.on('error', fail);
    tar.on('close', (status) => {
      tarStatus = status;
      maybeDone();
    });
    gzip.on('close', (status) => {
      gzipStatus = status;
      maybeDone();
    });
    output.on('finish', () => {
      outputFinished = true;
      maybeDone();
    });

    tar.stdout.pipe(gzip.stdin);
    gzip.stdout.pipe(output);
  });
}

async function copySourceViaCache(options) {
  if (options.dryRun) {
    log('dry-run', `tar source -> remote source cache -> ${shQuote(options.remoteDir)}`);
    return;
  }

  const archive = await createLocalSourceArchive(process.cwd());
  try {
    const remoteArchive = getRemoteSourceCacheArchive(options, archive.sha256);
    const probeCommand = buildRemoteSourceCacheProbeCommand(remoteArchive, archive.sha256);
    await runSsh(options, `mkdir -p ${shQuote(getRemoteSourceCacheDir(options))}`);
    try {
      await runSsh(options, probeCommand);
      log('transfer-source', `cache hit ${remoteArchive}`);
    } catch (_error) {
      log('transfer-source', `upload artifact sha256=${archive.sha256} bytes=${archive.bytes} -> ${remoteArchive}`);
      await run('scp', [
        ...buildSshArgs(options),
        archive.archivePath,
        `${options.sshTarget}:${remoteArchive}`
      ], { dryRun: options.dryRun });
      await runSsh(options, probeCommand);
    }
    await runSsh(options, buildRemoteSourceExtractCommand(options, remoteArchive));
  } finally {
    fs.rmSync(archive.tmpDir, { recursive: true, force: true });
  }
}

function copySourceStream(options) {
  if (options.dryRun) {
    log('dry-run', `tar source | ssh ${options.sshTarget} "tar -xzf - -C ${shQuote(options.remoteDir)}"`);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const tarArgs = buildSourceTarArgs();
    const remoteCommand = `mkdir -p ${shQuote(options.remoteDir)} && tar -xzf - -C ${shQuote(options.remoteDir)}`;
    const tar = spawn('tar', tarArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1'
      },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    const ssh = spawn('ssh', [
      ...buildSshArgs(options),
      options.sshTarget,
      remoteCommand
    ], {
      stdio: ['pipe', 'inherit', 'inherit']
    });

    let settled = false;
    let tarStatus = null;
    let sshStatus = null;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { tar.kill('SIGTERM'); } catch (_error) {}
      try { ssh.kill('SIGTERM'); } catch (_error) {}
      reject(error);
    };
    const maybeDone = () => {
      if (settled || tarStatus === null || sshStatus === null) return;
      settled = true;
      if (tarStatus === 0 && sshStatus === 0) resolve();
      else reject(new Error(`source transfer failed: tar=${tarStatus} ssh=${sshStatus}`));
    };

    tar.on('error', fail);
    ssh.on('error', fail);
    tar.stdout.on('error', fail);
    ssh.stdin.on('error', fail);
    tar.on('close', (status) => {
      tarStatus = status;
      maybeDone();
    });
    ssh.on('close', (status) => {
      sshStatus = status;
      maybeDone();
    });
    tar.stdout.pipe(ssh.stdin);
  });
}

function copySource(options) {
  return options.sourceTransfer === 'stream'
    ? copySourceStream(options)
    : copySourceViaCache(options);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }

  const remoteAccounts = options.accountsZip
    ? path.posix.join(options.remoteDir, path.basename(options.accountsZip))
    : '';
  const remoteLog = path.posix.join(options.remoteDir, 'fabric-server.log');
  const remotePid = path.posix.join(options.remoteDir, 'fabric-server.pid');

  log('target', `${options.sshTarget}:${options.remoteDir}`);
  await runSsh(options, buildRemoteNodeProbeCommand(options));

  if (!options.skipBuild) {
    log('local-build', 'npm run web:build');
    await run('npm', ['run', 'web:build'], { cwd: process.cwd(), dryRun: options.dryRun });
  }

  log('transfer-source', `copy current source and local web/dist to remote mode=${options.sourceTransfer}`);
  await copySource(options);

  if (options.nodeRuntimeArchive) {
    const remoteNodeArchive = await ensureRemoteNodeRuntimeArchive(options);
    log('remote-node-runtime', getRemoteNodeHome(options));
    await runSsh(options, buildRemoteRuntimeInstallCommand(options, remoteNodeArchive));
  }

  if (options.accountsZip) {
    log('transfer-accounts', `${options.accountsZip} -> ${remoteAccounts}`);
    await run('scp', [
      ...buildSshArgs(options),
      options.accountsZip,
      `${options.sshTarget}:${remoteAccounts}`
    ], { dryRun: options.dryRun });
  }

  const dependencyCacheKey = getLocalDependencyCacheKey(process.cwd());
  const dependencyCacheDir = getRemoteDependencyCacheDir(options, dependencyCacheKey);
  log('remote-install', `npm install --ignore-scripts cache=${dependencyCacheKey}`);
  await runSsh(options, `cd ${shQuote(options.remoteDir)} && ${buildRemoteNodeCommand(options, buildRemoteDependencyInstallCommand(options, dependencyCacheDir))}`);

  if (!options.skipImport) {
    log('remote-import', `node bin/ai-home.js import ${remoteAccounts}`);
    await runSsh(options, `cd ${shQuote(options.remoteDir)} && ${buildRemoteNodeCommand(options, `node bin/ai-home.js import ${shQuote(remoteAccounts)}`)}`);
  }

  if (!options.skipStart) {
    const startCommand = buildRemoteStartCommand(options, remoteLog, remotePid);
    log('remote-start', `port=${options.port}`);
    await runSsh(options, startCommand);
  }

  log('done', `remoteDir=${options.remoteDir} port=${options.port}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-real-vps-deploy] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  EXCLUDES,
  buildRemoteEnvCommand,
  buildRemoteEnvPrefix,
  buildRemoteNodeCommand,
  buildRemoteNodeProbeCommand,
  buildRemoteDependencyInstallCommand,
  buildRemoteRuntimeCacheProbeCommand,
  buildRemoteRuntimeInstallCommand,
  buildRemoteSourceCacheProbeCommand,
  buildRemoteSourceExtractCommand,
  buildRemoteStartCommand,
  buildSshArgs,
  buildSourceRawTarArgs,
  buildSourceTarArgs,
  createLocalSourceArchive,
  getRemoteHostHome,
  getRemoteNodeHome,
  getLocalDependencyCacheKey,
  getRemoteDependencyCacheDir,
  getRemoteRuntimeCacheArchive,
  getRemoteSourceCacheArchive,
  getRemoteSourceCacheDir,
  parseArgs,
  sha256File,
  sha256Files,
  shQuote
};
