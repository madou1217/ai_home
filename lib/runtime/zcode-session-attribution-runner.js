#!/usr/bin/env node
'use strict';

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const nodeModule = require('node:module');
const {
  AIH_ZCODE_SESSION_SCOPE_ENV,
  installZcodeSessionScopeFunction,
  patchZcodeAgentSource
} = require('./zcode-session-attribution-hook');
const { AIH_ZCODE_USAGE_OWNER_LOG_ENV, installZcodeUsageOwnerRecorder, patchZcodeUsageSource } = require('./zcode-usage-attribution-hook');

function runZcodeSessionAttributionAgent(argv = process.argv.slice(2), env = process.env, options = {}) {
  const [agentEntry, ...agentArgs] = Array.isArray(argv) ? argv : [];
  const resolvedAgentEntry = nodePath.resolve(String(agentEntry || '').trim());
  if (!agentEntry || !nodePath.isAbsolute(resolvedAgentEntry)) {
    throw new Error('ZCode session attribution runner requires an absolute agent entry path');
  }

  if (!installZcodeSessionScopeFunction(env[AIH_ZCODE_SESSION_SCOPE_ENV])) {
    throw new Error('ZCode session attribution hook was not installed');
  }

  const fsImpl = options.fs || nodeFs;
  const moduleImpl = options.moduleImpl || nodeModule;
  const mainModule = options.mainModule || require.main;
  if (!mainModule || typeof mainModule._compile !== 'function') {
    throw new Error('ZCode session attribution runner requires a CommonJS main module');
  }

  // The Desktop supplies account models and native authentication callbacks
  // over this connection. A second standalone agent has neither authority.
  if (agentArgs[0] === 'app-server' && !agentArgs.includes('--prepare-storage')
    && env.AIH_ZCODE_DESKTOP_BRIDGE_DIR && env.AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY) {
    const { createNativeStdioProtocolTap } = require('./native-stdio-protocol-tap');
    const { createZcodeDesktopProtocolBridge } = require('./zcode-desktop-protocol-bridge');
    const { bridgeVersion } = require('./zcode-desktop-bridge-binding');
    const protocol = createNativeStdioProtocolTap({ input: process.stdin, output: process.stdout });
    const bridge = createZcodeDesktopProtocolBridge({ protocol, cwd: process.cwd(), binding: {
      version: bridgeVersion(), provider: 'zcode', accountRef: env[AIH_ZCODE_SESSION_SCOPE_ENV],
      identity: env.AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY, profileDir: env.HOME,
      mailboxDir: env.AIH_ZCODE_DESKTOP_BRIDGE_DIR
    } });
    bridge.start();
    Object.defineProperty(process, 'stdin', { configurable: true, value: protocol.input });
    Object.defineProperty(process, 'stdout', { configurable: true, value: protocol.output });
    process.once('exit', () => bridge.dispose());
  }

  process.argv = [process.execPath, resolvedAgentEntry, ...agentArgs];
  mainModule.filename = resolvedAgentEntry;
  mainModule.paths = moduleImpl._nodeModulePaths(nodePath.dirname(resolvedAgentEntry));
  let source = patchZcodeAgentSource(fsImpl.readFileSync(resolvedAgentEntry, 'utf8'));
  const logPath = String(env[AIH_ZCODE_USAGE_OWNER_LOG_ENV] || '').trim();
  if (logPath) {
    try {
      source = patchZcodeUsageSource(source);
      if (!installZcodeUsageOwnerRecorder({ accountRef: env[AIH_ZCODE_SESSION_SCOPE_ENV], logPath,
        fs: fsImpl, warn: (reason) => process.stderr.write(`[aih] ${reason}\n`) })) throw new Error('zcode_usage_owner_scope_invalid');
    } catch (_) {
      process.stderr.write('[aih] zcode_usage_attribution_unavailable\n');
    }
  }
  mainModule._compile(source, resolvedAgentEntry);
}

if (require.main === module) runZcodeSessionAttributionAgent();

module.exports = { runZcodeSessionAttributionAgent };
