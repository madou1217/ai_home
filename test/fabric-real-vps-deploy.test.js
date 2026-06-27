'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRemoteEnvCommand,
  buildRemoteDependencyInstallCommand,
  buildRemoteNodeCommand,
  buildRemoteNodeProbeCommand,
  buildRemoteRuntimeCacheProbeCommand,
  buildRemoteRuntimeInstallCommand,
  buildRemoteSourceCacheProbeCommand,
  buildRemoteSourceExtractCommand,
  buildRemoteStartCommand,
  buildSshArgs,
  buildSourceRawTarArgs,
  buildSourceTarArgs,
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
} = require('../scripts/fabric-real-vps-deploy');

test('parseArgs requires ssh target and real account zip for import mode', () => {
  assert.throws(
    () => parseArgs(['--ssh', 'root@example.com']),
    /--accounts is required unless --skip-import is set/
  );
  assert.throws(
    () => parseArgs(['--accounts', '/missing.zip']),
    /--ssh is required/
  );
});

test('parseArgs accepts conservative real VPS deploy options', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-real-vps-deploy-test-'));
  const zip = path.join(dir, 'accounts.zip');
  const nodeRuntime = path.join(dir, 'node-v22.16.0-linux-x64.tar.xz');
  fs.writeFileSync(zip, 'zip');
  fs.writeFileSync(nodeRuntime, 'node');
  const sshKey = path.join(dir, 'aws.pem');
  fs.writeFileSync(sshKey, 'key');

  const parsed = parseArgs([
    '--ssh', 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
    '--ssh-key', sshKey,
    '--accounts', zip,
    '--node-runtime', nodeRuntime,
    '--remote-dir', '/home/ubuntu/aih-fabric-current',
    '--broker-token-file', '/home/ubuntu/aih-fabric-current/.broker-token',
    '--skip-build',
    '--skip-import',
    '--skip-start',
    '--dry-run'
  ]);

  assert.equal(parsed.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(parsed.sshKey, sshKey);
  assert.equal(parsed.accountsZip, zip);
  assert.equal(parsed.nodeRuntimeArchive, nodeRuntime);
  assert.equal(parsed.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(parsed.brokerTokenFile, '/home/ubuntu/aih-fabric-current/.broker-token');
  assert.equal(parsed.port, 9527);
  assert.equal(parsed.skipBuild, true);
  assert.equal(parsed.skipImport, true);
  assert.equal(parsed.skipStart, true);
  assert.equal(parsed.sourceTransfer, 'cache');
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(buildSshArgs(parsed), [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'IdentityAgent=none',
    '-o',
    'IdentitiesOnly=yes',
    '-i',
    sshKey
  ]);
});

test('parseArgs supports current-dir source transfer without account zip', () => {
  const parsed = parseArgs([
    '--ssh',
    'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
    '--skip-import',
    '--skip-start',
    '--skip-build',
    '--dry-run'
  ]);

  assert.equal(parsed.accountsZip, '');
  assert.equal(parsed.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(parsed.skipImport, true);
  assert.equal(parsed.skipStart, true);
});

test('parseArgs requires broker token file to be an absolute remote path', () => {
  assert.throws(
    () => parseArgs([
      '--ssh',
      'ubuntu@example.com',
      '--skip-import',
      '--broker-token-file',
      'relative.token'
    ]),
    /--broker-token-file must be an absolute remote path/
  );
});

test('parseArgs supports source transfer mode override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-real-vps-deploy-test-'));
  const zip = path.join(dir, 'accounts.zip');
  fs.writeFileSync(zip, 'zip');

  assert.equal(
    parseArgs([
      '--ssh',
      'root@example.com',
      '--accounts',
      zip,
      '--source-transfer',
      'stream'
    ]).sourceTransfer,
    'stream'
  );
  assert.equal(
    parseArgs([
      '--ssh',
      'root@example.com',
      '--accounts',
      zip,
      '--no-source-cache'
    ]).sourceTransfer,
    'stream'
  );
  assert.throws(
    () => parseArgs([
      '--ssh',
      'root@example.com',
      '--accounts',
      zip,
      '--source-transfer',
      'rsync'
    ]),
    /--source-transfer must be cache or stream/
  );
});

test('parseArgs rejects missing or non-tar Node runtime archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-real-vps-deploy-test-'));
  const zip = path.join(dir, 'accounts.zip');
  const txt = path.join(dir, 'node.txt');
  fs.writeFileSync(zip, 'zip');
  fs.writeFileSync(txt, 'node');

  assert.throws(
    () => parseArgs(['--ssh', 'root@example.com', '--accounts', zip, '--node-runtime', path.join(dir, 'missing.tar.xz')]),
    /node runtime archive not found/
  );
  assert.throws(
    () => parseArgs(['--ssh', 'root@example.com', '--accounts', zip, '--node-runtime', txt]),
    /--node-runtime must be a \.tar\.xz archive/
  );
});

