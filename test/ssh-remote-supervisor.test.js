'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { writeJsonValue } = require('../lib/server/app-state-store');
const { backoffDelay, runRemoteSupervisor, shouldReconnect } = require('../lib/server/ssh-remote-supervisor');
const { detachedLauncher } = require('../lib/server/webui-terminal-persistence');
const { handleWebUiSshHostRoutes } = require('../lib/server/webui-ssh-host-routes');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rws-sup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(aiHomeDir, connection = { id: 'c1', host: 'dev.example', user: 'me', port: 22, authType: 'agent' }) {
  writeJsonValue(fs, aiHomeDir, 'ssh_connections', [connection]);
  writeJsonValue(fs, aiHomeDir, 'ssh_workspaces', [{ id: 'ws_0123456789abcdef', connectionId: connection.id, label: 'dev', remoteRoot: '/srv/app' }]);
}

// 假 ssh：按脚本依次返回退出码，记录每次的参数。
function fakeSpawn(exits) {
  const calls = [];
  const spawnImpl = (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.kill = () => {};
    const next = exits.shift();
    setImmediate(() => (typeof next === 'function' ? next(child) : child.emit('exit', next.code, next.signal || null)));
    return child;
  };
  return { spawnImpl, calls };
}

const immediate = (fn) => setImmediate(fn);

test('reconnect policy: only ssh-level failures and signals trigger a reconnect', () => {
  assert.equal(shouldReconnect(255, null), true, 'ssh connection lost');
  assert.equal(shouldReconnect(null, 'SIGPIPE'), true, 'killed by network-side signal');
  assert.equal(shouldReconnect(0, null), false, 'user typed exit');
  assert.equal(shouldReconnect(130, null), false, 'remote command exit code');
  assert.equal(shouldReconnect(null, 'SIGINT'), false);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffDelay), [1000, 2000, 5000, 10000, 20000, 30000, 30000]);
});

test('a dropped connection is re-established automatically, then a normal exit ends the tab', async (t) => {
  const aiHomeDir = home(t);
  seed(aiHomeDir);
  const out = new PassThrough(); let text = '';
  out.on('data', (chunk) => { text += chunk; });
  const { spawnImpl, calls } = fakeSpawn([{ code: 255 }, { code: 255 }, { code: 0 }]);
  const code = await runRemoteSupervisor({ aiHomeDir, workspaceId: 'ws_0123456789abcdef', stdout: out, spawnImpl, setTimer: immediate });
  assert.equal(code, 0);
  assert.equal(calls.length, 3, 'two reconnects after two drops');
  for (const call of calls) {
    assert.equal(call.file, 'ssh');
    assert.equal(call.args.at(-2), 'me@dev.example');
    // 远端进入同名 tmux 会话：重连接回原 shell。
    assert.match(call.args.at(-1), /tmux new-session -A -s 'aih-remote-ws-ws_0123456789abcdef'/);
  }
  assert.match(text, /连接已断开，1 秒后自动重连（第 1 次）/);
  assert.match(text, /2 秒后自动重连（第 2 次）/);
});

test('each reconnect re-reads the saved connection, so edited settings apply on the next attempt', async (t) => {
  const aiHomeDir = home(t);
  seed(aiHomeDir);
  const { spawnImpl, calls } = fakeSpawn([
    { code: 255 },
    { code: 0 }
  ]);
  const editAfterFirst = (fn) => setImmediate(() => {
    writeJsonValue(fs, aiHomeDir, 'ssh_connections', [{ id: 'c1', host: 'dev.example', user: 'me', port: 2222, authType: 'agent' }]);
    fn();
  });
  await runRemoteSupervisor({ aiHomeDir, workspaceId: 'ws_0123456789abcdef', stdout: new PassThrough(), spawnImpl, setTimer: editAfterFirst });
  const port = (call) => call.args[call.args.indexOf('-p') + 1];
  assert.equal(port(calls[0]), '22');
  assert.equal(port(calls[1]), '2222');
});

test('a workspace or connection deleted while disconnected stops the reconnect loop', async (t) => {
  const aiHomeDir = home(t);
  seed(aiHomeDir);
  const out = new PassThrough(); let text = '';
  out.on('data', (chunk) => { text += chunk; });
  const dropThenDelete = (fn) => setImmediate(() => { writeJsonValue(fs, aiHomeDir, 'ssh_workspaces', []); fn(); });
  const { spawnImpl, calls } = fakeSpawn([{ code: 255 }]);
  const code = await runRemoteSupervisor({ aiHomeDir, workspaceId: 'ws_0123456789abcdef', stdout: out, spawnImpl, setTimer: dropThenDelete });
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.match(text, /工作区已删除/);
});

