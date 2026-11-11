'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { handleWebUiPeerRoutes } = require('../lib/server/webui-peer-routes');

function fakeSseResponse() {
  const response = new EventEmitter();
  response.frames = [];
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = () => {};
  response.write = (chunk) => { response.frames.push(String(chunk)); return true; };
  return response;
}

test('peer inbox watch 用 fs.watch 推变化，不轮询', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-peer-sse-'));
  const pending = path.join(aiHomeDir, 'run', 'peer', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const res = fakeSseResponse();
  const req = new EventEmitter();
  const handled = handleWebUiPeerRoutes({
    method: 'GET',
    pathname: '/v0/webui/peer/messages/watch',
    res,
    req,
    aiHomeDir,
    url: new URL('http://localhost/v0/webui/peer/messages/watch'),
    writeJson: () => {}
  });
  assert.equal(handled, true);
  assert.match(res.frames.join(''), /"type":"ready"/);

  fs.writeFileSync(path.join(pending, 'msg-1.json'), '{}');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.match(res.frames.join(''), /"type":"peer-changed"/);
  res.emit('close');
});