test('parseArgs rejects relative remote dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-real-vps-deploy-test-'));
  const zip = path.join(dir, 'accounts.zip');
  fs.writeFileSync(zip, 'zip');

  assert.throws(
    () => parseArgs(['--ssh', 'root@example.com', '--accounts', zip, '--remote-dir', 'relative/path']),
    /--remote-dir must be absolute/
  );
});

test('shQuote escapes single quotes for remote shell commands', () => {
  assert.equal(shQuote('/root/aih fabric'), "'/root/aih fabric'");
  assert.equal(shQuote("/root/aih'fabric"), "'/root/aih'\\''fabric'");
});

test('buildRemoteStartCommand backgrounds server and records pid without invalid separators', () => {
  const command = buildRemoteStartCommand({
    remoteDir: '/home/ubuntu/aih-fabric-current',
    nodeRuntimeArchive: '/tmp/node-v22.16.0-linux-x64.tar.xz',
    port: 9527
  }, '/home/ubuntu/aih-fabric-current/fabric-server.log', '/home/ubuntu/aih-fabric-current/fabric-server.pid');

  assert.match(command, /export AIH_HOST_HOME='\/home\/ubuntu\/aih-fabric-current\/\.aih-host-home'/);
  assert.match(command, /export PATH='\/home\/ubuntu\/aih-fabric-current\/\.node-runtime\/node-v22\.16\.0-linux-x64\/bin':'\/home\/ubuntu\/aih-fabric-current\/node_modules\/\.bin':\$PATH/);
  assert.match(command, /nohup node bin\/ai-home\.js server serve --host 0\.0\.0\.0 --port 9527/);
  assert.match(command, /echo \$! > '\/home\/ubuntu\/aih-fabric-current\/fabric-server\.pid'/);
  assert.doesNotMatch(command, /&\s*&&/);
  assert.doesNotMatch(command, /\(\s*&&/);
  assert.doesNotMatch(command, /&&\s*&&/);
});

test('remote Node helpers keep runtime and AIH state scoped to remote deploy dir', () => {
  const options = {
    remoteDir: '/home/ubuntu/aih-fabric-current',
    nodeRuntimeArchive: '/tmp/node-v22.16.0-linux-x64.tar.xz',
    brokerTokenFile: '/home/ubuntu/aih-fabric-current/.broker-token'
  };

  assert.equal(
    getRemoteHostHome(options),
    '/home/ubuntu/aih-fabric-current/.aih-host-home'
  );
  assert.equal(
    getRemoteNodeHome(options),
    '/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64'
  );
  const envCommand = buildRemoteEnvCommand(options);
  assert.match(envCommand, /mkdir -p '\/home\/ubuntu\/aih-fabric-current\/\.aih-host-home'/);
  assert.match(envCommand, /export AIH_HOST_HOME='\/home\/ubuntu\/aih-fabric-current\/\.aih-host-home'/);
  assert.match(envCommand, /test -s '\/home\/ubuntu\/aih-fabric-current\/\.broker-token'/);
  assert.match(envCommand, /export AIH_FABRIC_BROKER_TOKEN="\$\(cat '\/home\/ubuntu\/aih-fabric-current\/\.broker-token'\)"/);
  assert.match(envCommand, /export PATH='\/home\/ubuntu\/aih-fabric-current\/\.node-runtime\/node-v22\.16\.0-linux-x64\/bin':'\/home\/ubuntu\/aih-fabric-current\/node_modules\/\.bin':\$PATH/);
  assert.equal(
    buildRemoteNodeCommand(options, 'node --version'),
    "mkdir -p '/home/ubuntu/aih-fabric-current/.aih-host-home' && export AIH_HOST_HOME='/home/ubuntu/aih-fabric-current/.aih-host-home' && test -s '/home/ubuntu/aih-fabric-current/.broker-token' && export AIH_FABRIC_BROKER_TOKEN=\"$(cat '/home/ubuntu/aih-fabric-current/.broker-token')\" && export PATH='/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin':'/home/ubuntu/aih-fabric-current/node_modules/.bin':$PATH; node --version"
  );
  assert.match(
    buildRemoteNodeProbeCommand(options),
    /node-runtime-archive-selected/
  );
  assert.match(
    buildRemoteRuntimeInstallCommand(options, '/home/ubuntu/aih-fabric-current/node-v22.16.0-linux-x64.tar.xz'),
    /node-runtime-ready/
  );
  assert.match(
    buildRemoteRuntimeInstallCommand(options, '/home/ubuntu/aih-fabric-current/node-v22.16.0-linux-x64.tar.xz'),
    /tar -xJf '\/home\/ubuntu\/aih-fabric-current\/node-v22\.16\.0-linux-x64\.tar\.xz' -C '\/home\/ubuntu\/aih-fabric-current\/\.node-runtime'/
  );
});

test('remote runtime cache path stays outside the current deployment directory', () => {
  const options = {
    remoteDir: '/home/ubuntu/aih-fabric-current',
    nodeRuntimeArchive: '/tmp/node-v22.16.0-linux-x64-glibc-217.tar.xz'
  };

  assert.equal(
    getRemoteRuntimeCacheArchive(options),
    '/home/ubuntu/.aih-node-runtime-cache/node-v22.16.0-linux-x64-glibc-217.tar.xz'
  );
});

test('remote runtime cache probe verifies sha256 before reuse', () => {
  const command = buildRemoteRuntimeCacheProbeCommand(
    '/home/ubuntu/.aih-node-runtime-cache/node-v22.16.0-linux-x64-glibc-217.tar.xz',
    'abc123'
  );

  assert.match(command, /sha256sum/);
  assert.match(command, /abc123/);
  assert.match(command, /node-runtime-cache-hit/);
  assert.match(command, /exit 75/);
});

test('sha256File hashes local runtime archive content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-runtime-cache-test-'));
  const filePath = path.join(dir, 'runtime.tar.xz');
  fs.writeFileSync(filePath, 'runtime');

  assert.equal(
    sha256File(filePath),
    'd92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23'
  );
});

