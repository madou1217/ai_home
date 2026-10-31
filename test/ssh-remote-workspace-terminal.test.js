'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { buildRemoteShellCommand, remoteSessionKey, removeCredentialFiles } = require('../lib/server/ssh-remote-shell');
const { writeJsonValue } = require('../lib/server/app-state-store');
const { handleWebUiSshHostRoutes } = require('../lib/server/webui-ssh-host-routes');

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('ssh command enters the workspace root, keeps the connection alive and never puts secrets on argv', (t) => {
  const aiHomeDir = tmpHome(t);
  const cmd = buildRemoteShellCommand({
    connection: { host: 'mac.local', user: 'model', port: 22007, authType: 'password', password: 's3cr3t' },
    remoteRoot: "/Users/model/my 'proj'",
    sessionKey: remoteSessionKey('ws_1'),
    aiHomeDir, fs
  });
  assert.equal(cmd.file, 'ssh');
  assert.ok(cmd.args.includes('-tt'));
  assert.ok(cmd.args.includes('ServerAliveInterval=30'));
  assert.deepEqual(cmd.args.slice(cmd.args.indexOf('-p'), cmd.args.indexOf('-p') + 2), ['-p', '22007']);
  assert.equal(cmd.args.at(-2), 'model@mac.local');
  // 远端命令把路径安全引用（含空格与单引号），并 exec 登录 shell。
  assert.match(cmd.args.at(-1), /^cd '\/Users\/model\/my '\\''proj'\\''' /);
  assert.match(cmd.args.at(-1), /exec "\$\{SHELL:-\/bin\/sh\}" -l$/);
  // 远端有 tmux 时进入同名会话：SSH 断线后重开即接回原 shell。
  assert.match(cmd.args.at(-1), /command -v tmux >\/dev\/null 2>&1; then exec tmux new-session -A -s 'aih-remote-ws-ws_1'/);
  // 密码只在 env 里，askpass 脚本里也没有。
  assert.ok(!cmd.args.join(' ').includes('s3cr3t'));
  assert.equal(cmd.env.AIH_SSH_PASSWORD, 's3cr3t');
  const askPass = cmd.tempFiles[0];
  assert.ok(!fs.readFileSync(askPass, 'utf8').includes('s3cr3t'));
  assert.equal(fs.statSync(askPass).mode & 0o777, 0o700);
  removeCredentialFiles(cmd.tempFiles, fs);
  assert.equal(fs.existsSync(askPass), false);
});

test('pasted private keys are written 0600 and wiped afterwards; agent auth writes nothing', (t) => {
  const aiHomeDir = tmpHome(t);
  const keyed = buildRemoteShellCommand({
    connection: { host: 'h', authType: 'key', privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----' },
    remoteRoot: '/srv', sessionKey: 'remote-ws:ws_k', aiHomeDir, fs
  });
  const keyFile = keyed.tempFiles[0];
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(keyed.args[keyed.args.indexOf('-i') + 1], keyFile);
  removeCredentialFiles(keyed.tempFiles, fs);
  assert.equal(fs.existsSync(keyFile), false);

  const agent = buildRemoteShellCommand({ connection: { host: 'h' }, remoteRoot: '', sessionKey: 'k', aiHomeDir, fs });
  assert.deepEqual(agent.tempFiles, []);
  assert.ok(agent.args.includes('BatchMode=yes'));
  assert.ok(agent.args.at(-1).startsWith('if command -v tmux'));
  assert.ok(agent.args.at(-1).endsWith('exec "${SHELL:-/bin/sh}" -l'));
});

function callRoute(aiHomeDir, pathname, body, openWebUiTerminalSession) {
  const req = new PassThrough();
  req.method = 'POST';
  req.headers = {};
  let response;
  const ctx = {
    method: 'POST', pathname, req, res: {}, aiHomeDir,
    deps: {
      fs,
      homeDir: os.homedir(),
      writeJson: (_res, status, payload) => { response = { status, payload }; },
      readRequestBody: async (stream) => new Promise((resolve) => {
        const chunks = []; stream.on('data', (c) => chunks.push(c)); stream.on('end', () => resolve(Buffer.concat(chunks)));
      }),
      openWebUiTerminalSession
    }
  };
  const pending = handleWebUiSshHostRoutes(ctx);
  req.end(JSON.stringify(body || {}));
  return pending.then(() => response);
}

test('route opens a persistent terminal per workspace and reuses it on the next click', async (t) => {
  const aiHomeDir = tmpHome(t);
  writeJsonValue(fs, aiHomeDir, 'ssh_connections', [{ id: 'c1', host: 'mac.local', user: 'model', port: 22, authType: 'agent' }]);
  writeJsonValue(fs, aiHomeDir, 'ssh_workspaces', [{ id: 'ws_1', connectionId: 'c1', label: 'mac', remoteRoot: '/Users/model/p' }]);
  const opened = [];
  const sessions = new Map();
  const open = (input) => {
    opened.push(input);
    const reused = sessions.has(input.sessionKey);
    sessions.set(input.sessionKey, true);
    return { ok: true, termId: `t${opened.length}`, sessionKey: input.sessionKey, reused, durable: true };
  };
  const first = await callRoute(aiHomeDir, '/v0/webui/ssh-workspaces/ws_1/terminal', {}, open);
  assert.equal(first.status, 200);
  assert.equal(first.payload.sessionKey, 'remote-ws:ws_1');
  assert.equal(first.payload.reused, false);
  assert.equal(first.payload.host, 'model@mac.local');
  assert.equal(opened[0].file, 'ssh');
  assert.equal(opened[0].args.at(-2), 'model@mac.local');

  const again = await callRoute(aiHomeDir, '/v0/webui/ssh-workspaces/ws_1/terminal', {}, open);
  assert.equal(again.payload.reused, true);
  assert.equal(again.payload.sessionKey, 'remote-ws:ws_1');

  const fresh = await callRoute(aiHomeDir, '/v0/webui/ssh-workspaces/ws_1/terminal', { fresh: true }, open);
  assert.notEqual(fresh.payload.sessionKey, 'remote-ws:ws_1');
  assert.match(fresh.payload.sessionKey, /^remote-ws:ws_1:/);

  const missing = await callRoute(aiHomeDir, '/v0/webui/ssh-workspaces/nope/terminal', {}, open);
  assert.equal(missing.status, 404);
});

test('a workspace whose connection was deleted fails with a clear error', async (t) => {
  const aiHomeDir = tmpHome(t);
  writeJsonValue(fs, aiHomeDir, 'ssh_connections', []);
  writeJsonValue(fs, aiHomeDir, 'ssh_workspaces', [{ id: 'ws_2', connectionId: 'gone', label: 'x', remoteRoot: '/' }]);
  const res = await callRoute(aiHomeDir, '/v0/webui/ssh-workspaces/ws_2/terminal', {}, () => assert.fail('must not open'));
  assert.equal(res.status, 409);
  assert.equal(res.payload.error, 'connection_not_found');
});
