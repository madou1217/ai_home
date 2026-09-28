'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const test = require('node:test');

const {
  sendRawUpstreamResponse,
  writeGeneralUpstreamResponseHeaders
} = require('../lib/server/upstream-endpoints-headers');

function fakeResponse() {
  const headers = {};
  return {
    headers,
    statusCode: 0,
    body: null,
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    end(body) { this.body = body; }
  };
}

// 回归：Claude Code 报 "ZlibError fetching .../v1/messages"。fetch 已经解压上游 gzip，
// 但旧实现把上游 content-encoding 原样写回，客户端对明文再解压一次。
test('buffered upstream responses never forward the upstream content-encoding', async (t) => {
  const payload = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const upstreamRes = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const raw = Buffer.from(await upstreamRes.arrayBuffer());
  assert.equal(raw.toString('utf8'), payload, 'fetch hands us the decoded body');

  const passthrough = fakeResponse();
  sendRawUpstreamResponse(passthrough, upstreamRes, raw, { accountRef: 'acct_000000000000000000aa' }, false);
  assert.equal(passthrough.statusCode, 429);
  assert.equal(passthrough.headers['content-encoding'], undefined);
  assert.equal(passthrough.headers['content-length'], raw.length);
  assert.equal(passthrough.body.toString('utf8'), payload);

  for (const options of [{}, { streamRequested: true }, { normalizeClaudeMessagesResponse: true }]) {
    const general = fakeResponse();
    writeGeneralUpstreamResponseHeaders(general, upstreamRes, { accountRef: 'acct_000000000000000000aa' }, options);
    assert.equal(general.headers['content-encoding'], undefined, JSON.stringify(options));
    assert.equal(general.headers['content-length'], undefined, JSON.stringify(options));
    assert.equal(general.headers['content-type'] !== undefined, true);
  }
});
