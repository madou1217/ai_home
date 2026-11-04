'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLinuxInstallScript,
  buildWindowsInstallScript,
  inferTargetFromArtifact,
  isWindowsTarget,
  parseArgs,
  parseRemoteTarget,
  parseTarget,
  remoteArtifactPath,
  resolveDeployTarget,
  targetKey
} = require('../scripts/deploy-server');

test('deploy parser requires an explicit ssh target and validates the target matrix', () => {
  assert.throws(() => parseArgs([]), /missing --ssh/);
  const options = parseArgs(['--ssh', 'ubuntu@host', '--target', 'linux-x64', '--artifact', 'dist/release/aih-1.0.0-linux-x64.run']);
  assert.equal(options.target, 'linux-x64');
  assert.equal(options.upload, 'rsync');
  assert.throws(() => parseArgs(['--ssh', 'u@h', '--target', 'linux-mips']), /invalid --target/);
  assert.throws(() => parseArgs(['--ssh', 'u@h', '--upload', 'ftp']), /invalid --upload/);
  assert.throws(() => parseArgs(['--ssh', 'u@h', '--skip-web-build']), /unknown option/);
});

test('remote platform probing maps uname and Windows shells to the release matrix', () => {
  assert.deepEqual(parseRemoteTarget('Linux x86_64'), parseTarget('linux-x64'));
  assert.deepEqual(parseRemoteTarget('Linux aarch64'), parseTarget('linux-arm64'));
  assert.deepEqual(parseRemoteTarget('Darwin arm64'), parseTarget('darwin-arm64'));
  assert.deepEqual(parseRemoteTarget('MINGW64_NT-10.0-22631 x86_64'), parseTarget('win32-x64'));
  assert.equal(parseRemoteTarget('SunOS sparc'), null);
  assert.equal(parseRemoteTarget(''), null);
  assert.equal(isWindowsTarget(parseTarget('win32-x64')), true);
  assert.equal(targetKey(parseTarget('linux-arm64')), 'linux-arm64');
});

test('artifact names carry the version and target', () => {
  const inferred = inferTargetFromArtifact('/tmp/aih-1.2.3-linux-x64.run');
  assert.equal(inferred.version, '1.2.3');
  assert.equal(inferred.target.key, 'linux-x64');
  assert.equal(inferTargetFromArtifact('/tmp/aih-1.2.3-linux-x64.tar.gz'), null);
  assert.equal(inferTargetFromArtifact('/tmp/random.run'), null);
});

test('binary install scripts replace the launcher and restart the service; no source/npm install', () => {
  const options = parseArgs(['--ssh', 'u@h', '--target', 'linux-x64']);
  const linux = buildLinuxInstallScript(options, '/tmp/aih-1.0.0-linux-x64.run', '1.0.0', parseTarget('linux-x64'));
  assert.match(linux, /server autostart install/);
  assert.match(linux, /systemctl --user restart/);
  assert.match(linux, /readyz/);
  assert.match(linux, /mv -f "\$ARTIFACT" "\$INSTALL_DIR\/aih"/);
  assert.doesNotMatch(linux, /npm install/);
  assert.doesNotMatch(linux, /rsync -a --delete/);

  const windowsOptions = parseArgs(['--ssh', 'u@h', '--target', 'win32-x64']);
  const windows = buildWindowsInstallScript(windowsOptions, 'aih-1.0.0-win32-x64.exe', '1.0.0', parseTarget('win32-x64'));
  assert.match(windows, /%LOCALAPPDATA%/);
  assert.match(windows, /server autostart install/);
  assert.match(windows, /Invoke-WebRequest/);
  assert.doesNotMatch(windows, /npm install/);
  assert.doesNotMatch(windows, /uname/);
});

test('remote artifact path is /tmp on POSIX and a home-relative file on Windows', () => {
  assert.equal(remoteArtifactPath({}, parseTarget('linux-x64'), '1.0.0'), '/tmp/aih-1.0.0-linux-x64.run');
  assert.equal(remoteArtifactPath({}, parseTarget('win32-x64'), '1.0.0'), 'aih-1.0.0-win32-x64.exe');
});

test('dry-run derives the target from the artifact instead of probing the host', () => {
  const options = parseArgs(['--ssh', 'u@h', '--artifact', '/tmp/aih-1.0.0-linux-arm64.run', '--dry-run']);
  assert.equal(options.dryRun, true);
  assert.equal(targetKey(resolveDeployTarget(options)), 'linux-arm64');
  assert.throws(
    () => resolveDeployTarget(parseArgs(['--ssh', 'u@h', '--artifact', '/tmp/random.run', '--dry-run'])),
    /aih-<version>-<platform>-<arch>/
  );
  const windows = parseArgs(['--ssh', 'u@h', '--artifact', '/tmp/aih-1.0.0-win32-x64.exe', '--dry-run']);
  assert.equal(targetKey(resolveDeployTarget(windows)), 'win32-x64');
});
