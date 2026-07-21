'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ChatRuntimeActorRegistry
} = require('../lib/server/chat-runtime-actor-registry');

test('registry depends on one complete provider descriptor resolver', async () => {
  const calls = [];
  const runtimeResolver = {
    resolve(provider, context) {
      calls.push({ provider, context });
      return {
        provider,
        runtimeScope: context.runtimeScope,
        protocolVersion: 'aih-codex-app-server-adapter-v1',
        capabilityHash: 'capability-hash',
        authRevision: 'auth-revision',
        fingerprint: 'runtime-fingerprint',
        generation: 1
      };
    }
  };
  const registry = new ChatRuntimeActorRegistry({
    store: {},
    runtimeResolver,
    driverRegistry: {
      resolve: () => ({ driver: { startTurn: async () => ({}) } })
    }
  });

  const prepared = await registry.prepare({
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1'
  });

  assert.deepEqual(calls, [{
    provider: 'codex', context: { runtimeScope: 'account-1' }
  }]);
  assert.equal(prepared.runtime.protocolVersion, 'aih-codex-app-server-adapter-v1');
  assert.equal(prepared.runtime.capabilityHash, 'capability-hash');
  assert.equal(prepared.runtime.authRevision, 'auth-revision');
});

test('active turn pins its actor until terminal before runtime refresh', async () => {
  let generation = 1;
  let resolveCalls = 0;
  const updates = [];
  class FakeActor {
    constructor() {
      this.turn = { active: false };
      this.disposed = false;
    }
    dispose() { this.disposed = true; }
  }
  const registry = new ChatRuntimeActorRegistry({
    Actor: FakeActor,
    store: { updateRuntimeBinding: (...args) => updates.push(args) },
    runtimeResolver: {
      resolve(provider, context) {
        resolveCalls += 1;
        return runtime(provider, context.runtimeScope, generation);
      }
    },
    driverRegistry: {
      resolve: () => ({ driver: { startTurn: async () => ({}) } })
    }
  });
  const session = {
    sessionId: 'session-pinned', provider: 'codex', executionAccountRef: 'account-1',
    runtimeBinding: {}
  };
  const initialRuntime = runtime('codex', 'account-1', 1);
  const actor = registry.register(session, {
    runtime: initialRuntime,
    entry: { driver: { startTurn: async () => ({}) } }
  });

  actor.turn.active = true;
  generation = 2;
  assert.strictEqual(await registry.acquire(session), actor);
  assert.equal(resolveCalls, 0);
  assert.equal(actor.disposed, false);

  actor.turn.active = false;
  const refreshed = await registry.acquire(session);
  assert.notStrictEqual(refreshed, actor);
  assert.equal(resolveCalls, 1);
  assert.equal(actor.disposed, true);
  assert.equal(updates[0][1].runtimeGeneration, 2);
});

test('runtime refresh retires every idle actor lease in the target scope before driver resolution', async () => {
  let generation = 1;
  let heldLeases = 0;
  class LeaseActor {
    constructor(options) {
      this.driver = options.driver;
      this.turn = { active: false };
      this.disposed = false;
    }
    dispose() {
      this.disposed = true;
      this.driver.dispose();
    }
  }
  const registry = new ChatRuntimeActorRegistry({
    Actor: LeaseActor,
    store: { updateRuntimeBinding() {} },
    runtimeResolver: {
      resolve: (provider, context) => runtime(provider, context.runtimeScope, generation)
    },
    driverRegistry: {
      resolve() {
        if (generation === 2 && heldLeases > 0) {
          throw new Error('stale runtime lease still held');
        }
        heldLeases += 1;
        let released = false;
        return {
          driver: {
            startTurn: async () => ({}),
            dispose() {
              if (released) return false;
              released = true;
              heldLeases -= 1;
              return true;
            }
          }
        };
      }
    }
  });
  const firstSession = session('session-lease-1');
  const secondSession = session('session-lease-2');
  const first = registry.register(firstSession, await registry.prepare(firstSession));
  const second = registry.register(secondSession, await registry.prepare(secondSession));
  assert.equal(heldLeases, 2);

  generation = 2;
  const refreshed = await registry.acquire(firstSession);

  assert.equal(first.disposed, true);
  assert.equal(second.disposed, true);
  assert.notStrictEqual(refreshed, first);
  assert.equal(heldLeases, 1);
  registry.close();
  assert.equal(heldLeases, 0);
});

