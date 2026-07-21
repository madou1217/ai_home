'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  DefaultProviderRuntimeResolver
} = require('../lib/runtime/default-provider-runtime');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createRuntimeState(overrides = {}) {
  return {
    executablePath: '/usr/local/bin/codex',
    realPath: '/opt/codex/bin/codex.js',
    content: '#!/usr/bin/env node\n',
    version: 'codex-cli 1.2.3',
    fileRevision: 1,
    ...overrides
  };
}

function createFs(state) {
  return {
    realpathSync(filePath) {
      if (state.missing) throw new Error(`missing: ${filePath}`);
      return state.realPath;
    },
    statSync(filePath) {
      if (state.missing) throw new Error(`missing: ${filePath}`);
      return {
        isFile: () => true,
        size: Buffer.byteLength(state.content),
        mtimeMs: state.fileRevision,
        ctimeMs: state.fileRevision,
        ino: 42,
        mode: 0o100755
      };
    },
    readFileSync(filePath) {
      if (state.missing) throw new Error(`missing: ${filePath}`);
      return Buffer.from(state.content);
    }
  };
}

function createResolver(state, overrides = {}) {
  return new DefaultProviderRuntimeResolver({
    fs: createFs(state),
    hash: sha256,
    platform: 'linux',
    env: { PATH: '/usr/local/bin' },
    resolveNativeCliPath: () => state.executablePath,
    spawn: () => successfulChild(`${state.version}\n`),
    spawnSync: () => ({ status: 0, stdout: `${state.version}\n`, stderr: '' }),
    ...overrides
  });
}

function successfulChild(stdout, stderr = '') {
  const controlled = createControlledChild();
  setImmediate(() => controlled.succeed(stdout, stderr));
  return controlled.child;
}

function createControlledChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return {
    child,
    succeed(stdout, stderr = '') {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', 0, null);
    },
    fail(error) {
      child.emit('error', error);
    },
    closeKilled() {
      child.killed = true;
      child.emit('close', null, 'SIGTERM');
    }
  };
}

test('resolver delegates default executable lookup and returns a complete descriptor', async () => {
  const state = createRuntimeState();
  const calls = [];
  const env = { PATH: '/custom/bin' };
  const fsImpl = createFs(state);
  const resolver = createResolver(state, {
    env,
    fs: fsImpl,
    resolveNativeCliPath(provider, options) {
      calls.push({ provider, options });
      return state.executablePath;
    }
  });

  const descriptor = await resolver.resolve(' CODEX ', {
    protocolVersion: 'app-server-v2',
    capabilityHash: 'capabilities-v1',
    authRevision: 'auth-v4'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'codex');
  assert.equal(calls[0].options.fs, fsImpl);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.platform, 'linux');
  assert.equal(calls[0].options.projectFallback, false);
  assert.equal(Object.hasOwn(calls[0].options, 'useVersionedPathCache'), false);
  assert.deepEqual(descriptor, {
    provider: 'codex',
    runtimeScope: 'global',
    executablePath: state.executablePath,
    realPath: state.realPath,
    version: state.version,
    binaryHash: sha256(Buffer.from(state.content)),
    fingerprint: descriptor.fingerprint,
    protocolVersion: 'app-server-v2',
    capabilityHash: 'capabilities-v1',
    authRevision: 'auth-v4',
    generation: 1
  });
  assert.match(descriptor.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(descriptor), true);
});

