'use strict';

const { spawn } = require('node:child_process');
const { createHeadlessSpawn } = require('../cli/services/pty/headless-spawn');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');

// Structured native output must use pipes. In a PTY the CodeBuddy CLI emits
// OSC title sequences before its JSON records, corrupting stream framing.
function createNativeSessionHeadlessChild(launch, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = resolveWindowsUpstreamSpawn(launch.command, launch.args, {
    platform, env: options.env, fsImpl: options.fs, nodeExecPath: options.nodeExecPath
  });
  const adapter = createHeadlessSpawn({
    processObj: { env: options.env || process.env, cwd: () => options.cwd },
    spawn: (command, args, spawnOptions) => (options.spawn || spawn)(command, args, {
      ...spawnOptions,
      ...(platform === 'win32' ? { windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments } : {})
    })
  });
  return adapter.spawnHeadlessDirect(resolved, {
    provider: options.provider,
    env: { ...options.env, ...resolved.envPatch }
  });
}

module.exports = { createNativeSessionHeadlessChild };
