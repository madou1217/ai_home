'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  handleEgressUpstreamRequest,
  matchEgressUpstreamRoute,
  emitEgressUpstreamChanged
} = require('../lib/server/webui-egress-upstream-routes');

function fakeSseResponse() {
  const response = new EventEmitter();
  response.frames = [];
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = () => {};
  response.write = (chunk) => { response.frames.push(String(chunk)); return true; };
  return response;
}

test('egress upstream watch 是事件源，不轮询', async () => {
  assert.equal(matchEgressUpstreamRoute('GET', '/v0/webui/egress-upstreams/watch'), true);
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-egress-sse-'));
  const res = fakeSseResponse();
  const req = new EventEmitter();
  await handleEgressUpstreamRequest({
    method: 'GET',
    pathname: '/v0/webui/egress-upstreams/watch',
    url: new URL('http://localhost/v0/webui/egress-upstreams/watch'),
    req,
    res,
    aiHomeDir,
    writeJson: () => {}
  });
  assert.match(res.frames.join(''), /"type":"ready"/);

  emitEgressUpstreamChanged('policy');
  assert.match(res.frames.join(''), /"type":"egress-upstreams-changed"/);
  assert.match(res.frames.join(''), /"reason":"policy"/);
  res.emit('close');
});
