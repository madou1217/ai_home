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

  process.argv = [process.execPath, resolvedAgentEntry, ...agentArgs];
  mainModule.filename = resolvedAgentEntry;
  mainModule.paths = moduleImpl._nodeModulePaths(nodePath.dirname(resolvedAgentEntry));
  const source = fsImpl.readFileSync(resolvedAgentEntry, 'utf8');
  mainModule._compile(patchZcodeAgentSource(source), resolvedAgentEntry);
}

if (require.main === module) runZcodeSessionAttributionAgent();

module.exports = { runZcodeSessionAttributionAgent };