test('resolver caches version until the executable file revision changes', async () => {
  const state = createRuntimeState();
  let versionProbeCount = 0;
  const resolver = createResolver(state, {
    spawn() {
      versionProbeCount += 1;
      return successfulChild(`${state.version}\n`);
    }
  });
  const context = {
    protocolVersion: 'app-server-v2',
    capabilityHash: 'capabilities-v1',
    authRevision: 'auth-v1'
  };

  const first = await resolver.resolve('codex', context);
  const second = await resolver.resolve('codex', context);
  const authChanged = await resolver.resolve('codex', { ...context, authRevision: 'auth-v2' });
  const capabilityChanged = await resolver.resolve('codex', {
    ...context,
    authRevision: 'auth-v2',
    capabilityHash: 'capabilities-v2'
  });

  assert.equal(second, first);
  assert.equal(second.generation, 1);
  assert.equal(versionProbeCount, 1);

  state.fileRevision += 1;
  state.version = 'codex-cli 1.2.4';
  const fileChanged = await resolver.resolve('codex', {
    ...context,
    authRevision: 'auth-v2',
    capabilityHash: 'capabilities-v2'
  });

  assert.equal(authChanged.generation, 2);
  assert.equal(capabilityChanged.generation, 3);
  assert.equal(fileChanged.generation, 4);
  assert.equal(fileChanged.version, 'codex-cli 1.2.4');
  assert.equal(versionProbeCount, 2);
});

test('resolver advances generation for executable path, file, or version changes', async () => {
  const state = createRuntimeState();
  const resolver = createResolver(state);

  const initial = await resolver.resolve('codex');
  state.content = '#!/usr/bin/env node\nconsole.log("changed");\n';
  state.fileRevision += 1;
  const fileChanged = await resolver.resolve('codex');
  state.version = 'codex-cli 1.2.4';
  state.fileRevision += 1;
  const versionChanged = await resolver.resolve('codex');
  state.executablePath = '/custom/bin/codex';
  const pathChanged = await resolver.resolve('codex');

  assert.equal(initial.generation, 1);
  assert.equal(fileChanged.generation, 2);
  assert.notEqual(fileChanged.binaryHash, initial.binaryHash);
  assert.equal(versionChanged.generation, 3);
  assert.equal(pathChanged.generation, 4);
});

test('resolver advances generation for protocol, capability, and auth changes', async () => {
  const state = createRuntimeState();
  const resolver = createResolver(state);

  const initial = await resolver.resolve('codex');
  const protocolChanged = await resolver.resolve('codex', { protocolVersion: 'v2' });
  const capabilityChanged = await resolver.resolve('codex', {
    protocolVersion: 'v2',
    capabilityHash: 'caps-v2'
  });
  const authChanged = await resolver.resolve('codex', {
    protocolVersion: 'v2',
    capabilityHash: 'caps-v2',
    authRevision: 3
  });

  assert.equal(initial.generation, 1);
  assert.equal(protocolChanged.generation, 2);
  assert.equal(capabilityChanged.generation, 3);
  assert.equal(authChanged.generation, 4);
  assert.equal(authChanged.authRevision, '3');
});

test('resolver tracks generation independently for each runtime scope', async () => {
  const state = createRuntimeState();
  const resolver = createResolver(state);

  const accountA = await resolver.resolve('codex', {
    runtimeScope: 'account-a',
    authRevision: 'auth-v1'
  });
  const accountB = await resolver.resolve('codex', {
    runtimeScope: 'account-b',
    authRevision: 'auth-v1'
  });
  const accountAChanged = await resolver.resolve('codex', {
    runtimeScope: 'account-a',
    authRevision: 'auth-v2'
  });
  const accountBAgain = await resolver.resolve('codex', {
    runtimeScope: 'account-b',
    authRevision: 'auth-v1'
  });

  assert.equal(accountA.runtimeScope, 'account-a');
  assert.equal(accountA.generation, 1);
  assert.equal(accountB.generation, 1);
  assert.equal(accountAChanged.generation, 2);
  assert.equal(accountBAgain, accountB);
  assert.equal(accountBAgain.generation, 1);
});

test('resolver fails closed when an injected executable path disappears', async () => {
  const state = createRuntimeState({ missing: true });
  let spawnCalls = 0;
  const resolver = createResolver(state, {
    spawn() {
      spawnCalls += 1;
      throw new Error('must not probe a missing executable');
    }
  });

  await assert.rejects(
    resolver.resolve('codex'),
    (error) => error.code === 'provider_runtime_not_found' && /codex/.test(error.message)
  );
  assert.equal(spawnCalls, 0);
});

