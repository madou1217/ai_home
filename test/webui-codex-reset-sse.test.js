'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { handleWebUiCodexResetCreditRoutes } = require('../lib/server/webui-codex-reset-credit-routes');

function fakeResponse() {
  const response = new EventEmitter();
  response.frames = [];
  response.destroyed = false;
  response.writableEnded = false;
  response.setHeader = () => {};
  response.writeHead = () => {};
  response.write = (chunk) => { response.frames.push(String(chunk)); return true; };
  response.end = () => { response.writableEnded = true; response.emit('close'); };
  return response;
}

test('Codex reset operation watch 推终态后关闭 SSE', async () => {
  const response = fakeResponse();
  const handled = await handleWebUiCodexResetCreditRoutes({
    method: 'GET',
    pathname: '/v0/webui/accounts/codex/acct_0123456789abcdef/reset-operations/op-1/watch',
    req: new EventEmitter(),
    res: response,
    writeJson: () => {},
    deps: {
      codexResetCreditService: {
        getOperation: () => ({ operationId: 'op-1', status: 'succeeded', outcome: 'reset' })
      }
    }
  });
  assert.equal(handled, true);
  const body = response.frames.join('');
  assert.match(body, /"type":"operation"/);
  assert.match(body, /"status":"succeeded"/);
  assert.equal(response.writableEnded, true);
});
