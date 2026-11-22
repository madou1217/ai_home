#!/usr/bin/env node
'use strict';

// Builds the Go Core server into the exact path the Node supervisor resolves
// (`resolveGoServerBinary`): bin/native/<platform>-<arch>/aih-server[.exe].
// Builds the matching Go CLI before publishing the server: both share aih.db.
// Local-only: no network beyond Go module download, never commits.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildGoCLI } = require('./build-go-cli');
const { resolveGoServerBinary } = require('../lib/cli/services/server/go-core-supervisor');
const {
  computeRouteManifestHash,
  readPackageVersion,
  writeBuildStamp
} = require('../lib/cli/services/server/go-core-build-stamp');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

// egress.engine 进程插件与 aih-server 同目录分发；主体只按 ID 发现，不编译内核。
const ENGINE_PLUGIN_NAMES = Object.freeze(['aih-engine-mihomo', 'aih-engine-singbox']);

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
  const suffix = platform === 'win32' ? '.exe' : '';
  // 先编译到同目录临时文件再原子改名：正在运行的 Go Core 仍持有旧文件，
  // 直接覆写可执行文件在 macOS 上会让运行中的进程被系统杀掉。
  const temporaryOutput = `${output}.build-${process.pid}${suffix}`;
  const baseArgs = ['build', '-trimpath', '-ldflags', '-s -w'];
  const env = { ...(options.baseEnv || process.env), GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' };
  const outputDir = path.dirname(output);
  return {
    output,
    temporaryOutput,
    target: `${platform}-${arch}`,
    // 生产主体不带内置内核编译器：只发现同目录/aiHome 下的进程插件。
    // -s -w 去掉符号表与 DWARF：分发包小 ~19MiB（压缩后），panic 栈和 pprof
    // 仍可用（pclntab 保留）。发布流水线同样走这里，勿在别处另起一套 flag。
    args: [...baseArgs, '-tags', 'no_builtin_engines', '-o', temporaryOutput, './cmd/aih-server'],
    plugins: ENGINE_PLUGIN_NAMES.map((name) => ({
      name,
      output: path.join(outputDir, name + suffix),
      temporaryOutput: path.join(outputDir, `${name}.build-${process.pid}${suffix}`),
      args: [...baseArgs, '-o', path.join(outputDir, `${name}.build-${process.pid}${suffix}`), `./cmd/${name}`]
    })),
    env
  };
}

/**
 * 构建一次 Go Core 并写入 build stamp。失败时清理临时产物并抛出，绝不留下半成品
 * （监督器会因 stamp 缺失或摘要不符拒绝拉起）。
 */
function buildGoServer(options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const plan = buildGoServerPlan({ ...options, repositoryRoot });
  const runGoBuild = (args) => {
    const result = spawnSync('go', args, {
      cwd: repositoryRoot,
      env: plan.env,
      stdio: options.stdio || 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`go build exited with ${result.status}`);
  };
  const temporaryOutputs = [plan.temporaryOutput, ...plan.plugins.map((plugin) => plugin.temporaryOutput)];
  try {
    runGoBuild(plan.args);
    for (const plugin of plan.plugins) runGoBuild(plugin.args);
    // Publish the CLI from the same source before the server. Database readiness
    // is capability-based; paired artifacts keep native commands in sync.
    buildGoCLI({ ...options, repositoryRoot });
    for (const plugin of plan.plugins) fs.renameSync(plugin.temporaryOutput, plugin.output);
    fs.renameSync(plan.temporaryOutput, plan.output);
  } catch (error) {
    for (const temporary of temporaryOutputs) fs.rmSync(temporary, { force: true });
    throw error;
  }
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
  console.log(`[aih] Go Core + matching CLI built: ${path.relative(REPOSITORY_ROOT, built.output)} (sha256 ${built.stamp.binary_sha256.slice(0, 12)})`);
  return 0;
}

function readSourceSha(repositoryRoot = REPOSITORY_ROOT) {
  // Exact archive builds have no .git directory. The caller pins the verified
  // commit explicitly; never publish an empty or inferred source provenance.
  const pinned = String(process.env.AIH_BUILD_SOURCE_SHA || '').trim();
  if (pinned) {
    if (!/^[0-9a-f]{40}$/.test(pinned)) throw new Error('AIH_BUILD_SOURCE_SHA must be an exact commit');
    return pinned;
  }
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
