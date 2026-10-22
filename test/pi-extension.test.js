'use strict';

// Pi 的扩展是 Pi 运行时加载的 .ts 模块，aih 只是把它写进账号投影。这里把同一份
// 源码拷成 .mjs（源码里没有任何 TS 类型语法，Node 直接可执行）放进投影，用桩
// pi/ctx 驱动它，验证「运行期回读网关模型目录 → 原子改写 models.json → 刷新
// registry」这条热更新链路真的成立，而不是只做源码字符串断言。
//
// 拷贝时只调小定时器常量（逻辑一字不改），生产常量另由源码断言守住。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { preparePiHarness } = require('../lib/harness/pi');

const CATALOG = Object.freeze({
  models: [
    {
      id: 'gpt-test',
      modalities: { input: ['text', 'image'], output: ['text'] },
      metadata: { name: 'GPT Test', limits: { context: 128000, output: 8192 } }
    },
    {
      id: 'claude-test',
      modalities: { input: ['text'], output: ['text'] },
      metadata: { name: 'Claude Test' }
    }
  ]
});

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function prepareProjection(t) {
  const aiHomeDir = tempDir(t, 'aih-pi-ext-home-');
  const hostHomeDir = tempDir(t, 'aih-pi-ext-host-');
  return preparePiHarness({
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    accountRef: 'acct_pi_ext',
    provider: 'codex',
    model: 'gpt-test',
    gateway: { baseUrl: 'http://127.0.0.1:9527/v1', apiKey: 'gateway-key' },
    catalog: CATALOG
  });
}

function loadExtensionProbe(prepared) {
  const source = fs.readFileSync(prepared.extensionPath, 'utf8');
  // 生产常量必须留在源码里；下面只是给探针一份更快的定时器。
  assert.match(source, /const CATALOG_INTERVAL_MS = 5 \* 60 \* 1000;/);
  assert.match(source, /const CATALOG_INITIAL_DELAY_MS = 5000;/);
  const probeSource = source
    .replace('const CATALOG_INITIAL_DELAY_MS = 5000;', 'const CATALOG_INITIAL_DELAY_MS = 20;')
    .replace('const CATALOG_INTERVAL_MS = 5 * 60 * 1000;', 'const CATALOG_INTERVAL_MS = 60 * 60 * 1000;')
    .replace('const POLL_INTERVAL_MS = 2000;', 'const POLL_INTERVAL_MS = 60 * 60 * 1000;');
  const probePath = path.join(prepared.agentDir, 'extensions', 'aih-model-refresh.probe.mjs');
  fs.writeFileSync(probePath, probeSource, { mode: 0o600 });
  return probePath;
}

function readModels(prepared) {
  return JSON.parse(fs.readFileSync(prepared.modelsPath, 'utf8')).providers.aih.models;
}

function writeModels(prepared, models) {
  const document = JSON.parse(fs.readFileSync(prepared.modelsPath, 'utf8'));
  document.providers.aih.models = models;
  fs.writeFileSync(prepared.modelsPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function modelIds(models) {
  return models.map((model) => model.id);
}

async function withStubs(t, run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'gateway-key';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  return run({
    setFetch: (impl) => { globalThis.fetch = impl; }
  });
}

test('Pi 扩展在运行期回读网关目录，把新增模型写回 models.json 并刷新 registry', async (t) => {
  const prepared = await prepareProjection(t);
  // 模拟「Pi 启动后上游新增了模型」：磁盘上只有一条，网关已经有三条。
  writeModels(prepared, [{ id: 'gpt-test', name: 'GPT Test', input: ['text', 'image'] }]);
  const probePath = loadExtensionProbe(prepared);

  await withStubs(t, async ({ setFetch }) => {
    const requests = [];
    setFetch(async (url, options) => {
      requests.push({ url: String(url), headers: options && options.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 'gpt-test', name: 'GPT Test' },
            { id: 'claude-test', name: 'Claude Test' },
            { id: 'gemini-test', name: 'Gemini Test' }
          ]
        })
      };
    });

    const module = await import(pathToFileURL(probePath).href);
    const handlers = {};
    const refreshCalls = [];
    module.default({ on: (name, handler) => { handlers[name] = handler; } });
    await handlers.session_start({}, {
      modelRegistry: { refresh: async (options) => { refreshCalls.push(options); } }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 目录以 id 集合为判据：新增的 gemini-test 进文件，已有条目保留自己的元数据。
    const models = readModels(prepared);
    assert.deepEqual(modelIds(models), ['gpt-test', 'claude-test', 'gemini-test']);
    assert.deepEqual(models[0].input, ['text', 'image']);
    assert.equal(requests.length >= 1, true);
    assert.equal(requests[0].url, 'http://127.0.0.1:9527/v1/models');
    assert.equal(requests[0].headers.authorization, 'Bearer gateway-key');
    assert.equal(requests[0].headers.accept, 'application/json');
    // 目录端点不做账号钉选：请求形状必须与 aih 启动器一致，否则两侧目录不同源。
    assert.equal(requests[0].headers['x-account-ref'], undefined);
    assert.deepEqual(refreshCalls, [{ providers: ['aih'], allowNetwork: false }]);

    handlers.session_shutdown();
  });
});

test('Pi 扩展在目录未变时不写文件也不刷新，请求失败时保持原样', async (t) => {
  const prepared = await prepareProjection(t);
  const probePath = loadExtensionProbe(prepared);
  const before = fs.readFileSync(prepared.modelsPath, 'utf8');

  await withStubs(t, async ({ setFetch }) => {
    const module = await import(pathToFileURL(probePath).href);
    const handlers = {};
    const refreshCalls = [];
    module.default({ on: (name, handler) => { handlers[name] = handler; } });

    // 1) 网关目录与磁盘一致：不改文件、不刷新。
    setFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'gpt-test' }, { id: 'claude-test' }] })
    }));
    await handlers.session_start({}, {
      modelRegistry: { refresh: async (options) => { refreshCalls.push(options); } }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fs.readFileSync(prepared.modelsPath, 'utf8'), before);
    assert.deepEqual(refreshCalls, []);

    // 2) 网关不可达：保持现有目录，绝不把空目录写进去。
    setFetch(async () => { throw new Error('ECONNREFUSED'); });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.readFileSync(prepared.modelsPath, 'utf8'), before);
    assert.deepEqual(refreshCalls, []);

    handlers.session_shutdown();
  });
});

test('Pi 扩展拒绝把空目录或缺失 baseUrl 的目录写回', async (t) => {
  const prepared = await prepareProjection(t);
  const probePath = loadExtensionProbe(prepared);
  const before = fs.readFileSync(prepared.modelsPath, 'utf8');

  await withStubs(t, async ({ setFetch }) => {
    const module = await import(pathToFileURL(probePath).href);
    const handlers = {};
    const refreshCalls = [];
    module.default({ on: (name, handler) => { handlers[name] = handler; } });

    setFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    await handlers.session_start({}, {
      modelRegistry: { refresh: async (options) => { refreshCalls.push(options); } }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fs.readFileSync(prepared.modelsPath, 'utf8'), before);
    assert.deepEqual(refreshCalls, []);

    handlers.session_shutdown();
  });
});
