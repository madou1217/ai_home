'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const persistentSession = require('../lib/runtime/persistent-session');
const {
  createTransientAuthProjection
} = require('../lib/runtime/transient-auth-projection');
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
  assert.deepEqual(launch.args.slice(0, 2), [
    '--no-warnings',
    '/app/persistent-provider-supervisor-entry.js'
  ]);
  assert.deepEqual(
    parsePersistentProviderSupervisorArgs(launch.args.slice(2)),
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
    removeProjection() { calls.push('remove-projection'); return true; },
    removeRegistry() { calls.push('remove-registry'); return true; }
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

  assert.deepEqual(calls, ['capture', 'reconcile', 'remove-projection', 'remove-registry']);
  assert.equal(result.exitCode, 0);
  assert.equal(processObj.exitCode, 0);
});

test('persistent provider supervisor finalizes once after child error then close', async () => {
  const calls = [];
  const child = createChildDouble();
  const processObj = createProcessDouble();
  const spawnError = new Error('spawn ENOENT');
  spawnError.code = 'ENOENT';
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() { calls.push('capture'); },
    reconcileResources() { calls.push('reconcile'); },
    removeProjection() { calls.push('remove-projection'); return true; },
    removeRegistry() { calls.push('remove-registry'); return true; }
  });

  child.emit('error', spawnError);
  child.emit('close', -2, null);
  const result = await completed;

  assert.deepEqual(calls, ['capture', 'reconcile', 'remove-projection', 'remove-registry']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.childExitCode, -2);
  assert.equal(result.error, spawnError);
  assert.equal(processObj.exitCode, 1);
});

test('persistent provider supervisor finalizes after synchronous spawn failure', async () => {
  const calls = [];
  const processObj = createProcessDouble();
  const spawnError = new Error('spawn failed before child creation');
  const result = await runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn() {
      throw spawnError;
    },
    captureAuth() { calls.push('capture'); },
    reconcileResources() { calls.push('reconcile'); },
    removeProjection() { calls.push('remove-projection'); return true; },
    removeRegistry() { calls.push('remove-registry'); return true; }
  });

  assert.deepEqual(calls, ['capture', 'reconcile', 'remove-projection', 'remove-registry']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.childExitCode, null);
  assert.equal(result.error, spawnError);
  assert.equal(processObj.exitCode, 1);
});

test('persistent provider supervisor preserves launch and cleanup errors together', async () => {
  const calls = [];
  const child = createChildDouble();
  const processObj = createProcessDouble();
  const spawnError = new Error('spawn ENOENT');
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() {
      calls.push('capture');
      throw new Error('auth capture failed');
    },
    reconcileResources() { calls.push('reconcile'); },
    removeProjection() { calls.push('remove-projection'); return true; },
    removeRegistry() { calls.push('remove-registry'); return true; }
  });

  child.emit('error', spawnError);
  child.emit('close', -2, null);
  const result = await completed;

  assert.deepEqual(calls, ['capture', 'reconcile']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'persistent_provider_supervisor_failed');
  assert.equal(result.error.cause, spawnError);
  assert.equal(result.error.errors[0], spawnError);
  assert.equal(result.error.errors[1].code, 'persistent_provider_cleanup_failed');
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
    removeProjection() { calls.push('remove-projection'); return true; },
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
      removeProjection() { calls.push('remove-projection'); return true; },
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
      removeProjection() { calls.push('remove-projection'); return true; },
      removeRegistry() { calls.push('remove'); return false; }
    });
    child.emit('close', 0, null);
    const result = await completed;
    assert.deepEqual(calls, ['capture', 'reconcile', 'remove-projection', 'remove']);
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
    removeProjection() {},
    removeRegistry() { return true; },
    signalNumbers: { SIGTERM: 15 },
    waitForTerminationSettle() {}
  });

  processObj.emit('SIGTERM');
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  const result = await completed;
  assert.equal(result.exitCode, 143);
  assert.equal(processObj.listenerCount('SIGTERM'), 0);
});

test('persistent provider supervisor translates pane SIGHUP into provider process-group termination', async () => {
  const child = createChildDouble();
  const processObj = createProcessDouble();
  processObj.platform = 'darwin';
  processObj.pid = 4242;
  processObj.killCalls = [];
  processObj.kill = (pid, signal) => {
    processObj.killCalls.push([pid, signal]);
    return true;
  };
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() {},
    reconcileResources() {},
    removeProjection() {},
    removeRegistry() { return true; },
    signalNumbers: { SIGHUP: 1, SIGTERM: 15 },
    waitForTerminationSettle() {}
  });

  processObj.emit('SIGHUP');
  assert.deepEqual(processObj.killCalls, [[-4242, 'SIGTERM']]);
  assert.deepEqual(child.killCalls, []);

  // The group signal is delivered back to the supervisor itself. It must be
  // consumed once instead of recursively broadcasting SIGTERM forever.
  processObj.emit('SIGTERM');
  assert.deepEqual(processObj.killCalls, [[-4242, 'SIGTERM']]);
  child.emit('close', null, 'SIGTERM');

  const result = await completed;
  assert.equal(result.signal, 'SIGHUP');
  assert.equal(result.exitCode, 129);
  assert.equal(processObj.listenerCount('SIGHUP'), 0);
  assert.equal(processObj.listenerCount('SIGTERM'), 0);
});

