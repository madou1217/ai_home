#!/usr/bin/env node
'use strict';

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const nodeModule = require('node:module');
const {
  installZcodeSessionScopeFunction,
  patchZcodeAgentSource
} = require('./zcode-session-attribution-hook');
const { installZcodeUsageOwnerRecorder, patchZcodeUsageSource } = require('./zcode-usage-attribution-hook');
const { installZcodeRequestCapture } = require('./zcode-request-capture');
const { readZcodeContextField } = require('./zcode-context');

function runZcodeSessionAttributionAgent(argv = process.argv.slice(2), env = process.env, options = {}) {
  const [agentEntry, ...agentArgs] = Array.isArray(argv) ? argv : [];
  const resolvedAgentEntry = nodePath.resolve(String(agentEntry || '').trim());
  if (!agentEntry || !nodePath.isAbsolute(resolvedAgentEntry)) {
    throw new Error('ZCode session attribution runner requires an absolute agent entry path');
  }

  if (!installZcodeSessionScopeFunction(readZcodeContextField(env, 'scope'))) {
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
    && readZcodeContextField(env, 'bridgeDir') && readZcodeContextField(env, 'bridgeIdentity')) {
    const { createNativeStdioProtocolTap } = require('./native-stdio-protocol-tap');
    const { createZcodeDesktopProtocolBridge } = require('./zcode-desktop-protocol-bridge');
    const { bridgeVersion } = require('./zcode-desktop-bridge-binding');
    const protocol = createNativeStdioProtocolTap({ input: process.stdin, output: process.stdout });
    const bridge = createZcodeDesktopProtocolBridge({ protocol, cwd: process.cwd(), binding: {
      version: bridgeVersion(), provider: 'zcode', accountRef: readZcodeContextField(env, 'scope'),
      identity: readZcodeContextField(env, 'bridgeIdentity'), profileDir: env.HOME,
      mailboxDir: readZcodeContextField(env, 'bridgeDir')
    } });
    bridge.start();
    Object.defineProperty(process, 'stdin', { configurable: true, value: protocol.input });
    Object.defineProperty(process, 'stdout', { configurable: true, value: protocol.output });
    process.once('exit', () => bridge.dispose());
  }

  process.argv = [process.execPath, resolvedAgentEntry, ...agentArgs];
  mainModule.filename = resolvedAgentEntry;
  mainModule.paths = moduleImpl._nodeModulePaths(nodePath.dirname(resolvedAgentEntry));
  // 出站请求取证（默认关闭，由 <aiHomeDir>/run/zcode-request-capture.json 开启）：
  // agent 的模型请求走 `globalThis.fetch`，在编译 agent 之前包一层即可拿到逐字节请求。
  const captureLogPath = String(readZcodeContextField(env, 'requestLog')).trim();
  if (captureLogPath) {
    try {
      installZcodeRequestCapture({ fs: fsImpl, logPath: captureLogPath });
    } catch (_) {
      process.stderr.write('[aih] zcode_request_capture_unavailable\n');
    }
  }
  let source = patchZcodeAgentSource(fsImpl.readFileSync(resolvedAgentEntry, 'utf8'));
  const logPath = String(readZcodeContextField(env, 'usageLog')).trim();
  if (logPath) {
    try {
      source = patchZcodeUsageSource(source);
      if (!installZcodeUsageOwnerRecorder({ accountRef: readZcodeContextField(env, 'scope'), logPath,
        fs: fsImpl, warn: (reason) => process.stderr.write(`[aih] ${reason}\n`) })) throw new Error('zcode_usage_owner_scope_invalid');
    } catch (_) {
      process.stderr.write('[aih] zcode_usage_attribution_unavailable\n');
    }
  }
  mainModule._compile(source, resolvedAgentEntry);
}

if (require.main === module) runZcodeSessionAttributionAgent();

module.exports = { runZcodeSessionAttributionAgent };
