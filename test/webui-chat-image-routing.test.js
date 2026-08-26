'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { handleChatRequest } = require('../lib/server/webui-chat-routes');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');

function createMockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
      return this;
    },
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
      this.writableEnded = true;
      return this;
    }
  };
  return res;
}

test('webui chat routes image generation model to api-proxy instead of native CLI', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-image-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'oauth:agy:test@example.com'
  });

  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    oauthToken: { access_token: 'fake-token', token_type: 'Bearer' }
  });

  // Create fake /v1/chat/completions server to capture the proxy request
  let capturedProxyRequest = null;
  let capturedHeaders = null;
  const mockServer = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        capturedProxyRequest = JSON.parse(body);
        capturedHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gemini-3.1-flash-image',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '![生成的图片](data:image/png;base64,iVBORw0KGgo=)'
            },
            finish_reason: 'stop'
          }]
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  t.after(() => mockServer.close());

  const reqBody = JSON.stringify({
    provider: 'agy',
    accountRef,
    model: 'gemini-3.1-flash-image',
    messages: [{ role: 'user', content: '画一只可爱的猫咪' }],
    stream: false
  });

  const req = {
    method: 'POST',
    url: '/v0/webui/chat',
    headers: { 'content-type': 'application/json' }
  };
  const res = createMockResponse();

  const ctx = {
    req,
    res,
    url: new URL('http://127.0.0.1/v0/webui/chat'),
    aiHomeDir,
    fs,
    state: {
      accounts: {
        agy: [{ accountRef, email: 'test@example.com' }]
      }
    },
    options: {
      port,
      clientKey: 'test-key'
    },
    readRequestBody: async () => Buffer.from(reqBody, 'utf8'),
    writeJson(resObj, statusCode, payload) {
      resObj.statusCode = statusCode;
      resObj.body = JSON.stringify(payload);
      resObj.writableEnded = true;
    },
    createChatEventMeta: (startedAt) => ({ at: Date.now(), startedAt })
  };

  const handled = await handleChatRequest(ctx);
  assert.equal(handled, true);
  assert.ok(capturedProxyRequest, 'Request should be proxied to /v1/chat/completions');
  assert.equal(capturedProxyRequest.model, 'gemini-3.1-flash-image');
  assert.equal(capturedHeaders['x-provider'], 'agy');
  assert.equal(capturedHeaders['x-account-ref'], accountRef);

  const responseJson = JSON.parse(res.body);
  assert.equal(responseJson.ok, true);
  assert.equal(responseJson.content.includes('data:image/png;base64'), true);
  assert.equal(responseJson.model, 'gemini-3.1-flash-image');
});
