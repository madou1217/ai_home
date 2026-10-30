'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const persistence = require('../lib/server/webui-terminal-persistence');
const { handleWebUiTerminalRequest } = require('../lib/server/webui-terminal-routes');

async function post(route, body) {
  let reply;
  await handleWebUiTerminalRequest({
    method: 'POST', pathname: `/v0/webui/terminal/${route}`, res: {},
    readRequestBody: async () => Buffer.from(JSON.stringify(body)),
    writeJson: (_res, status, value) => { reply = { status, ...value }; }
  });
  return reply;
}

test('keyed terminal survives the server process and can be closed after adoption', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const key = `restart-test-${process.pid}-${Date.now()}`;
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const { openWebUiTerminalSession } = require('./lib/server/webui-terminal-routes');
      const result = openWebUiTerminalSession({ sessionKey: process.argv[1], file: '/bin/sh', args: ['-c', 'echo SURVIVED; exec /bin/sh'] });
      if (!result.ok) { console.error(result); process.exit(1); }
      setTimeout(() => process.exit(0), 300);
    `, key], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(persistence.exists(key), true);
    const muxId = `test-mux-${Date.now()}`;
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writeHead = () => {};
    const frames = [];
    res.write = (text) => { if (text.startsWith('data: ')) frames.push(JSON.parse(text.slice(6))); return true; };
    await handleWebUiTerminalRequest({ method: 'GET', pathname: '/v0/webui/terminal/mux', url: new URL(`http://localhost/?muxId=${muxId}`), req, res });
    const attached = await post('attach', { sessionKey: key, muxId });
    assert.equal(attached.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const output = frames.filter((frame) => frame.type === 'output').map((frame) => Buffer.from(frame.data, 'base64').toString()).join('');
    assert.match(output, /SURVIVED/);
    await post('close', { termId: attached.termId });
    assert.equal(persistence.exists(key), false);
    req.emit('close');
    assert.equal((await post('attach', { sessionKey: key })).error, 'terminal_not_found');
  } finally {
    persistence.close(key);
  }
});
