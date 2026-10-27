'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getNativeResourceRuntimeStrategy } = require('../providers');
const { resolveClientPlatform } = require('../runtime/client-platform');
const { resolveProviderNativeRoot } = require('../runtime/provider-storage-policy');
const { requireMcp } = require('./mcp-errors');

function desktopNode(strategy, options) {
  const platform = resolveClientPlatform({ platform: options.platform || process.platform });
  const declared = strategy.desktopClient?.[platform];
  const segments = String(strategy.entry || '').split('/');
  if (!declared || !segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes(':'))) return null;
  for (const template of declared.installPaths || []) {
    const root = template.replace('{hostHomeDir}', options.hostHomeDir || '');
    const entry = path.join(root, ...segments);
    try {
      if (!fs.statSync(entry).isFile()) continue;
      return { command: process.execPath, args: [entry], env: { ...strategy.env }, source: 'desktop-node' };
    } catch (_) {}
  }
  return null;
}

const HANDLERS = Object.freeze({ 'desktop-node': desktopNode });

function resolveProviderResourceRuntime(provider, options = {}) {
  const strategy = getNativeResourceRuntimeStrategy(provider);
  const binary = options.nativeBinaries
    ? options.nativeBinaries[provider]
    : require('../cli/services/ai-cli/ensure-native-cli').resolveProviderCliPath(provider, options);
  if (binary) return { command: binary, args: [], env: { ...strategy?.env }, source: 'native-cli' };
  return strategy && HANDLERS[strategy.handler]?.(strategy, options) || null;
}

function nativeResourceEnvironment(provider, options, runtime) {
  const env = { ...(options.env || process.env), ...runtime.env, HOME: options.hostHomeDir, USERPROFILE: options.hostHomeDir };
  const strategy = getNativeResourceRuntimeStrategy(provider);
  const root = resolveProviderNativeRoot(options.hostHomeDir, provider);
  for (const key of strategy?.configEnvKeys || []) env[key] = root;
  if (strategy?.userDataEnvKey) env[strategy.userDataEnvKey] = path.join(root, 'electron-user-data');
  return env;
}

function runNativeResourceCommand(provider, args, options = {}) {
  const runtime = options.runtime || resolveProviderResourceRuntime(provider, options);
  requireMcp(runtime, 'native_plugin_runtime_unavailable');
  const result = spawnSync(runtime.command, [...runtime.args, ...args], {
    cwd: options.cwd || options.hostHomeDir,
    env: nativeResourceEnvironment(provider, options, runtime),
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: options.timeoutMs || 30000, maxBuffer: 1024 * 1024
  });
  requireMcp(result.status === 0, 'native_plugin_command_failed');
  return result.stdout;
}

module.exports = { resolveProviderResourceRuntime, nativeResourceEnvironment, runNativeResourceCommand };
