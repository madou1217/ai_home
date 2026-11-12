'use strict';

// 跨语言端到端：真实 Go 适配器 → HTTP → Node 路由 → 宿主清理服务 → 假 tmux。
//
// 单元测试各自只能证明自己那一半：Go 的 httptest 证明请求形状，Node 的测试证明
// 清理语义。这里用 testdata/accounthostcleanupclient（真实适配器）跑一次完整链路，
// 把 JSON 字段名、鉴权头、phase 语义与错误分类一起钉死。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { handleAccountHostCleanupRequest } = require('../lib/server/account-host-cleanup-routes');
const persistentSession = require('../lib/runtime/persistent-session');
const persistentSessionRegistry = require('../lib/runtime/persistent-session-registry');

const PROVIDER = 'codebuddy';
const GO_REF = 'acct_0123456789abcdef0123';
const NODE_REF = 'acct_abcdef0123456789abcd';
const SESSION = 'p-e2e-abc123';
const NODE_MANAGEMENT_KEY = 'node-management-key';
const GO_CORE_KEY = 'go-core-bootstrap-key';
// socket 按 Node 侧的账号引用派生：Go 引用只用于调用适配器，绝不进 socket。
const CANONICAL_SOCKET = persistentSession.deriveSocket(PROVIDER, NODE_REF);

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function buildGoClient(t) {
  const binary = path.join(makeTempDir(t, 'aih-host-cleanup-bin-'), 'accounthostcleanupclient');
  const build = spawnSync('go', ['build', '-o', binary, './testdata/accounthostcleanupclient'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 180000
  });
  if (build.error || build.status !== 0) {
    t.skip(`go build 不可用：${build.error ? build.error.message : build.stderr}`);
    return '';
  }
  return binary;
}

// 假 tmux：只有 list-sessions / kill-server / kill-session 三种动作，
// servers 就是这台机器上还活着的服务端（杀掉后必须真的消失）。
function createFakeTmux(servers) {
  const state = {
    servers: new Map(Object.entries(servers).map(([socket, sessions]) => [socket, new Set(sessions)])),
    calls: []
  };
  const spawnSyncImpl = (command, args) => {
    state.calls.push([command, ...args].join(' '));
    if (args.includes('-V')) return { status: 0, stdout: 'tmux 3.8\n', stderr: '' };
    const socketIndex = args.indexOf('-L');
    const socket = socketIndex >= 0 ? String(args[socketIndex + 1] || '') : '';
    const action = args[socketIndex + 2] || '';
    if (action === 'list-sessions') {
      const sessions = state.servers.get(socket);
      if (!sessions) return { status: 1, stdout: '', stderr: 'no server running on /tmp/tmux-501/default' };
      return { status: 0, stdout: [...sessions].join('\n') + (sessions.size ? '\n' : ''), stderr: '' };
    }
    if (action === 'kill-server') {
      state.servers.delete(socket);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'kill-session') {
      const sessions = state.servers.get(socket);
      if (sessions) sessions.delete(args[args.indexOf('-t') + 1]);
      if (sessions && sessions.size === 0) state.servers.delete(socket);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { state, spawnSync: spawnSyncImpl };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function startNode(t, aiHomeDir, fake) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const handled = await handleAccountHostCleanupRequest({
        method: req.method,
        pathname: url.pathname,
        req,
        res,
        requiredManagementKey: NODE_MANAGEMENT_KEY,
        aiHomeDir,
        deps: {
          writeJson,
          readRequestBody: readBody,
          spawnSync: fake.spawnSync,
          goCoreManagementKey: () => GO_CORE_KEY
        }
      });
      if (!handled) writeJson(res, 404, { ok: false });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: String(error && error.message) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// 必须异步启动：本进程同时是 HTTP 服务端，spawnSync 会卡住事件循环，
// 让 Go 客户端的请求永远等不到响应（真实环境里 Node 用异步 fetch 调 Go，
// 不会出现这个问题）。
function runClient(t, binary, nodeURL, phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      env: {
        ...process.env,
        AIH_CLEANUP_TEST_NODE_URL: nodeURL,
        AIH_CLEANUP_TEST_KEY: GO_CORE_KEY,
        AIH_CLEANUP_TEST_PHASE: phase,
        AIH_CLEANUP_TEST_PROVIDER: PROVIDER,
        AIH_CLEANUP_TEST_GO_REF: GO_REF,
        AIH_CLEANUP_TEST_NODE_REF: NODE_REF
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Go 客户端退出码 ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout).trim().split('\n').pop()));
      } catch (error) {
        reject(new Error(`Go 客户端输出无法解析: ${stdout}`));
      }
    });
  });
}

