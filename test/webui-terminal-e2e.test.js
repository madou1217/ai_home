'use strict';

// 端到端：浏览器风格请求 → Node 终端路由（管理密钥门）→ 独立 Go 进程的
// webuiterminalapi → 真实 PTY。只在本 worktree 内起临时端口，不碰 9527/19550。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const {
  handleWebUiTerminalRequest,
  openWebUiTerminalSession
} = require('../lib/server/webui-terminal-routes');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANAGEMENT_KEY = 'e2e-terminal-key';

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function startGoServer(t) {
  const binary = path.join(t.tmpDir, process.platform === 'win32' ? 'terminalserver.exe' : 'terminalserver');
  const build = spawnSync('go', ['build', '-o', binary, './testdata/terminalserver'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(build.status, 0, build.stderr || 'go build 失败');

  const child = spawn(binary, [], {
    cwd: REPO_ROOT,
    env: { ...process.env, AIH_TERMINAL_TEST_KEY: MANAGEMENT_KEY },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_error) {} });

  const address = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('Go 终端服务启动超时: ' + stderr)), 15000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = /LISTEN=(\S+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Go 终端服务提前退出: ' + code + ' ' + stderr));
    });
  });
  return { child, baseUrl: 'http://' + address };
}

function createGoHost(baseUrl) {
  return {
    async terminalRequest({ method, path, body }) {
      const response = await fetch(baseUrl + path, {
        method,
        headers: {
          authorization: 'Bearer ' + MANAGEMENT_KEY,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_error) {}
      return { ok: response.ok, status: response.status, body: json, data: json };
    },
    openTerminalStream({ path, query }) {
      const suffix = query ? '?' + query : '';
      return fetch(baseUrl + path + suffix, {
        headers: { authorization: 'Bearer ' + MANAGEMENT_KEY, accept: 'text/event-stream' }
      });
    }
  };
}

async function startProxyServer(goHost) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const ctx = {
      method: req.method,
      pathname: url.pathname,
      url,
      req,
      res,
      deps: { goCoreSync: goHost },
      readRequestBody,
      writeJson(target, status, payload) {
        target.writeHead(status, { 'Content-Type': 'application/json' });
        target.end(JSON.stringify(payload));
      }
    };
    try {
      const handled = await handleWebUiTerminalRequest(ctx);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      }
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
      }
    }
  });
  const port = await listen(server);
  return { server, baseUrl: 'http://127.0.0.1:' + port };
}

// 持续读 mux SSE，直到满足 predicate；返回已收到的帧与文本。
async function readFrames(url, predicate, timeoutMs = 15000) {
  const response = await fetch(url, { headers: { accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        if (!raw.startsWith('data: ')) continue;
        let frame;
        try { frame = JSON.parse(raw.slice('data: '.length)); } catch (_error) { continue; }
        frames.push(frame);
        if (frame.type === 'output' && frame.data) {
          text += Buffer.from(frame.data, 'base64').toString('utf8');
        }
        if (predicate(frames, text)) return { frames, text };
      }
    }
  } finally {
    try { await reader.cancel(); } catch (_error) {}
  }
  throw new Error('等待终端输出超时，已收到: ' + JSON.stringify(text));
}

test('Node proxy -> Go PTY: open, echo input through mux, close', { timeout: 90000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 路径不做该端到端');
    return;
  }
  if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('本机没有 go 工具链');
    return;
  }
  t.tmpDir = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'aih-terminal-e2e-'));
  t.after(() => { try { require('node:fs').rmSync(t.tmpDir, { recursive: true, force: true }); } catch (_error) {} });

  const go = await startGoServer(t);
  const goHost = createGoHost(go.baseUrl);
  const proxy = await startProxyServer(goHost);
  t.after(() => proxy.server.close());

  const opened = await openWebUiTerminalSession({
    muxId: 'mux-e2e',
    file: '/bin/sh',
    args: ['-c', "printf 'READY\\n'; read line; printf 'GOT:%s\\n' \"$line\""],
    cwd: t.tmpDir,
    cols: 80,
    rows: 24
  }, goHost);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.durable, false);

  const first = await readFrames(
    proxy.baseUrl + '/v0/webui/terminal/mux?muxId=mux-e2e',
    (frames, text) => text.includes('READY')
  );
  assert.ok(first.frames.some((frame) => frame.type === 'connected' && frame.muxId === 'mux-e2e'));

  const inputResponse = await fetch(proxy.baseUrl + '/v0/webui/terminal/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termId: opened.termId, data: 'hi\n' })
  });
  assert.equal(inputResponse.status, 200);

  const echoed = await readFrames(
    proxy.baseUrl + '/v0/webui/terminal/mux?muxId=mux-e2e',
    (frames, text) => text.includes('GOT:hi')
  );
  assert.ok(echoed.frames.every((frame) => !frame.termId || frame.termId === opened.termId));

  const closeResponse = await fetch(proxy.baseUrl + '/v0/webui/terminal/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termId: opened.termId })
  });
  assert.equal(closeResponse.status, 200);
  assert.deepEqual(await closeResponse.json(), { ok: true });
});