test('pasted private keys exist only while connecting and are wiped after every attempt', async (t) => {
  const aiHomeDir = home(t);
  seed(aiHomeDir, { id: 'c1', host: 'dev.example', authType: 'key', privateKey: '-----BEGIN KEY-----\nx\n-----END KEY-----' });
  const seen = [];
  const { spawnImpl } = fakeSpawn([
    (child) => { seen.push(fs.readdirSync(path.join(aiHomeDir, 'run', 'ssh-remote')).length); child.emit('exit', 255, null); },
    (child) => { seen.push(fs.readdirSync(path.join(aiHomeDir, 'run', 'ssh-remote')).length); child.emit('exit', 0, null); }
  ]);
  await runRemoteSupervisor({ aiHomeDir, workspaceId: 'ws_0123456789abcdef', stdout: new PassThrough(), spawnImpl, setTimer: immediate });
  assert.deepEqual(seen, [1, 1], 'key file present during each connect');
  assert.deepEqual(fs.readdirSync(path.join(aiHomeDir, 'run', 'ssh-remote')), [], 'nothing left on disk');
});

test('under systemd the persistent tmux is launched in its own scope so it survives a server restart', () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const launcher = detachedLauncher({ INVOCATION_ID: 'abc', XDG_RUNTIME_DIR: '/run/user/1000' });
    assert.equal(launcher.file, 'systemd-run');
    assert.deepEqual(launcher.prefix, ['--user', '--scope', '--quiet', '--collect']);
    assert.equal(detachedLauncher({}), null, 'not under systemd: launch directly');
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
  assert.equal(detachedLauncher({ INVOCATION_ID: 'abc' }) === null || process.platform === 'linux', true);
});

function call(aiHomeDir, method, pathname, body, deps = {}) {
  const req = new PassThrough(); req.method = method; req.headers = {};
  let response;
  const pending = handleWebUiSshHostRoutes({
    method, pathname, req, res: {}, aiHomeDir,
    deps: {
      fs, homeDir: os.homedir(),
      writeJson: (_res, status, payload) => { response = { status, payload }; },
      readRequestBody: async (stream) => new Promise((resolve) => { const c = []; stream.on('data', (d) => c.push(d)); stream.on('end', () => resolve(Buffer.concat(c))); }),
      ...deps
    }
  });
  req.end(body ? JSON.stringify(body) : '');
  return pending.then(() => response);
}

test('the terminal route starts the supervisor (not raw ssh) and passes no credentials', async (t) => {
  const aiHomeDir = home(t);
  seed(aiHomeDir, { id: 'c1', host: 'dev.example', authType: 'password', password: 'p4ss' });
  const opened = [];
  const res = await call(aiHomeDir, 'POST', '/v0/webui/ssh-workspaces/ws_0123456789abcdef/terminal', {}, {
    openWebUiTerminalSession: (input) => { opened.push(input); return { ok: true, termId: 't1', sessionKey: input.sessionKey, durable: true }; }
  });
  assert.equal(res.status, 200);
  const { file, args, env } = opened[0];
  assert.equal(file, process.execPath);
  assert.deepEqual(args.slice(1), ['__remote_ws__', 'ws_0123456789abcdef', 'remote-ws:ws_0123456789abcdef']);
  assert.match(args[0], /bin[\\/]ai-home\.js$/);
  assert.deepEqual(env, { AIH_HOME_DIR: aiHomeDir });
  assert.ok(!JSON.stringify(opened[0]).includes('p4ss'), 'password never reaches the PTY launch');
  assert.deepEqual(fs.existsSync(path.join(aiHomeDir, 'run', 'ssh-remote')) ? fs.readdirSync(path.join(aiHomeDir, 'run', 'ssh-remote')) : [], [], 'validation leaves no askpass behind');
});

test('session status comes from the server-side PTY, so any device sees the same live state', async (t) => {
  const aiHomeDir = home(t);
  seed(aiHomeDir);
  const res = await call(aiHomeDir, 'GET', '/v0/webui/ssh-workspaces/sessions', null, {
    terminalPersistence: { probe: (key) => ({ state: key === 'remote-ws:ws_0123456789abcdef' ? 'alive' : 'missing' }) }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.sessions, [{ workspaceId: 'ws_0123456789abcdef', sessionKey: 'remote-ws:ws_0123456789abcdef', alive: true }]);
});