test('跨语言契约：Go 适配器 → Node 宿主清理（活会话/陈旧登记/回收/幂等）', async (t) => {
  if (process.platform === 'win32') {
    t.skip('假 tmux 脚本只在 POSIX 上运行');
    return;
  }
  const binary = buildGoClient(t);
  if (!binary) return;

  const aiHomeDir = makeTempDir(t, 'aih-host-cleanup-e2e-');
  persistentSessionRegistry.writeEntry(aiHomeDir, {
    provider: PROVIDER,
    runtimeScope: NODE_REF,
    accountRef: NODE_REF,
    socket: CANONICAL_SOCKET,
    session: SESSION,
    cwd: aiHomeDir
  }, { strict: true });
  // 注意：socket 是按 Node 侧的 runtimeScope（accountRef）派生的。
  assert.equal(persistentSession.deriveSocket(PROVIDER, NODE_REF), CANONICAL_SOCKET);

  const fake = createFakeTmux({ [CANONICAL_SOCKET]: [SESSION] });
  const nodeURL = await startNode(t, aiHomeDir, fake);

  // 1. 活会话：Go 侧必须拿到「有运行时」而不是笼统的失败。
  const blocked = await runClient(t, binary, nodeURL, 'verify');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error_kind, 'runtime_active');
  assert.ok(!fake.state.calls.some((call) => call.includes('kill-')), 'verify 不得杀会话');
  assert.equal(persistentSessionRegistry.listEntries(aiHomeDir).length, 1);

  // 2. 用户关掉会话后：陈旧登记被清掉，删除放行。
  fake.state.servers.delete(CANONICAL_SOCKET);
  const verified = await runClient(t, binary, nodeURL, 'verify');
  assert.equal(verified.ok, true);
  assert.deepEqual(persistentSessionRegistry.listEntries(aiHomeDir), []);

  // 3. 提交后清理：登记里再次出现活会话（模拟删除期间又起来一个），整服务端回收。
  persistentSessionRegistry.writeEntry(aiHomeDir, {
    provider: PROVIDER,
    runtimeScope: NODE_REF,
    accountRef: NODE_REF,
    socket: CANONICAL_SOCKET,
    session: SESSION,
    cwd: aiHomeDir
  }, { strict: true });
  fake.state.servers.set(CANONICAL_SOCKET, new Set([SESSION, 's-extra']));
  const cleaned = await runClient(t, binary, nodeURL, 'cleanup');
  assert.equal(cleaned.ok, true);
  assert.equal(fake.state.servers.has(CANONICAL_SOCKET), false);
  assert.deepEqual(persistentSessionRegistry.listEntries(aiHomeDir), []);

  // 4. 幂等：再跑一次仍然成功，且不再有破坏性动作。
  const callsAfterFirst = fake.state.calls.length;
  const again = await runClient(t, binary, nodeURL, 'cleanup');
  assert.equal(again.ok, true);
  assert.ok(
    !fake.state.calls.slice(callsAfterFirst).some((call) => call.includes('kill-')),
    '第二次清理不得再杀任何东西'
  );
});
