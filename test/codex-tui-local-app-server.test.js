'use strict';

// 交互式 codex TUI 经本地 app-server 代理:终端 /resume 列出当前项目所有 provider 的会话,
// app-server 用调用方自己的环境与配置(不借网关按宿主默认账号起的 app-server)。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const WebSocket = require('ws');
const {
  extractAppServerConfigArgs,
  startCodexTuiLocalAppServer,
  usesProfile
} = require('../lib/server/codex-tui-local-app-server');
const { isInteractiveTuiLaunch, isLocalAppServerEnabled } = require('../lib/server/codex-default-cli-launcher');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

test('only interactive TUI launches take the local app-server', () => {
  assert.equal(isInteractiveTuiLaunch([]), true);
  assert.equal(isInteractiveTuiLaunch(['-c', 'model_provider=aih_server', '--model', 'gpt-6.1-sol']), true);
  assert.equal(isInteractiveTuiLaunch(['-c', 'x=1', 'fix the bug']), true);
  for (const args of [['exec', 'hi'], ['app-server'], ['login'], ['resume'], ['--remote', 'ws://x'], ['--version'], ['-m', 'm', 'mcp', 'list']]) {
    assert.equal(isInteractiveTuiLaunch(args), false, args.join(' '));
  }
  const tty = { platform: 'darwin', stdin: { isTTY: true }, cwd: () => '/p' };
  assert.equal(isLocalAppServerEnabled({}, tty), true);
  assert.equal(isLocalAppServerEnabled({ AIH_CODEX_TUI_LOCAL_REMOTE: '0' }, tty), false);
  assert.equal(isLocalAppServerEnabled({}, { ...tty, stdin: { isTTY: false } }), false);
  // Windows（psmux）已真机验证，默认开启；紧急开关同样生效。
  assert.equal(isLocalAppServerEnabled({}, { ...tty, platform: 'win32' }), true);
  assert.equal(isLocalAppServerEnabled({ AIH_CODEX_TUI_LOCAL_REMOTE: '0' }, { ...tty, platform: 'win32' }), false);
});

test('on Windows the app-server process tree is closed with taskkill', async () => {
  const kills = [];
  const children = [];
  const local = await startCodexTuiLocalAppServer({
    upstream: 'C:\\codex\\codex.exe',
    env: {},
    args: [],
    cwd: 'C:\\work\\project',
    platform: 'win32',
    spawn: (command, args, options) => {
      const child = fakeChild();
      child.pid = 4242;
      child.exitCode = null;
      children.push({ command, args, options, child });
      return child;
    },
    spawnSync: (command, args) => { kills.push([command, ...args]); return { status: 0 }; }
  });
  const client = new WebSocket(local.remoteUrl, { headers: { Authorization: `Bearer ${local.authToken}` } });
  await new Promise((resolve) => client.on('open', resolve));
  assert.equal(children[0].options.windowsHide, true);
  await local.close();
  client.close();
  assert.deepEqual(kills[0], ['taskkill', '/PID', '4242', '/T', '/F']);
});

test('config flags go to the app-server, everything else stays with the TUI', () => {
  // codex app-server 不接受 -m/-p（unexpected argument，TUI 报 closed during initialize），改写成配置项。
  assert.deepEqual(
    extractAppServerConfigArgs(['-c', 'model_provider=aih_server', '--model', 'gpt-6.1-sol', '--dangerously-bypass-approvals-and-sandbox', 'resume', '-m', 'gpt-5.5', '--enable', 'f', 'abc']),
    ['-c', 'model_provider=aih_server', '-c', 'model="gpt-6.1-sol"', '-c', 'model="gpt-5.5"', '--enable', 'f']
  );
  // profile 无法交给 app-server（既非参数也不能写成配置项），这类启动走原生进程内 TUI。
  assert.equal(usesProfile(['-p', 'work']), true);
  assert.equal(usesProfile(['--profile=work', 'resume']), true);
  assert.equal(usesProfile(['-c', 'x=1', '--', '-p']), false);
});

