#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fse = require('fs-extra');
const { spawn } = require('node:child_process');
const { captureProviderAuth } = require('../../../account/native-auth-projection');
const persistentSessionRegistry = require('../../../runtime/persistent-session-registry');
const { reconcileProviderResources } = require('../../../runtime/provider-resource-reconciliation');
const { AI_CLI_CONFIGS } = require('../ai-cli/provider-registry');
const { createSessionStoreService } = require('../session-store');
const {
  parsePersistentProviderSupervisorArgs,
  runPersistentProviderSupervisor
} = require('./persistent-provider-supervisor');

function createPersistentProviderSupervisorDependencies(context, options = {}) {
  const fsImpl = options.fs || fs;
  const fseImpl = options.fse || fse;
  const pathImpl = options.path || path;
  const processObj = options.processObj || process;
  const buildSessionStore = options.createSessionStoreService || createSessionStoreService;
  const captureAuth = options.captureProviderAuth || captureProviderAuth;
  const reconcileResources = options.reconcileProviderResources || reconcileProviderResources;
  const registry = options.persistentSessionRegistry || persistentSessionRegistry;
  const sessionStore = buildSessionStore({
    fs: fsImpl,
    fse: fseImpl,
    path: pathImpl,
    processObj,
    aiHomeDir: context.aiHomeDir,
    hostHomeDir: context.hostHomeDir,
    cliConfigs: options.cliConfigs || AI_CLI_CONFIGS,
    getProfileDir: () => context.runtimeDir,
    ensureDir: (dirPath) => fsImpl.mkdirSync(dirPath, { recursive: true })
  });

  return {
    path: pathImpl,
    processObj,
    spawn: options.spawn || spawn,
    signalNumbers: options.signalNumbers || os.constants.signals,
    captureAuth: () => captureAuth(fsImpl, context.runtimeDir, context.provider, {
      path: pathImpl,
      aiHomeDir: context.aiHomeDir,
      accountRef: context.accountRef,
      processObj
    }),
    reconcileResources: () => reconcileResources(
      sessionStore.ensureSessionStoreLinks,
      context.provider,
      context.accountRef,
      { projectionRoot: context.runtimeDir }
    ),
    removeRegistry: () => registry.removeEntry(
      context.aiHomeDir,
      context.socket,
      context.session,
      { fs: fsImpl }
    )
  };
}

function runPersistentProviderSupervisorEntry(argv = process.argv.slice(2), options = {}) {
  const context = parsePersistentProviderSupervisorArgs(argv, { path: options.path || path });
  const createDependencies = options.createDependencies
    || createPersistentProviderSupervisorDependencies;
  const runSupervisor = options.runSupervisor || runPersistentProviderSupervisor;
  const dependencies = createDependencies(context, options);
  return runSupervisor(context, dependencies);
}

if (require.main === module) {
  Promise.resolve()
    .then(() => runPersistentProviderSupervisorEntry())
    .catch((error) => {
      const message = String((error && error.message) || error || 'unknown_error');
      try { process.stderr.write(`\n[aih] Persistent provider supervisor failed: ${message}\n`); } catch (_error) {}
      process.exitCode = 1;
    });
}

module.exports = {
  createPersistentProviderSupervisorDependencies,
  runPersistentProviderSupervisorEntry
};
