'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const persistence = require('../lib/server/webui-terminal-persistence');
const { handleWebUiTerminalRequest } = require('../lib/server/webui-terminal-routes');
const tmuxAvailable = process.platform !== 'win32' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

async function post(route, body) {
  let reply;
  await handleWebUiTerminalRequest({
    method: 'POST', pathname: `/v0/webui/terminal/${route}`, res: {},
    readRequestBody: async () => Buffer.from(JSON.stringify(body)),
    writeJson: (_res, status, value) => { reply = { status, ...value }; }
  });
  return reply;
}

test('terminal remains usable with an explicit non-durable result when tmux is missing', { skip: process.platform === 'win32' }, () => {
  const child = spawnSync(process.execPath, ['-e', `
    const { openWebUiTerminalSession } = require('./lib/server/webui-terminal-routes');
    const result = openWebUiTerminalSession({ sessionKey: 'without-tmux', file: '/bin/sh', args: [] });
    console.log(JSON.stringify(result));
    process.exit(0);
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.durable, false);
});

test('keyed terminal survives the server process and can be closed after adoption', { skip: !tmuxAvailable, timeout: 15000 }, async () => {
  const key = `restart-test-${process.pid}-${Date.now()}`;
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const { openWebUiTerminalSession } = require('./lib/server/webui-terminal-routes');
      const result = openWebUiTerminalSession({ sessionKey: process.argv[1], file: '/bin/sh', args: ['-c', 'test -z "$TMUX" && echo TMUX_CLEARED; echo SURVIVED; exec /bin/sh'] });
      if (!result.ok) { console.error(result); process.exit(1); }
      setTimeout(() => process.exit(0), 300);
    `, key], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000,
      env: { ...process.env, TMUX: '/tmp/outer-tmux,123,0' } });
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
    assert.match(output, /TMUX_CLEARED/);
    await post('close', { termId: attached.termId });
    assert.equal(persistence.exists(key), false);
    req.emit('close');
    assert.equal((await post('attach', { sessionKey: key })).error, 'terminal_not_found');
  } finally {
    persistence.close(key);
  }
});

test('idle collection keeps keyed terminals after 30 minutes', { skip: !tmuxAvailable }, async () => {
  const key = `idle-test-${process.pid}-${Date.now()}`;
  const originalNow = Date.now;
  let terminal;
  let other;
  try {
    terminal = await post('open', { sessionKey: key });
    assert.equal(terminal.ok, true);
    Date.now = () => originalNow() + 31 * 60 * 1000;
    other = await post('open', {}); // Triggers the idle collector.
    assert.equal(other.ok, true);
    assert.equal((await post('attach', { sessionKey: key })).termId, terminal.termId);
  } finally {
    Date.now = originalNow;
    if (terminal?.termId) await post('close', { termId: terminal.termId });
    if (other?.termId) await post('close', { termId: other.termId });
    persistence.close(key);
  }
});
