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
    const { openWebUiTerminalSession, handleWebUiTerminalRequest } = require('./lib/server/webui-terminal-routes');
    const result = openWebUiTerminalSession({ sessionKey: 'without-tmux', file: '/bin/sh', args: [] });
    handleWebUiTerminalRequest({ method: 'POST', pathname: '/v0/webui/terminal/close', res: {},
      readRequestBody: async () => Buffer.from(JSON.stringify({ sessionKey: 'without-tmux' })),
      writeJson: (_res, status, body) => { process.stdout.write(JSON.stringify({ ...result, closeStatus: status, closeOk: body.ok }), () => process.exit(0)); } });
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.durable, false);
  assert.equal(result.closeStatus, 200);
  assert.equal(result.closeOk, true);
});

test('adoption reports capacity errors rather than claiming the session ended', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const loader = require('./lib/runtime/node-pty-loader');
    loader.loadNodePty = () => ({ spawn: () => ({ onData() {}, onExit() {}, kill() {} }) });
    const routes = require('./lib/server/webui-terminal-routes');
    for (let i = 0; i < 24; i++) {
      if (!routes.openWebUiTerminalSession({}).ok) process.exit(1);
    }
    routes.handleWebUiTerminalRequest({ method: 'POST', pathname: '/v0/webui/terminal/attach', res: {},
      readRequestBody: async () => Buffer.from(JSON.stringify({ sessionKey: 'still-running' })),
      writeJson: (_res, status, body) => console.log(JSON.stringify({ status, ...body })) });
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 429, ok: false, error: 'too_many_terminals' });
});

test('closing an untracked key reports an unavailable backend instead of claiming success', { skip: process.platform === 'win32' }, () => {
  const child = spawnSync(process.execPath, ['-e', `
    const { handleWebUiTerminalRequest } = require('./lib/server/webui-terminal-routes');
    handleWebUiTerminalRequest({ method: 'POST', pathname: '/v0/webui/terminal/close', res: {},
      readRequestBody: async () => Buffer.from(JSON.stringify({ termId: 'old', sessionKey: 'possibly-live' })),
      writeJson: (_res, status, body) => console.log(JSON.stringify({ status, ...body })) });
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000,
    env: { ...process.env, PATH: '' } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 503, ok: false, error: 'persistent_terminal_unavailable' });
});

test('keyed terminal survives the server process and can be closed after adoption', { skip: !tmuxAvailable, timeout: 15000 }, async () => {
  const key = `restart-test-${process.pid}-${Date.now()}`;
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const { openWebUiTerminalSession, findSessionByKey } = require('./lib/server/webui-terminal-routes');
      const result = openWebUiTerminalSession({ sessionKey: process.argv[1], file: '/bin/sh', args: ['-c', 'test -z "$TMUX" && echo TMUX_CLEARED; echo SURVIVED; exec /bin/sh'] });
      if (!result.ok) { console.error(result); process.exit(1); }
      const poll = setInterval(() => {
        const session = findSessionByKey(process.argv[1]);
        if (session && session.buffer.join('').includes('SURVIVED')) process.exit(0);
      }, 50);
      setTimeout(() => { clearInterval(poll); process.exit(2); }, 6000);
    `, key], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000,
      env: { ...process.env, TMUX: '/tmp/outer-tmux,123,0' } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(persistence.probe(key).state, 'alive');
    const unavailable = spawnSync(process.execPath, ['-e', `
      const { handleWebUiTerminalRequest } = require('./lib/server/webui-terminal-routes');
      handleWebUiTerminalRequest({ method: 'POST', pathname: '/v0/webui/terminal/attach', res: {},
        readRequestBody: async () => Buffer.from(JSON.stringify({ sessionKey: process.argv[1] })),
        writeJson: (_res, status, body) => console.log(JSON.stringify({ status, ...body })) });
    `, key], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000,
      env: { ...process.env, PATH: '' } });
    assert.equal(unavailable.status, 0, unavailable.stderr);
    assert.deepEqual(JSON.parse(unavailable.stdout), { status: 503, ok: false, error: 'persistent_terminal_unavailable' });
    assert.equal(persistence.probe(key).state, 'alive');
    const muxId = `test-mux-${Date.now()}`;
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writeHead = () => {};
    const frames = [];
    res.write = (text) => { if (text.startsWith('data: ')) frames.push(JSON.parse(text.slice(6))); return true; };
    await handleWebUiTerminalRequest({ method: 'GET', pathname: '/v0/webui/terminal/mux', url: new URL(`http://localhost/?muxId=${muxId}`), req, res });
    const attached = await post('attach', { sessionKey: key, muxId });
    assert.equal(attached.ok, true);
    let output = '';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      output = frames.filter((frame) => frame.type === 'output').map((frame) => Buffer.from(frame.data, 'base64').toString()).join('');
      if (output.includes('SURVIVED')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(output, /SURVIVED/);
    assert.match(output, /TMUX_CLEARED/);
    await post('close', { termId: attached.termId });
    assert.equal(persistence.probe(key).state, 'missing');
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

test('closing with a stale terminal id removes the detached session after server restart', { skip: !tmuxAvailable, timeout: 15000 }, async () => {
  const key = `close-restart-test-${process.pid}-${Date.now()}`;
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const result = require('./lib/server/webui-terminal-routes').openWebUiTerminalSession({ sessionKey: process.argv[1], file: '/bin/sh', args: [] });
      if (!result.ok) { console.error(result); process.exit(1); }
      setTimeout(() => process.exit(0), 200);
    `, key], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 8000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(persistence.probe(key).state, 'alive');
    assert.equal((await post('close', { termId: 'obsolete-id', sessionKey: key })).ok, true);
    assert.equal(persistence.probe(key).state, 'missing');
    assert.equal((await post('attach', { sessionKey: key })).error, 'terminal_not_found');
  } finally {
    persistence.close(key);
  }
});

test('closing rejects a terminal id paired with a different session key', { skip: !tmuxAvailable }, async () => {
  const key = `close-identity-test-${process.pid}-${Date.now()}`;
  const opened = await post('open', { sessionKey: key });
  assert.equal(opened.ok, true);
  try {
    const result = await post('close', { termId: opened.termId, sessionKey: `${key}-other` });
    assert.equal(result.status, 409);
    assert.equal(result.error, 'terminal_identity_mismatch');
    assert.equal(persistence.probe(key).state, 'alive');
  } finally {
    await post('close', { termId: opened.termId, sessionKey: key });
  }
});

test('closing by key works before the browser receives a terminal id', { skip: !tmuxAvailable }, async () => {
  const key = `close-pending-test-${process.pid}-${Date.now()}`;
  const opened = await post('open', { sessionKey: key });
  assert.equal(opened.ok, true);
  try {
    assert.equal((await post('close', { sessionKey: key })).ok, true);
    assert.equal(persistence.probe(key).state, 'missing');
    assert.equal((await post('attach', { sessionKey: key })).error, 'terminal_not_found');
  } finally {
    await post('close', { termId: opened.termId });
    persistence.close(key);
  }
});
