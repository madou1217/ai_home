#!/usr/bin/env node
'use strict';

// Builds the Go CLI (cmd/aih) into bin/native/<platform>-<arch>/aih-go[.exe].
//
// The Node front door routes bare CodeBuddy / WorkBuddy launches to this binary;
// a missing binary is an explicit install/build error, never a Node fallback.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const GOOS_BY_PLATFORM = Object.freeze({ darwin: 'darwin', linux: 'linux', win32: 'windows' });
const GOARCH_BY_ARCH = Object.freeze({ x64: 'amd64', arm64: 'arm64' });

function buildGoCLIPlan(options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const goos = GOOS_BY_PLATFORM[platform];
  const goarch = GOARCH_BY_ARCH[arch];
  if (!goos || !goarch) {
    throw new Error(`unsupported Go CLI target: ${platform}-${arch}`);
  }
  const directory = path.join(repositoryRoot, 'bin', 'native', `${platform}-${arch}`);
  const output = path.join(directory, platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const temporaryOutput = `${output}.build-${process.pid}`;
  return {
    repositoryRoot,
    output,
    temporaryOutput,
    // 与 aih-server 一致：发布用二进制一律 strip（-s -w）。
    args: ['build', '-trimpath', '-ldflags', '-s -w', '-o', temporaryOutput, './cmd/aih'],
    env: { ...(options.baseEnv || process.env), GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' }
  };
}

function buildGoCLI(options = {}) {
  const plan = buildGoCLIPlan(options);
  fs.mkdirSync(path.dirname(plan.output), { recursive: true });
  const result = spawnSync('go', plan.args, {
    cwd: plan.repositoryRoot,
    env: plan.env,
    stdio: options.stdio || 'inherit'
  });
  if (result.error || result.status !== 0) {
    fs.rmSync(plan.temporaryOutput, { force: true });
    if (result.error) throw result.error;
    throw new Error(`go build exited with ${result.status}`);
  }
  fs.renameSync(plan.temporaryOutput, plan.output);
  buildManPage(plan.repositoryRoot);
  return { output: plan.output, target: `${options.platform || process.platform}-${options.arch || process.arch}` };
}

// buildManPage 把命令手册生成为发布产物 dist/man/index.html。
// 页面是编译结果，不是手写 HTML：数据来自 cmd/aih-manpage 读取的补全命令树。
function buildManPage(repositoryRoot) {
  if (process.env.AIH_SKIP_MANPAGE === '1') return;
  const packageJSON = path.join(repositoryRoot, 'package.json');
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(packageJSON, 'utf8')).version || '';
  } catch (_) {}
  const output = path.join(repositoryRoot, 'dist', 'man', 'index.html');
  const args = ['run', './cmd/aih-manpage', '--', '--out', output];
  if (version) args.push('--version', version);
  const result = spawnSync('go', args, { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error('aih-manpage generation failed');
  }
  return output;
}

if (require.main === module) {
  try {
    const built = buildGoCLI();
    console.log(`[aih] Go CLI built: ${path.relative(REPOSITORY_ROOT, built.output)}`);
  } catch (error) {
    console.error(`[aih] go CLI build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildGoCLI, buildGoCLIPlan };