test('resolver uses platform launchers for cmd, PowerShell, and JavaScript scripts', async () => {
  const cases = [
    {
      executablePath: 'C:\\Tools\\codex.cmd',
      expectedCommand: 'C:\\Windows\\System32\\cmd.exe',
      expectedArgs: ['/d', '/s', '/c', '"C:\\Tools\\codex.cmd" --version']
    },
    {
      executablePath: 'C:\\Tools\\codex.ps1',
      expectedCommand: 'pwsh.exe',
      expectedArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Tools\\codex.ps1', '--version']
    },
    {
      executablePath: 'C:\\Tools\\codex.js',
      expectedCommand: 'C:\\Program Files\\nodejs\\node.exe',
      expectedArgs: ['C:\\Tools\\codex.js', '--version']
    }
  ];

  for (const item of cases) {
    const state = createRuntimeState({
      executablePath: item.executablePath,
      realPath: item.executablePath
    });
    const calls = [];
    const resolver = createResolver(state, {
      platform: 'win32',
      env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      powershellExecutable: 'pwsh.exe',
      spawn(command, args) {
        calls.push({ command, args });
        return successfulChild('codex-cli 1.2.3\n');
      }
    });

    await resolver.resolve('codex');

    assert.equal(calls[0].command, item.expectedCommand);
    assert.deepEqual(calls[0].args, item.expectedArgs);
  }
});

test('resolver honors a Unix shebang when a PATH hook has a JavaScript suffix', async () => {
  const state = createRuntimeState({
    content: '#!/bin/sh\nexec /opt/codex --version\n'
  });
  const calls = [];
  const resolver = createResolver(state, {
    spawn(command, args) {
      calls.push({ command, args });
      return successfulChild('codex-cli 1.2.3\n');
    }
  });

  const runtime = await resolver.resolve('codex');

  assert.equal(runtime.version, 'codex-cli 1.2.3');
  assert.deepEqual(calls, [{ command: state.realPath, args: ['--version'] }]);
});

test('resolver bounds the provider version probe without rejecting the runtime', async () => {
  const state = createRuntimeState();
  const controlled = createControlledChild();
  const resolver = createResolver(state, {
    versionProbeTimeoutMs: 5,
    spawn: () => controlled.child
  });

  const runtime = await resolver.resolve('codex');

  assert.equal(runtime.version, '');
  assert.equal(controlled.child.killed, true);
});

test('resolver applies the default timeout to version probes', async () => {
  const state = createRuntimeState();
  const calls = [];
  const resolver = createResolver(state, {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return successfulChild(`${state.version}\n`);
    }
  });

  await resolver.resolve('codex');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 1000);
});

test('resolver yields the event loop while the provider version probe is pending', async () => {
  const state = createRuntimeState();
  const controlled = createControlledChild();
  const resolver = createResolver(state, {
    spawn: () => controlled.child
  });
  let settled = false;

  const pending = resolver.resolve('codex').then((runtime) => {
    settled = true;
    return runtime;
  });
  assert.equal(typeof pending.then, 'function');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  controlled.succeed(`${state.version}\n`);
  assert.equal((await pending).version, state.version);
});

test('resolver coalesces concurrent version probes for one executable revision', async () => {
  const state = createRuntimeState();
  const controlled = createControlledChild();
  let spawnCalls = 0;
  const resolver = createResolver(state, {
    spawn() {
      spawnCalls += 1;
      return controlled.child;
    }
  });

  const first = resolver.resolve('codex', { runtimeScope: 'account-a' });
  const second = resolver.resolve('codex', { runtimeScope: 'account-b' });

  assert.equal(spawnCalls, 1);
  controlled.succeed(`${state.version}\n`);
  const [accountA, accountB] = await Promise.all([first, second]);
  assert.equal(accountA.version, state.version);
  assert.equal(accountB.version, state.version);
});

test('resolver starts a new version probe after the executable revision changes', async () => {
  const state = createRuntimeState();
  const probes = [];
  const resolver = createResolver(state, {
    spawn() {
      const controlled = createControlledChild();
      probes.push(controlled);
      return controlled.child;
    }
  });

  const firstPending = resolver.resolve('codex');
  assert.equal(probes.length, 1);
  probes[0].succeed(`${state.version}\n`);
  const first = await firstPending;

  state.fileRevision += 1;
  state.version = 'codex-cli 1.2.4';
  const changedPending = resolver.resolve('codex');
  assert.equal(probes.length, 2);
  probes[1].succeed(`${state.version}\n`);
  const changed = await changedPending;

  assert.equal(first.version, 'codex-cli 1.2.3');
  assert.equal(changed.version, 'codex-cli 1.2.4');
  assert.equal(changed.generation, 2);
});

