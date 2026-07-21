'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const path = require('node:path');
const {
  buildPersistentProviderSupervisorLaunch,
  parsePersistentProviderSupervisorArgs,
  runPersistentProviderSupervisor,
  shouldWrapPersistentProviderLaunch
} = require('../lib/cli/services/pty/persistent-provider-supervisor');
const {
  createPersistentProviderSupervisorDependencies
} = require('../lib/cli/services/pty/persistent-provider-supervisor-entry');

const ACCOUNT_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';

function createProcessDouble(env = {}) {
  const processObj = new EventEmitter();
  processObj.env = { ...env };
  processObj.exitCode = undefined;
  processObj.cwd = () => '/workspace/project';
  processObj.stderr = { write() {} };
  return processObj;
}

function createChildDouble() {
  const child = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

function supervisorContext(overrides = {}) {
  return {
    provider: 'agy',
    accountRef: ACCOUNT_REF,
    runtimeDir: '/host/.ai_home/run/auth-projections/agy/acct_aaaaaaaaaaaaaaaaaaaa',
    aiHomeDir: '/host/.ai_home',
    hostHomeDir: '/host',
    socket: 'aih-agy-acct_aaaaaaaaaaaaaaaaaaaa',
    session: 'p-project-abc123',
    command: '/usr/local/bin/agy',
    args: ['--model', 'gemini pro', '--', 'literal'],
    ...overrides
  };
}

test('persistent provider supervisor wraps only newly-created auth projections', () => {
  const base = {
    usesAuthProjection: true,
    gateway: false,
    isLogin: false
  };
  for (const action of [
    'new',
    'new-compatible',
    'new-completed'
  ]) {
    assert.equal(shouldWrapPersistentProviderLaunch({ ...base, action }), true, action);
  }
  for (const action of ['reattach', 'takeover', 'mirror']) {
    assert.equal(shouldWrapPersistentProviderLaunch({ ...base, action }), false, action);
  }
  assert.equal(shouldWrapPersistentProviderLaunch({ ...base, action: 'new', gateway: true }), false);
  assert.equal(shouldWrapPersistentProviderLaunch({ ...base, action: 'new', isLogin: true }), false);
  assert.equal(shouldWrapPersistentProviderLaunch({ ...base, action: 'new', usesAuthProjection: false }), false);
});

test('persistent provider supervisor argv round-trips metadata and inner launch after --', () => {
  const context = supervisorContext();
  const launch = buildPersistentProviderSupervisorLaunch(
    { command: context.command, args: context.args },
    context,
    {
      nodeExecPath: '/runtime/node',
      entryPath: '/app/persistent-provider-supervisor-entry.js'
    }
  );

  assert.equal(launch.command, '/runtime/node');
  assert.equal(launch.args[0], '/app/persistent-provider-supervisor-entry.js');
  assert.deepEqual(
    parsePersistentProviderSupervisorArgs(launch.args.slice(1)),
    context
  );
});

test('persistent provider supervisor rejects sibling registry sockets and fake host homes', () => {
  const build = (overrides) => buildPersistentProviderSupervisorLaunch(
    { command: '/usr/local/bin/agy', args: [] },
    supervisorContext(overrides),
    {
      nodeExecPath: '/runtime/node',
      entryPath: '/app/persistent-provider-supervisor-entry.js'
    }
  );

  assert.throws(
    () => build({ socket: 'aih-agy-acct_bbbbbbbbbbbbbbbbbbbb' }),
    (error) => error && error.code === 'persistent_provider_supervisor_registry_invalid'
  );
  assert.throws(
    () => build({ hostHomeDir: supervisorContext().runtimeDir }),
    (error) => error && error.code === 'persistent_provider_supervisor_path_invalid'
  );
});

test('persistent provider supervisor inherits stdio/env then finalizes in capture-reconcile-remove order', async () => {
  const calls = [];
  const child = createChildDouble();
  const processObj = createProcessDouble({ TOKEN: 'secret', HOME: '/projection' });
  let spawnCall = null;
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    captureAuth() { calls.push('capture'); },
    reconcileResources() { calls.push('reconcile'); },
    removeRegistry() { calls.push('remove'); return true; }
  });

  assert.deepEqual(spawnCall, {
    command: '/usr/local/bin/agy',
    args: ['--model', 'gemini pro', '--', 'literal'],
    options: {
      cwd: '/workspace/project',
      env: processObj.env,
      stdio: 'inherit'
    }
  });
  child.emit('close', 0, null);
  const result = await completed;

  assert.deepEqual(calls, ['capture', 'reconcile', 'remove']);
  assert.equal(result.exitCode, 0);
  assert.equal(processObj.exitCode, 0);
});

