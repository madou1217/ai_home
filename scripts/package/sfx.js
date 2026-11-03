'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isWindows, targetKey } = require('./targets');
const { copyTree, ensureDir, removeIfExists, sha256File } = require('./fs-utils');

const SFX_SOURCE_DIR = path.join(__dirname, 'sfx');

function renderSource(source, values) {
  return source
    .replaceAll('__AIH_BUNDLE_VERSION__', values.version)
    .replaceAll('__AIH_BUNDLE_TARGET__', targetKey(values.target))
    .replaceAll('__AIH_PAYLOAD_SHA__', values.payloadSha);
}

/**
 * 把 bundle 打成单个自解压可执行文件：Go 启动器 + 内嵌 zip 载荷。
 * 首次运行解包到 <AIH_HOME_DIR>/pkg/<version>-<target>-<sha8>/，之后直接 exec。
 */
function buildSelfExtractingExecutable(options = {}) {
  const bundleRoot = path.resolve(options.bundleRoot);
  const workDir = path.resolve(options.workDir);
  const output = path.resolve(options.output);
  const target = options.target;
  const version = options.version;
  const log = options.log || (() => {});
  const buildDir = path.join(workDir, `sfx-${targetKey(target)}`);
  removeIfExists(buildDir);
  ensureDir(buildDir);

  const payload = path.join(buildDir, 'payload.zip');
  require('./archives').createPayloadZip(bundleRoot, payload);
  const payloadSha = sha256File(payload);
  log(`[pkg] SFX payload ${(fs.statSync(payload).size / 1024 / 1024).toFixed(1)} MiB (${payloadSha.slice(0, 12)})`);

  for (const name of ['main.go', 'run_unix.go', 'run_windows.go', 'go.mod']) {
    fs.copyFileSync(path.join(SFX_SOURCE_DIR, name), path.join(buildDir, name));
  }
  const mainSource = fs.readFileSync(path.join(buildDir, 'main.go'), 'utf8');
  fs.writeFileSync(path.join(buildDir, 'main.go'), renderSource(mainSource, { version, target, payloadSha }));

  ensureDir(path.dirname(output));
  removeIfExists(output);
  const args = [
    'build',
    '-trimpath',
    '-ldflags',
    '-s -w',
    '-o',
    output,
    '.'
  ];
  log(`[pkg] building single-file executable for ${targetKey(target)}`);
  const result = spawnSync('go', args, {
    cwd: buildDir,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Go SFX build failed with ${result.status}`);
  if (!isWindows(target)) fs.chmodSync(output, 0o755);
  removeIfExists(buildDir);
  return { output, payloadSha, size: fs.statSync(output).size };
}

module.exports = {
  buildSelfExtractingExecutable,
  renderSource
};