test('the listener requires the per-launch token and shares sessions across providers within the project', async (t) => {
  const children = [];
  const local = await startCodexTuiLocalAppServer({
    upstream: '/bin/codex',
    env: { OPENAI_API_KEY: 'k' },
    args: ['-c', 'model_provider=aih_server'],
    cwd: '/work/project',
    platform: 'linux',
    spawn: (command, args, options) => {
      const child = fakeChild();
      children.push({ command, args, options, child });
      return child;
    }
  });
  t.after(() => local.close());

  // 无令牌被拒。
  await new Promise((resolve) => {
    const intruder = new WebSocket(local.remoteUrl);
    intruder.on('error', () => resolve());
    intruder.on('unexpected-response', () => resolve());
  });
  assert.equal(children.length, 0);

  const client = new WebSocket(local.remoteUrl, { headers: { Authorization: `Bearer ${local.authToken}` } });
  await new Promise((resolve) => client.on('open', resolve));
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].args, ['app-server', '-c', 'model_provider=aih_server', '--listen', 'stdio://']);
  assert.equal(children[0].options.env.OPENAI_API_KEY, 'k');

  const forwarded = new Promise((resolve) => children[0].child.stdin.once('data', (chunk) => resolve(JSON.parse(String(chunk)))));
  client.send(JSON.stringify({ id: 7, method: 'thread/list', params: { modelProviders: ['aih_server'] } }));
  const message = await forwarded;
  assert.deepEqual(message.params.modelProviders, []);
  assert.equal(message.params.cwd, '/work/project');

  const reply = new Promise((resolve) => client.once('message', (data) => resolve(JSON.parse(String(data)))));
  children[0].child.stdout.write(`${JSON.stringify({ id: 7, result: { data: [] } })}\n`);
  assert.deepEqual((await reply).result, { data: [] });

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(children[0].child.killed, true);
});

test('an interactive resume runs on the caller\'s own app-server, not the gateway default account', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
  const { runCodexCliResume } = require('../lib/server/codex-app-server-stdio-proxy-cliresume');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-local-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  const aiHomeDir = path.join(home, '.ai_home');
  const cwd = path.join(home, 'project');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\npreferred_auth_method = "oauth"\n');
  const account = registerAccountIdentity(fs, aiHomeDir, { provider: 'codex', cliAccountId: '36', identitySeed: 'oauth:codex:local-resume' });
  writeAccountNativeAuth(fs, aiHomeDir, account.accountRef, { auth: { auth_mode: 'chatgpt', tokens: { refresh_token: 'fake' } } });
  writeDefaultAccountRef(fs, aiHomeDir, 'codex', account.accountRef);

  const started = [];
  const spawns = [];
  const child = new EventEmitter();
  await runCodexCliResume(['--upstream', path.join(root, 'codex'), '--run-cli-resume', '--', 'resume', '01a0f2a8'], {
    fs,
    processObj: {
      platform: 'darwin',
      env: { HOME: home, USERPROFILE: home, AIH_HOST_HOME: home, AIH_HOME: aiHomeDir, CODEX_HOME: codexHome },
      stdin: { isTTY: true },
      cwd: () => cwd,
      stderr: { write() {} },
      exit() {}
    },
    spawn: (command, args, options) => { spawns.push({ command, args, options }); return child; },
    canConnectToTcpEndpoint: () => assert.fail('must not use the gateway app-server'),
    startCodexTuiLocalAppServer: async (options) => {
      started.push(options);
      return { remoteUrl: 'ws://127.0.0.1:1', authToken: 'tok', tokenEnv: 'AIH_CODEX_LOCAL_REMOTE_TOKEN', close: async () => {} };
    }
  });

  assert.equal(started.length, 1);
  assert.equal(started[0].cwd, cwd);
  assert.ok(started[0].args.includes('model_provider=openai'));
  const args = spawns[0].args;
  const resumeAt = args.indexOf('resume');
  assert.deepEqual(args.slice(resumeAt, resumeAt + 5), ['resume', '--remote', 'ws://127.0.0.1:1', '--remote-auth-token-env', 'AIH_CODEX_LOCAL_REMOTE_TOKEN']);
  assert.equal(args.at(-1), '01a0f2a8');
  assert.equal(spawns[0].options.env.AIH_CODEX_LOCAL_REMOTE_TOKEN, 'tok');
});