test('capture failure still reconciles resources but retains registry and exits nonzero', async () => {
  const calls = [];
  const child = createChildDouble();
  const processObj = createProcessDouble();
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() {
      calls.push('capture');
      throw new Error('auth capture failed');
    },
    reconcileResources() { calls.push('reconcile'); },
    removeRegistry() { calls.push('remove'); return true; }
  });

  child.emit('close', 0, null);
  const result = await completed;

  assert.deepEqual(calls, ['capture', 'reconcile']);
  assert.equal(result.exitCode, 1);
  assert.equal(processObj.exitCode, 1);
  assert.match(String(result.error && result.error.message), /auth capture failed/);
});

test('reconciliation or registry removal failure retains the current registry', async (t) => {
  await t.test('reconciliation failure', async () => {
    const calls = [];
    const child = createChildDouble();
    const processObj = createProcessDouble();
    const completed = runPersistentProviderSupervisor(supervisorContext(), {
      processObj,
      spawn: () => child,
      captureAuth() { calls.push('capture'); },
      reconcileResources() {
        calls.push('reconcile');
        throw new Error('unresolved projection');
      },
      removeRegistry() { calls.push('remove'); return true; }
    });
    child.emit('close', 0, null);
    const result = await completed;
    assert.deepEqual(calls, ['capture', 'reconcile']);
    assert.equal(result.exitCode, 1);
  });

  await t.test('registry removal failure', async () => {
    const calls = [];
    const child = createChildDouble();
    const processObj = createProcessDouble();
    const completed = runPersistentProviderSupervisor(supervisorContext(), {
      processObj,
      spawn: () => child,
      captureAuth() { calls.push('capture'); },
      reconcileResources() { calls.push('reconcile'); },
      removeRegistry() { calls.push('remove'); return false; }
    });
    child.emit('close', 0, null);
    const result = await completed;
    assert.deepEqual(calls, ['capture', 'reconcile', 'remove']);
    assert.equal(result.exitCode, 1);
  });
});

test('persistent provider supervisor forwards termination signals and preserves signaled exit semantics', async () => {
  const child = createChildDouble();
  const processObj = createProcessDouble();
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() {},
    reconcileResources() {},
    removeRegistry() { return true; },
    signalNumbers: { SIGTERM: 15 }
  });

  processObj.emit('SIGTERM');
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  const result = await completed;
  assert.equal(result.exitCode, 143);
  assert.equal(processObj.listenerCount('SIGTERM'), 0);
});

test('production supervisor dependencies use the explicit host/projection roots', () => {
  const calls = [];
  const context = supervisorContext();
  const ensureSessionStoreLinks = () => ({ migrated: 1, linked: 2 });
  const dependencies = createPersistentProviderSupervisorDependencies(context, {
    fs: {},
    fse: {},
    path,
    processObj: {},
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    createSessionStoreService(options) {
      calls.push(['create-store', options.aiHomeDir, options.hostHomeDir]);
      return { ensureSessionStoreLinks };
    },
    captureProviderAuth(_fs, runtimeDir, provider, options) {
      calls.push(['capture', runtimeDir, provider, options.accountRef]);
    },
    reconcileProviderResources(reconcile, provider, accountRef, options) {
      calls.push(['reconcile', reconcile, provider, accountRef, options.projectionRoot]);
    },
    persistentSessionRegistry: {
      removeEntry(aiHomeDir, socket, session) {
        calls.push(['remove', aiHomeDir, socket, session]);
        return true;
      }
    }
  });

  dependencies.captureAuth();
  dependencies.reconcileResources();
  assert.equal(dependencies.removeRegistry(), true);
  assert.deepEqual(calls, [
    ['create-store', context.aiHomeDir, context.hostHomeDir],
    ['capture', context.runtimeDir, context.provider, context.accountRef],
    ['reconcile', ensureSessionStoreLinks, context.provider, context.accountRef, context.runtimeDir],
    ['remove', context.aiHomeDir, context.socket, context.session]
  ]);
});
