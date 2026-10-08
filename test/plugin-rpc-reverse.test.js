'use strict';

// 协议 v2 反向调用：宿主处理父调用时经同一连接回调客户端。
// 只能挂在仍在进行中的父调用下面；父调用结束、反向调用超时、连接断开都要让另一端的 handler 真的 abort。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRpcServer } = require('../lib/plugins/transport/rpc-server');
const { createRpcClient } = require('../lib/plugins/transport/rpc-client');

const TOKEN = 'a'.repeat(64);

function socketPath(dir) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\aih-plugin-reverse-${path.basename(dir)}` : path.join(dir, 'r.sock');
}

async function pair(serverOnCall, clientOnCall) {
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'aihr-'));
  const address = socketPath(dir);
  const server = createRpcServer({ socketPath: address, token: TOKEN, onCall: serverOnCall });
  await server.listen();
  const client = createRpcClient({ socketPath: address, token: TOKEN, onCall: clientOnCall });
  return {
    server,
    client,
    async close() {
      client.close();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function abortedWith(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(signal.reason);
    else signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
  });
}

test('a host call can call back into the client under its parent and use the answer', async () => {
  const seen = [];
  const rpc = await pair(
    async (method, value, context) => {
      const reply = await context.callClient('gateway.next', { step: value.step + 1 }, { payload: Buffer.from('x') });
      return { value: { outer: value.step, inner: reply.value } };
    },
    async (method, value, context) => {
      seen.push({ method, parent: context.parent });
      return { value: { echoed: value.step }, payload: Buffer.from('reply') };
    }
  );
  try {
    const result = await rpc.client.call('invoke', { step: 1 });
    assert.deepEqual(result.value, { outer: 1, inner: { echoed: 2 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'gateway.next');
    assert.equal(typeof seen[0].parent, 'string');
    assert.equal(rpc.client.inbound(), 0);
  } finally {
    await rpc.close();
  }
});

test('reverse calls are refused once the parent call has finished', async () => {
  let escaped = null;
  const rpc = await pair(
    async (method, value, context) => {
      escaped = context.callClient;
      return { value: 'done' };
    },
    async () => ({ value: 'should not run' })
  );
  try {
    await rpc.client.call('invoke', {});
    await assert.rejects(() => Promise.resolve().then(() => escaped('gateway.next', {})), { code: 'plugin_rpc_parent_unknown' });
  } finally {
    await rpc.close();
  }
});

test('a client without a reverse-call handler answers method_unknown immediately', async () => {
  const rpc = await pair(
    async (method, value, context) => {
      try {
        await context.callClient('gateway.next', {}, { timeoutMs: 5000 });
        return { value: 'unexpected' };
      } catch (error) {
        return { value: error.code };
      }
    },
    null
  );
  try {
    const started = Date.now();
    const result = await rpc.client.call('invoke', {});
    assert.equal(result.value, 'plugin_rpc_method_unknown');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await rpc.close();
  }
});

test('cancelling the parent aborts the client-side reverse handler and the host-side reverse call', async () => {
  let hostReverseError = null;
  let clientAbort = null;
  let reverseStarted;
  const started = new Promise((resolve) => { reverseStarted = resolve; });
  const rpc = await pair(
    async (method, value, context) => {
      try {
        await context.callClient('gateway.next', {}, { timeoutMs: 10000 });
      } catch (error) {
        hostReverseError = error;
      }
      return { value: 'late' };
    },
    async (method, value, context) => {
      reverseStarted();
      clientAbort = await abortedWith(context.signal);
      return { value: 'never sent' };
    }
  );
  try {
    const controller = new AbortController();
    const call = rpc.client.call('invoke', {}, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(call, { code: 'plugin_rpc_cancelled' });
    assert.equal(clientAbort.code, 'plugin_rpc_cancelled');
    // 宿主收到父调用的 cancel 后，挂在下面的反向调用随父调用结束而被取消。
    for (let index = 0; index < 50 && !hostReverseError; index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hostReverseError && hostReverseError.code, 'plugin_rpc_cancelled');
    assert.equal(rpc.client.inbound(), 0);
  } finally {
    await rpc.close();
  }
});

test('a reverse call that outlives its own timeout is cancelled on the client side', async () => {
  let clientAbort = null;
  const rpc = await pair(
    async (method, value, context) => {
      try {
        await context.callClient('gateway.next', {}, { timeoutMs: 50 });
        return { value: 'unexpected' };
      } catch (error) {
        return { value: error.code };
      }
    },
    async (method, value, context) => {
      clientAbort = await abortedWith(context.signal);
      return { value: 'never sent' };
    }
  );
  try {
    const result = await rpc.client.call('invoke', {});
    assert.equal(result.value, 'plugin_rpc_timeout');
    for (let index = 0; index < 50 && !clientAbort; index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    // 客户端按同一 deadline 自己到期，或先收到宿主的 cancel：两种都必须让 handler abort。
    assert.ok(['plugin_rpc_cancelled', 'plugin_rpc_timeout'].includes(clientAbort && clientAbort.code));
  } finally {
    await rpc.close();
  }
});

test('a client-side reverse handler failure reaches the host as a typed error', async () => {
  const rpc = await pair(
    async (method, value, context) => {
      try {
        await context.callClient('gateway.next', {});
        return { value: 'unexpected' };
      } catch (error) {
        return { value: error.code };
      }
    },
    async () => {
      const error = new Error('upstream refused');
      error.code = 'gateway_upstream_failed';
      throw error;
    }
  );
  try {
    const result = await rpc.client.call('invoke', {});
    assert.equal(result.value, 'gateway_upstream_failed');
  } finally {
    await rpc.close();
  }
});
