'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { startOauthLoopbackCallbackServer } = require('../lib/server/oauth-loopback-callback');

function getText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    }).on('error', reject);
  });
}

test('startOauthLoopbackCallbackServer captures local oauth callback and returns success html', async () => {
  let capturedUrl = '';
  let resolveListening;
  const listeningPromise = new Promise((resolve) => {
    resolveListening = resolve;
  });

  const handle = startOauthLoopbackCallbackServer({
    redirectUri: 'http://127.0.0.1:0/auth/callback',
    onListening(info) {
      resolveListening(info);
    },
    async onCallback(callbackUrl) {
      capturedUrl = callbackUrl;
      return { ok: true };
    }
  });

  try {
    const listeningInfo = await listeningPromise;
    assert.ok(listeningInfo && listeningInfo.url);

    const response = await getText(`${listeningInfo.url}?code=ok&state=s-1`);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /授权成功/);
    assert.match(capturedUrl, /code=ok/);
    assert.match(capturedUrl, /state=s-1/);
  } finally {
    handle.close();
  }
});

test('startOauthLoopbackCallbackServer reports readiness without consuming empty callback visits', async () => {
  let callbackCalled = false;
  let resolveListening;
  const listeningPromise = new Promise((resolve) => {
    resolveListening = resolve;
  });

  const handle = startOauthLoopbackCallbackServer({
    redirectUri: 'http://127.0.0.1:0/auth/callback',
    onListening(info) {
      resolveListening(info);
    },
    async onCallback() {
      callbackCalled = true;
      return { ok: true };
    }
  });

  try {
    const listeningInfo = await listeningPromise;
    const response = await getText(listeningInfo.url);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /本地授权回调已就绪/);
    assert.equal(callbackCalled, false);
  } finally {
    handle.close();
  }
});
