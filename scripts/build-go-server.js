#!/usr/bin/env node
'use strict';

// Builds the Go Core server into the exact path the Node supervisor resolves
// (`resolveGoServerBinary`): bin/native/<platform>-<arch>/aih-server[.exe].
// Local-only: no network beyond Go module download, never commits.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../lib/cli/services/server/go-core-supervisor');
const {
  computeRouteManifestHash,
  readPackageVersion,
  writeBuildStamp
} = require('../lib/cli/services/server/go-core-build-stamp');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

// Node 的 process.platform/arch 与 GOOS/GOARCH 命名不同，只映射受支持组合。
const GOOS_BY_PLATFORM = Object.freeze({ darwin: 'darwin', linux: 'linux', win32: 'windows' });
const GOARCH_BY_ARCH = Object.freeze({ x64: 'amd64', arm64: 'arm64' });

// repositoryRoot 可注入：部署流程在临时 worktree 里构建，产物必须落在待打包的目录树内。
function buildGoServerPlan(options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const goos = GOOS_BY_PLATFORM[platform];
  const goarch = GOARCH_BY_ARCH[arch];
  if (!goos || !goarch) {
    throw new Error(`unsupported Go Core target: ${platform}-${arch}`);
  }
  const output = resolveGoServerBinary({ repositoryRoot, platform, arch });
  // 先编译到同目录临时文件再原子改名：正在运行的 Go Core 仍持有旧文件，
  // 直接覆写可执行文件在 macOS 上会让运行中的进程被系统杀掉。
  const temporaryOutput = `${output}.build-${process.pid}${platform === 'win32' ? '.exe' : ''}`;
  return {
    output,
    temporaryOutput,
    target: `${platform}-${arch}`,
    args: ['build', '-trimpath', '-o', temporaryOutput, './cmd/aih-server'],
    env: { ...(options.baseEnv || process.env), GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' }
  };
}

/**
 * 构建一次 Go Core 并写入 build stamp。失败时清理临时产物并抛出，绝不留下半成品
 * （监督器会因 stamp 缺失或摘要不符拒绝拉起）。
 */
function buildGoServer(options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const plan = buildGoServerPlan({ ...options, repositoryRoot });
  const result = spawnSync('go', plan.args, {
    cwd: repositoryRoot,
    env: plan.env,
    stdio: options.stdio || 'inherit'
  });
  if (result.error || result.status !== 0) {
    fs.rmSync(plan.temporaryOutput, { force: true });
    if (result.error) throw result.error;
    throw new Error(`go build exited with ${result.status}`);
  }
  fs.renameSync(plan.temporaryOutput, plan.output);
  return {
    output: plan.output,
    target: plan.target,
    stamp: writeBuildStamp(fs, {
      binaryPath: plan.output,
      version: readPackageVersion(fs, repositoryRoot),
      routeManifestHash: computeRouteManifestHash(fs, repositoryRoot),
      sourceSha: readSourceSha(repositoryRoot),
      target: plan.target
    })
  };
}

function main(argv = process.argv.slice(2)) {
  const readValue = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const built = buildGoServer({ platform: readValue('--platform'), arch: readValue('--arch') });
  console.log(`[aih] Go Core built: ${path.relative(REPOSITORY_ROOT, built.output)} (sha256 ${built.stamp.binary_sha256.slice(0, 12)})`);
  return 0;
}

function readSourceSha(repositoryRoot = REPOSITORY_ROOT) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[aih] go build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildGoServer, buildGoServerPlan };
