'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const {
  handleWebUiClientTerminalRoutes
} = require('../lib/server/webui-client-terminal-routes');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    end(chunk = '') { this.body = String(chunk); }
  };
}

function writeJson(res, status, payload) {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function fakeFs(paths = []) {
  const existing = new Set(paths);
  return { existsSync: (value) => existing.has(String(value)) };
}

function createContext(options = {}) {
  const res = createResCapture();
  return {
    req: {},
    res,
    writeJson,
    ...options,
    resCapture: res
  };
}

test('WebUI 终端清单只暴露公共平台标识和可用终端', async () => {
  const ctx = createContext({
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeFs(['C:\\tools\\wt.exe', 'C:\\tools\\wezterm.exe', 'C:\\tools\\winget.exe'])
  });
  const handled = await handleWebUiClientTerminalRoutes(
    ctx.req,
    ctx.res,
    'GET',
    '/v0/webui/terminals',
    ctx
  );
  assert.equal(handled, true);
  assert.equal(ctx.resCapture.statusCode, 200);
  const body = JSON.parse(ctx.resCapture.body);
  assert.equal(body.platform, 'windows');
  // Windows 无「系统默认」概念：默认 Windows Terminal、其次 CMD
  assert.deepEqual(body.terminals.map((terminal) => terminal.id), [
    'windows-terminal', 'cmd', 'wezterm', 'warp'
  ]);
  assert.equal(body.terminals.find((terminal) => terminal.id === 'windows-terminal').default, true);
  assert.equal(body.terminals.find((terminal) => terminal.id === 'cmd').installed, true);
  assert.equal(body.terminals.find((terminal) => terminal.id === 'windows-terminal').sourceUrl,
    'https://learn.microsoft.com/en-us/windows/terminal/install');
});

test('Toolkit 终端操作先生成官方包管理器计划，未确认执行会被拒绝', async () => {
  const base = {
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew'])
  };
  const planCtx = createContext({ ...base, readRequestBody: async () => Buffer.from(JSON.stringify({
    terminalId: 'wezterm', action: 'install'
  })) });
  await handleWebUiClientTerminalRoutes(
    planCtx.req,
    planCtx.res,
    'POST',
    '/v0/webui/toolkit/terminals/plan',
    planCtx
  );
  assert.equal(planCtx.resCapture.statusCode, 200);
  assert.deepEqual(JSON.parse(planCtx.resCapture.body).args, ['install', '--cask', 'wezterm']);

  const deniedCtx = createContext({ ...base, readRequestBody: async () => Buffer.from(JSON.stringify({
    terminalId: 'wezterm', action: 'install'
  })) });
  await handleWebUiClientTerminalRoutes(
    deniedCtx.req,
    deniedCtx.res,
    'POST',
    '/v0/webui/toolkit/terminals/execute',
    deniedCtx
  );
  assert.equal(deniedCtx.resCapture.statusCode, 428);
  assert.equal(JSON.parse(deniedCtx.resCapture.body).error, 'confirmation_required');
});

test('Toolkit 终端执行复用服务端计划，不接受客户端自定义命令', async () => {
  const calls = [];
  const ctx = createContext({
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew']),
    runTerminalPlan: async (plan) => {
      calls.push(plan);
      return { ok: true };
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({
      terminalId: 'wezterm', action: 'install', confirmed: true, file: '/tmp/unsafe', args: ['--nope']
    }))
  });
  await handleWebUiClientTerminalRoutes(
    ctx.req,
    ctx.res,
    'POST',
    '/v0/webui/toolkit/terminals/execute',
    ctx
  );
  assert.equal(ctx.resCapture.statusCode, 202);
});

test('Toolkit 终端任务取消入口与其他资源使用相同语义', async () => {
  const calls = [];
  const ctx = createContext({
    deps: {
      clientTerminalJobManager: {
        cancelJob(jobId) {
          calls.push(jobId);
          return { ok: true, job: { id: jobId, status: 'cancelled' } };
        }
      }
    }
  });

  await handleWebUiClientTerminalRoutes(
    ctx.req,
    ctx.res,
    'POST',
    '/v0/webui/toolkit/terminals/jobs/terminal-action-1/cancel',
    ctx
  );

  assert.equal(ctx.resCapture.statusCode, 200);
  assert.deepEqual(calls, ['terminal-action-1']);
  assert.equal(JSON.parse(ctx.resCapture.body).job.status, 'cancelled');
});

test('Toolkit 终端唤起只接受已探测的平台终端并立即返回', async () => {
  const calls = [];
  const ctx = createContext({
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '/opt/homebrew/bin', SHELL: '/bin/zsh' },
    fs: fakeFs(['/opt/homebrew/bin/wezterm']),
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { pid: 7, unref() { calls.push({ unref: true }); } };
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({ terminalId: 'wezterm' }))
  });
  await handleWebUiClientTerminalRoutes(
    ctx.req,
    ctx.res,
    'POST',
    '/v0/webui/toolkit/terminals/open',
    ctx
  );
  assert.equal(ctx.resCapture.statusCode, 200);
  assert.equal(JSON.parse(ctx.resCapture.body).terminalId, 'wezterm');
  assert.equal(calls[0].file, '/opt/homebrew/bin/wezterm');
  assert.equal(calls[0].options.detached, true);
});