test('persistent provider supervisor removes signal watchers when the group echo is coalesced', async () => {
  const child = createChildDouble();
  const processObj = createProcessDouble();
  processObj.platform = 'darwin';
  processObj.pid = 5252;
  processObj.kill = () => true;
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() {},
    reconcileResources() {},
    removeProjection() {},
    removeRegistry() { return true; },
    signalNumbers: { SIGHUP: 1, SIGTERM: 15 },
    waitForTerminationSettle() {}
  });

  processObj.emit('SIGHUP');
  child.emit('close', null, 'SIGTERM');
  const result = await completed;

  assert.equal(result.exitCode, 129);
  assert.equal(processObj.listenerCount('SIGINT'), 0);
  assert.equal(processObj.listenerCount('SIGTERM'), 0);
  assert.equal(processObj.listenerCount('SIGHUP'), 0);
});

test('persistent provider supervisor waits for signaled descendants before cleanup', async () => {
  const calls = [];
  const child = createChildDouble();
  const processObj = createProcessDouble();
  let releaseSettle;
  const settle = new Promise((resolve) => { releaseSettle = resolve; });
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() { calls.push('capture'); },
    reconcileResources() { calls.push('reconcile'); },
    removeProjection() { calls.push('remove-projection'); },
    removeRegistry() { calls.push('remove-registry'); return true; },
    waitForTerminationSettle() {
      calls.push('settle');
      return settle;
    }
  });

  processObj.emit('SIGHUP');
  child.emit('close', null, 'SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['settle']);

  releaseSettle();
  const result = await completed;
  assert.deepEqual(calls, [
    'settle',
    'capture',
    'reconcile',
    'remove-projection',
    'remove-registry'
  ]);
  assert.equal(result.exitCode, 129);
});

test('persistent provider supervisor reports cleanup errors without constructing a revoked TTY', async () => {
  const child = createChildDouble();
  const processObj = createProcessDouble();
  const writes = [];
  Object.defineProperty(processObj, 'stderr', {
    configurable: true,
    get() {
      throw new Error('revoked tty accessed');
    }
  });
  const completed = runPersistentProviderSupervisor(supervisorContext(), {
    processObj,
    spawn: () => child,
    captureAuth() {
      throw new Error('capture failed');
    },
    reconcileResources() {},
    removeProjection() {},
    removeRegistry() { return true; },
    writeError(output) {
      writes.push(output);
    }
  });

  child.emit('close', 0, null);
  const result = await completed;
  assert.equal(result.exitCode, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /capture failed/);
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
  assert.equal(dependencies.removeProjection(), true);
  assert.equal(dependencies.removeRegistry(), true);
  assert.deepEqual(calls, [
    ['create-store', context.aiHomeDir, context.hostHomeDir],
    ['capture', context.runtimeDir, context.provider, context.accountRef],
    ['reconcile', ensureSessionStoreLinks, context.provider, context.accountRef, context.runtimeDir],
    ['remove', context.aiHomeDir, context.socket, context.session]
  ]);
});

test('production supervisor removes a transient projection after every terminal path', async (t) => {
  const scenarios = [
    {
      name: 'successful close',
      expectedExitCode: 0,
      terminate(child) {
        child.emit('close', 0, null);
      }
    },
    {
      name: 'child spawn error',
      expectedExitCode: 1,
      terminate(child) {
        child.emit('error', new Error('spawn ENOENT'));
        child.emit('close', -2, null);
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-supervisor-host-'));
      const aiHomeDir = path.join(hostHomeDir, '.ai_home');
      fs.mkdirSync(aiHomeDir, { recursive: true });
      subtest.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
      const runtimeDir = createTransientAuthProjection(fs, 'codex', ACCOUNT_REF, { path });
      subtest.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
      const context = supervisorContext({
        provider: 'codex',
        runtimeDir,
        aiHomeDir,
        hostHomeDir,
        socket: persistentSession.deriveSocket('codex', ACCOUNT_REF),
        command: '/usr/local/bin/codex'
      });
      const child = createChildDouble();
      const processObj = createProcessDouble();
      const dependencies = createPersistentProviderSupervisorDependencies(context, {
        fs,
        path,
        processObj,
        spawn: () => child,
        createSessionStoreService: () => ({
          ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0 })
        }),
        writeError() {},
        captureProviderAuth() {},
        reconcileProviderResources() {},
        persistentSessionRegistry: {
          removeEntry() { return true; }
        }
      });

      const completed = runPersistentProviderSupervisor(context, dependencies);
      scenario.terminate(child);
      const result = await completed;

      assert.equal(result.exitCode, scenario.expectedExitCode);
      assert.equal(fs.existsSync(runtimeDir), false);
    });
  }
});