test('dependency cache key and remote directory are lockfile scoped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-deps-cache-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"aih-test"}');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');

  const fullHash = sha256Files([
    path.join(dir, 'package.json'),
    path.join(dir, 'package-lock.json')
  ]);
  const cacheKey = getLocalDependencyCacheKey(dir);

  assert.equal(cacheKey, fullHash.slice(0, 16));
  assert.equal(
    getRemoteDependencyCacheDir({ remoteDir: '/home/ubuntu/aih-fabric-current' }, cacheKey),
    `/home/ubuntu/.aih-node-modules-cache/${cacheKey}`
  );
});

test('remote dependency install command reuses node_modules cache', () => {
  const command = buildRemoteDependencyInstallCommand(
    { remoteDir: '/home/ubuntu/aih-fabric-current' },
    '/home/ubuntu/.aih-node-modules-cache/abc123'
  );

  assert.match(command, /node-modules-cache-hit/);
  assert.match(command, /node-modules-cache-store/);
  assert.match(command, /npm install --ignore-scripts --cache '\/home\/ubuntu\/\.aih-npm-cache'/);
  assert.match(command, /ln -s '\/home\/ubuntu\/\.aih-node-modules-cache\/abc123\/node_modules' node_modules/);
  assert.doesNotMatch(command, /fi echo/);
  assert.match(command, /npm install --ignore-scripts --cache '\/home\/ubuntu\/\.aih-npm-cache' && mv node_modules/);
});

test('remote source cache archive stays outside the current deployment directory', () => {
  const options = {
    remoteDir: '/home/ubuntu/aih-fabric-current'
  };

  assert.equal(
    getRemoteSourceCacheDir(options),
    '/home/ubuntu/.aih-source-cache'
  );
  assert.equal(
    getRemoteSourceCacheArchive(options, 'abc123'),
    '/home/ubuntu/.aih-source-cache/source-abc123.tar.gz'
  );
});

test('remote source cache probe verifies sha256 before extracting', () => {
  const command = buildRemoteSourceCacheProbeCommand(
    '/home/ubuntu/.aih-source-cache/source-abc123.tar.gz',
    'abc123'
  );

  assert.match(command, /sha256sum/);
  assert.match(command, /abc123/);
  assert.match(command, /source-cache-hit/);
  assert.match(command, /exit 75/);
});

test('remote source extract command creates deploy directory and extracts cached artifact', () => {
  const command = buildRemoteSourceExtractCommand(
    { remoteDir: '/home/ubuntu/aih-fabric-current' },
    '/home/ubuntu/.aih-source-cache/source-abc123.tar.gz'
  );

  assert.equal(
    command,
    "mkdir -p '/home/ubuntu/aih-fabric-current' && tar -xzf '/home/ubuntu/.aih-source-cache/source-abc123.tar.gz' -C '/home/ubuntu/aih-fabric-current'"
  );
});

test('source archive args disable macOS extended attributes for weak remote links', () => {
  const args = buildSourceTarArgs();

  assert.deepEqual(args.slice(0, 3), ['--format', 'ustar', '--no-xattrs']);
  assert.ok(args.includes('--no-xattrs'));
  assert.ok(args.includes('--exclude'));
  assert.deepEqual(args.slice(-3), ['-czf', '-', '.']);
});

test('source archive args can target a reusable local release artifact', () => {
  const args = buildSourceTarArgs('/tmp/aih-source.tar.gz');

  assert.deepEqual(args.slice(-3), ['-czf', '/tmp/aih-source.tar.gz', '.']);
});

test('source raw tar args support deterministic gzip wrapping', () => {
  const args = buildSourceRawTarArgs('-');

  assert.ok(args.includes('--no-xattrs'));
  assert.deepEqual(args.slice(-3), ['-cf', '-', '.']);
});