test('resolver does not publish a stale descriptor when an older revision finishes last', async () => {
  const state = createRuntimeState();
  const probes = [];
  const resolver = createResolver(state, {
    spawn() {
      const controlled = createControlledChild();
      probes.push(controlled);
      return controlled.child;
    }
  });

  const stalePending = resolver.resolve('codex');
  state.fileRevision += 1;
  state.version = 'codex-cli 1.2.4';
  const freshPending = resolver.resolve('codex');
  probes[1].succeed(`${state.version}\n`);
  const fresh = await freshPending;
  probes[0].succeed('codex-cli 1.2.3\n');
  const staleCallerResult = await stalePending;
  const current = await resolver.resolve('codex');

  assert.equal(fresh.version, 'codex-cli 1.2.4');
  assert.strictEqual(staleCallerResult, fresh);
  assert.strictEqual(current, fresh);
});

test('resolver fails soft when an async version probe errors, is killed, or times out', async (t) => {
  await t.test('error', async () => {
    const state = createRuntimeState();
    const controlled = createControlledChild();
    const resolver = createResolver(state, { spawn: () => controlled.child });
    const pending = resolver.resolve('codex');
    controlled.fail(new Error('spawn failed'));
    assert.equal((await pending).version, '');
  });

  await t.test('killed', async () => {
    const state = createRuntimeState();
    const controlled = createControlledChild();
    const resolver = createResolver(state, { spawn: () => controlled.child });
    const pending = resolver.resolve('codex');
    controlled.closeKilled();
    assert.equal((await pending).version, '');
  });

  await t.test('timeout', async () => {
    const state = createRuntimeState();
    const controlled = createControlledChild();
    const resolver = createResolver(state, {
      spawn: () => controlled.child,
      versionProbeTimeoutMs: 5
    });

    const runtime = await resolver.resolve('codex');

    assert.equal(runtime.version, '');
    assert.equal(controlled.child.killed, true);
  });
});

test('resolver reports a missing default runtime without scanning alternatives', async () => {
  const resolver = new DefaultProviderRuntimeResolver({
    resolveNativeCliPath: () => '',
    fs: createFs(createRuntimeState()),
    spawnSync: () => {
      throw new Error('unexpected version probe');
    },
    hash: sha256
  });

  await assert.rejects(
    resolver.resolve('codex'),
    (error) => error.code === 'provider_runtime_not_found' && /codex/.test(error.message)
  );
});

test('resolver does not use a project-local executable when PATH has no provider', async () => {
  const projectExecutable = '/repo/node_modules/.bin/codex';
  const content = '#!/usr/bin/env node\n';
  let versionProbeCount = 0;
  const fsImpl = {
    accessSync(filePath) {
      if (filePath !== projectExecutable) throw new Error(`missing: ${filePath}`);
    },
    statSync(filePath) {
      if (filePath !== projectExecutable) throw new Error(`missing: ${filePath}`);
      return {
        isFile: () => true,
        size: Buffer.byteLength(content),
        mtimeMs: 1,
        ctimeMs: 1,
        ino: 42,
        mode: 0o100755
      };
    }
  };
  const resolver = new DefaultProviderRuntimeResolver({
    env: { PATH: '' },
    fs: fsImpl,
    platform: 'linux',
    nativeCliOptions: { appRoot: '/repo', cwd: '/repo' },
    spawn() {
      versionProbeCount += 1;
      return successfulChild('codex-cli project-local\n');
    },
    spawnSync: () => ({ status: 1, stdout: '', stderr: '' })
  });

  await assert.rejects(
    resolver.resolve('codex'),
    (error) => error.code === 'provider_runtime_not_found'
  );
  assert.equal(versionProbeCount, 0);
});
