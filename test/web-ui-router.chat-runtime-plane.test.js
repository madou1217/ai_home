'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');

function createResponse() {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body = '') { this.body += String(body); }
  };
}

function writeJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

test('web ui router delegates the canonical chat session plane', async () => {
  const res = createResponse();
  const calls = [];
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/chat/sessions/session-1/snapshot',
    url: new URL('http://127.0.0.1:9527/v0/webui/chat/sessions/session-1/snapshot'),
    req: { headers: { host: '127.0.0.1:9527' } },
    res,
    options: {},
    state: {},
    deps: {
      writeJson,
      readRequestBody: async () => null,
      chatRuntimeService: {
        getSnapshot(sessionId) {
          calls.push(sessionId);
          return { sessionId, throughSeq: 3 };
        }
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['session-1']);
  assert.equal(JSON.parse(res.body).snapshot.throughSeq, 3);
});
