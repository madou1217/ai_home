#!/usr/bin/env node
'use strict';

// Builds the Go Core server into the exact path the Node supervisor resolves
// (`resolveGoServerBinary`): bin/native/<platform>-<arch>/aih-server[.exe].
// Local-only: no network beyond Go module download, never commits.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../lib/cli/services/server/go-core-supervisor');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

// Node 的 process.platform/arch 与 GOOS/GOARCH 命名不同，只映射受支持组合。
const GOOS_BY_PLATFORM = Object.freeze({ darwin: 'darwin', linux: 'linux', win32: 'windows' });
const GOARCH_BY_ARCH = Object.freeze({ x64: 'amd64', arm64: 'arm64' });

function buildGoServerPlan(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const goos = GOOS_BY_PLATFORM[platform];
  const goarch = GOARCH_BY_ARCH[arch];
  if (!goos || !goarch) {
    throw new Error(`unsupported Go Core target: ${platform}-${arch}`);
  }
  const output = resolveGoServerBinary({ repositoryRoot: REPOSITORY_ROOT, platform, arch });
  return {
    output,
    args: ['build', '-trimpath', '-o', output, './cmd/aih-server'],
    env: { ...(options.baseEnv || process.env), GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' }
  };
}

function main(argv = process.argv.slice(2)) {
  const readValue = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const plan = buildGoServerPlan({ platform: readValue('--platform'), arch: readValue('--arch') });
  const result = spawnSync('go', plan.args, { cwd: REPOSITORY_ROOT, env: plan.env, stdio: 'inherit' });
  if (result.error) {
    console.error(`[aih] go build failed to start: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status || 1;
  console.log(`[aih] Go Core built: ${path.relative(REPOSITORY_ROOT, plan.output)}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { buildGoServerPlan };