test('cold concurrent acquisition creates exactly one actor per session', async () => {
  let driverResolutions = 0;
  let runtimeResolutions = 0;
  let actorCreations = 0;
  class FakeActor {
    constructor() {
      actorCreations += 1;
      this.turn = { active: false };
    }
    dispose() {}
  }
  const registry = new ChatRuntimeActorRegistry({
    Actor: FakeActor,
    store: { updateRuntimeBinding() {} },
    runtimeResolver: {
      async resolve(provider, context) {
        runtimeResolutions += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return runtime(provider, context.runtimeScope, 1);
      }
    },
    driverRegistry: {
      resolve() {
        driverResolutions += 1;
        return { driver: { startTurn: async () => ({}) } };
      }
    }
  });
  const session = {
    sessionId: 'session-cold', provider: 'codex', executionAccountRef: 'account-1',
    runtimeBinding: {}
  };

  const [first, second] = await Promise.all([
    registry.acquire(session),
    registry.acquire(session)
  ]);

  assert.strictEqual(first, second);
  assert.equal(runtimeResolutions, 1);
  assert.equal(driverResolutions, 1);
  assert.equal(actorCreations, 1);
});

test('register disposes the prepared driver that loses an existing actor race', async () => {
  const drivers = [];
  const registry = new ChatRuntimeActorRegistry({
    store: {},
    runtimeResolver: {
      resolve(provider, context) {
        return runtime(provider, context.runtimeScope, 1);
      }
    },
    driverRegistry: {
      resolve() {
        const driver = disposableDriver();
        drivers.push(driver);
        return { driver };
      }
    }
  });
  const target = session('session-register-winner');
  const firstPrepared = await registry.prepare(target);
  const secondPrepared = await registry.prepare(target);

  const winner = registry.register(target, firstPrepared);
  const follower = registry.register(target, secondPrepared);

  assert.strictEqual(follower, winner);
  assert.equal(drivers[0].disposed, false);
  assert.equal(drivers[1].disposed, true);
  registry.close();
  assert.equal(drivers[0].disposed, true);
});

test('runtime refresh retires idle actors before acquiring an exclusive provider lease', async () => {
  let generation = 1;
  let leaseOwner = '';
  class FakeActor {
    constructor(options) {
      this.driver = options.driver;
      this.turn = { active: false };
      this.disposed = false;
    }
    dispose() {
      this.disposed = true;
      this.driver.dispose();
    }
  }
  const registry = new ChatRuntimeActorRegistry({
    Actor: FakeActor,
    store: { updateRuntimeBinding() {} },
    runtimeResolver: {
      resolve(provider, context) {
        return runtime(provider, context.runtimeScope, generation);
      }
    },
    driverRegistry: {
      resolve(_provider, { runtime: descriptor }) {
        if (leaseOwner) throw new Error(`provider lease held by ${leaseOwner}`);
        leaseOwner = descriptor.fingerprint;
        return {
          driver: {
            startTurn: async () => ({}),
            dispose() {
              if (leaseOwner === descriptor.fingerprint) leaseOwner = '';
            }
          }
        };
      }
    }
  });
  const firstSession = {
    sessionId: 'session-old-runtime', provider: 'codex', executionAccountRef: 'account-1',
    runtimeBinding: {}
  };
  const firstPrepared = await registry.prepare(firstSession);
  const firstActor = registry.register(firstSession, firstPrepared);

  generation = 2;
  const nextPrepared = await registry.prepare({
    sessionId: 'session-new-runtime', provider: 'codex', executionAccountRef: 'account-1',
    runtimeBinding: {}
  });

  assert.equal(firstActor.disposed, true);
  assert.equal(nextPrepared.runtime.generation, 2);
  assert.equal(leaseOwner, 'fingerprint-2');
  nextPrepared.entry.driver.dispose();
});

test('restart recovery ignores process-local generation when fingerprint is unchanged', async () => {
  let rehydrations = 0;
  class FakeActor {
    constructor() { this.turn = { active: false }; }
    async rehydrate() {
      rehydrations += 1;
      this.turn.active = true;
    }
    dispose() {}
  }
  const registry = new ChatRuntimeActorRegistry({
    Actor: FakeActor,
    store: { updateRuntimeBinding() {} },
    runtimeResolver: {
      resolve: () => runtime('codex', 'account-1', 1, 'stable-fingerprint')
    },
    driverRegistry: {
      resolve: () => ({ driver: { startTurn: async () => ({}) } })
    }
  });
  const session = {
    sessionId: 'session-restart', provider: 'codex', executionAccountRef: 'account-1',
    runtimeBinding: { fingerprint: 'stable-fingerprint', runtimeGeneration: 9 }
  };

  const actor = await registry.acquire(session, {
    recoverable: true,
    activeTurn: { turnId: 'turn-1', runId: 'run-1', state: 'recovering' },
    interactions: [],
    queue: null
  });

  assert.equal(rehydrations, 1);
  assert.equal(actor.turn.active, true);
});

function runtime(provider, runtimeScope, generation, fingerprint) {
  return {
    provider, runtimeScope, generation,
    fingerprint: fingerprint || `fingerprint-${generation}`,
    version: `0.${generation}.0`
  };
}

function session(sessionId) {
  return {
    sessionId,
    provider: 'codex',
    executionAccountRef: 'account-1',
    runtimeBinding: {}
  };
}

function disposableDriver() {
  return {
    disposed: false,
    startTurn: async () => ({}),
    dispose() {
      if (this.disposed) return false;
      this.disposed = true;
      return true;
    }
  };
}
