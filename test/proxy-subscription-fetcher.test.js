'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { SubscriptionFetcher } = require('../lib/cli/services/toolkit/proxy-pool/subscription-fetcher');

test('SubscriptionFetcher blocks link-local metadata targets before issuing a request', async () => {
  let requestCalls = 0;
  const fetcher = new SubscriptionFetcher({
    resolveHost: async () => ['169.254.169.254'],
    requestImpl: async () => {
      requestCalls += 1;
      throw new Error('must not request metadata');
    }
  });

  await assert.rejects(
    fetcher.fetch('https://subscription.example/proxies'),
    (error) => error.code === 'subscription_url_blocked'
  );
  assert.equal(requestCalls, 0);
});

test('SubscriptionFetcher blocks loopback and private network targets before issuing a request', async () => {
  for (const address of ['127.0.0.1', '10.0.0.8', '172.16.4.2', '192.168.1.9', '::1', 'fd00::10']) {
    let requestCalls = 0;
    const fetcher = new SubscriptionFetcher({
      resolveHost: async () => [address],
      requestImpl: async () => {
        requestCalls += 1;
        throw new Error('must not request a non-public address');
      }
    });

    await assert.rejects(
      fetcher.fetch('https://subscription.example/proxies'),
      (error) => error.code === 'subscription_url_blocked'
    );
    assert.equal(requestCalls, 0, address);
  }
});

test('SubscriptionFetcher pins requests to the public addresses that passed URL policy', async () => {
  const dispatcher = { async close() {} };
  const calls = [];
  const fetcher = new SubscriptionFetcher({
    resolveHost: async () => ['93.184.216.34'],
    dispatcherFactory(addresses) {
      calls.push({ type: 'dispatcher', addresses });
      return dispatcher;
    },
    requestImpl: async (_url, options) => {
      calls.push({ type: 'request', dispatcher: options.dispatcher });
      return { statusCode: 200, headers: {}, body: Readable.from(['ok']) };
    }
  });

  const result = await fetcher.fetch('https://subscription.example/proxies');

  assert.equal(result.content, 'ok');
  assert.deepEqual(calls, [
    { type: 'dispatcher', addresses: ['93.184.216.34'] },
    { type: 'request', dispatcher }
  ]);
});

test('SubscriptionFetcher enforces the response byte limit while streaming', async () => {
  const body = Readable.from([Buffer.alloc(5, 'a'), Buffer.alloc(5, 'b')]);
  const fetcher = new SubscriptionFetcher({
    maxResponseBytes: 8,
    resolveHost: async () => ['93.184.216.34'],
    requestImpl: async () => ({ statusCode: 200, headers: {}, body })
  });

  await assert.rejects(
    fetcher.fetch('http://subscription.example/subscription'),
    (error) => error.code === 'subscription_response_too_large'
  );
  assert.equal(body.destroyed, true);
});

test('SubscriptionFetcher bounds redirects and disposes redirect bodies', async () => {
  let dumpCalls = 0;
  let requestCalls = 0;
  const fetcher = new SubscriptionFetcher({
    maxRedirects: 1,
    resolveHost: async () => ['93.184.216.34'],
    requestImpl: async () => {
      requestCalls += 1;
      return {
        statusCode: 302,
        headers: { location: `/redirect-${requestCalls}` },
        body: { async dump() { dumpCalls += 1; } }
      };
    }
  });

  await assert.rejects(
    fetcher.fetch('http://subscription.example/start'),
    (error) => error.code === 'subscription_redirect_limit_exceeded'
  );
  assert.equal(requestCalls, 2);
  assert.equal(dumpCalls, 2);
});
