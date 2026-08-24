'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchRemoteImage,
  __private: { createPinnedLookup }
} = require('../lib/server/image-studio-remote-image');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function headers(values = {}) {
  return {
    get(name) {
      return values[String(name || '').toLowerCase()] || null;
    }
  };
}

test('remote image fetch blocks untrusted private and metadata targets before transport', async () => {
  let calls = 0;
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.7',
    '::1',
    '::ffff:7f00:1',
    '2002:7f00:1::'
  ]) {
    await assert.rejects(
      fetchRemoteImage({
        url: 'https://cdn.example/image.png',
        maxBytes: 1024,
        resolveHost: async () => [address],
        fetchWithTimeout: async () => {
          calls += 1;
          throw new Error('must not fetch blocked target');
        }
      }),
      (error) => error.code === 'image_asset_url_blocked'
    );
  }
  assert.equal(calls, 0);
});

test('remote image fetch permits the exact configured local provider origin', async () => {
  let calls = 0;
  const result = await fetchRemoteImage({
    url: 'http://127.0.0.1:11434/assets/image.png',
    maxBytes: 1024,
    trustedOrigins: ['http://127.0.0.1:11434'],
    resolveHost: async () => ['127.0.0.1'],
    fetchWithTimeout: async (_url, init) => {
      calls += 1;
      assert.equal(init.redirect, 'manual');
      return {
        ok: true,
        status: 200,
        headers: headers({ 'content-type': 'image/png', 'content-length': String(PNG_BYTES.length) }),
        async arrayBuffer() {
          return PNG_BYTES;
        }
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(result.bytes, PNG_BYTES);
});

test('remote image fetch pins the vetted DNS result into the transport dispatcher', async () => {
  let closed = false;
  const dispatcher = {
    async close() {
      closed = true;
    }
  };
  const result = await fetchRemoteImage({
    url: 'https://cdn.example/image.png',
    maxBytes: 1024,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    createPinnedDispatcher({ hostname, addresses }) {
      assert.equal(hostname, 'cdn.example');
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
      return dispatcher;
    },
    fetchWithTimeout: async (_url, init) => {
      assert.equal(init.dispatcher, dispatcher);
      return {
        ok: true,
        status: 200,
        headers: headers({ 'content-type': 'image/png' }),
        async arrayBuffer() {
          return PNG_BYTES;
        }
      };
    }
  });

  assert.equal(result.mimeType, 'image/png');
  assert.equal(closed, true);
});

test('remote image pinned lookup returns only vetted addresses for the original hostname', async () => {
  assert.equal(typeof createPinnedLookup, 'function');
  const lookup = createPinnedLookup('cdn.example', [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ]);
  const records = await new Promise((resolve, reject) => {
    lookup('cdn.example', { all: true }, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  assert.deepEqual(records, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ]);
});

test('remote image fetch enforces the byte cap while reading the response stream', async () => {
  let cancelled = false;
  const chunks = [Buffer.alloc(6), Buffer.alloc(6)];
  await assert.rejects(
    fetchRemoteImage({
      url: 'https://cdn.example/image.png',
      maxBytes: 10,
      resolveHost: async () => ['93.184.216.34'],
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        headers: headers({ 'content-type': 'image/png' }),
        body: {
          getReader() {
            let index = 0;
            return {
              async read() {
                if (index >= chunks.length) return { done: true, value: undefined };
                return { done: false, value: chunks[index++] };
              },
              async cancel() {
                cancelled = true;
              },
              releaseLock() {}
            };
          }
        }
      })
    }),
    (error) => error.code === 'image_asset_too_large' && error.statusCode === 413
  );
  assert.equal(cancelled, true);
});

test('remote image fetch times out and disposes a stalled arrayBuffer fallback', async () => {
  let cancelled = false;
  await assert.rejects(
    fetchRemoteImage({
      url: 'https://cdn.example/image.png',
      maxBytes: 1024,
      timeoutMs: 10,
      resolveHost: async () => ['93.184.216.34'],
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        headers: headers({ 'content-type': 'image/png' }),
        body: {
          async cancel() {
            cancelled = true;
          }
        },
        async arrayBuffer() {
          return new Promise(() => {});
        }
      })
    }),
    (error) => error.code === 'image_asset_read_timeout' && error.statusCode === 504
  );
  assert.equal(cancelled, true);
});

test('remote image fetch times out and cancels a stalled response stream', async () => {
  let cancelled = false;
  await assert.rejects(
    fetchRemoteImage({
      url: 'https://cdn.example/image.png',
      maxBytes: 1024,
      timeoutMs: 10,
      resolveHost: async () => ['93.184.216.34'],
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        headers: headers({ 'content-type': 'image/png' }),
        body: {
          getReader() {
            return {
              async read() {
                return new Promise(() => {});
              },
              async cancel() {
                cancelled = true;
              },
              releaseLock() {}
            };
          }
        }
      })
    }),
    (error) => error.code === 'image_asset_read_timeout' && error.statusCode === 504
  );
  assert.equal(cancelled, true);
});

test('remote image fetch revalidates redirects and blocks a public-to-private hop', async () => {
  let calls = 0;
  await assert.rejects(
    fetchRemoteImage({
      url: 'https://cdn.example/start',
      maxBytes: 1024,
      resolveHost: async (hostname) => hostname === 'cdn.example' ? ['93.184.216.34'] : ['127.0.0.1'],
      fetchWithTimeout: async () => {
        calls += 1;
        return {
          ok: false,
          status: 302,
          headers: headers({ location: 'http://127.0.0.1:9527/readyz' }),
          body: { async cancel() {} }
        };
      }
    }),
    (error) => error.code === 'image_asset_url_blocked'
  );
  assert.equal(calls, 1);
});

test('remote image fetch rejects a declared image mime that disagrees with the bytes', async () => {
  await assert.rejects(
    fetchRemoteImage({
      url: 'https://cdn.example/image.png',
      maxBytes: 1024,
      resolveHost: async () => ['93.184.216.34'],
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        headers: headers({ 'content-type': 'image/jpeg' }),
        async arrayBuffer() {
          return PNG_BYTES;
        }
      })
    }),
    (error) => error.code === 'invalid_image_output' && error.statusCode === 502
  );
});
