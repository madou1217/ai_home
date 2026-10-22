'use strict';

// AI 翻译数据面（/v0/webui/translation/*）的路由契约。
// 只测不依赖真实上游的部分：语言目录、语言检测、默认设置读写、模型候选形状、
// 以及在开 SSE 之前就该被拒绝的请求（超长 / 目标语言非法 / 未知子路径）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_TRANSLATION_INPUT_CHARS,
  __private,
  handleWebUiTranslationRoutes,
} = require('../lib/server/webui-translation-routes');

function createHarness({ aiHomeDir, method = 'GET', pathname, body, state = {}, options = {} }) {
  const out = { status: 0, payload: null, writes: [] };
  const payload = body === undefined ? '' : JSON.stringify(body);
  const ctx = {
    method,
    pathname,
    state,
    options,
    deps: {},
    aiHomeDir,
    fs,
    req: { on() {}, removeListener() {} },
    res: {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writeHead() {},
      flushHeaders() {},
      write(value) {
        out.writes.push(String(value));
        return true;
      },
      end() {
        this.writableEnded = true;
      },
    },
    readRequestBody: async () => Buffer.from(payload, 'utf8'),
    writeJson: (_res, status, value) => {
      out.status = status;
      out.payload = value;
    },
  };
  return { ctx, out };
}

function withTempHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-translation-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('translation languages route exposes the auto sentinel and supported targets', async (t) => {
  const aiHomeDir = withTempHome(t);
  const { ctx, out } = createHarness({
    aiHomeDir,
    pathname: '/v0/webui/translation/languages',
  });

  assert.equal(await handleWebUiTranslationRoutes(ctx), true);
  assert.equal(out.status, 200);
  assert.equal(out.payload.ok, true);
  assert.equal(out.payload.auto, 'auto');
  assert.ok(out.payload.languages.some((language) => language.code === 'zh-Hans'));
  assert.ok(out.payload.languages.some((language) => language.code === 'en'));
  // auto 不是真实语言，不能出现在可选语言目录里
  assert.ok(!out.payload.languages.some((language) => language.code === 'auto'));
});

test('translation detect route identifies input languages with confidence', async (t) => {
  const aiHomeDir = withTempHome(t);

  const english = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/detect',
    body: { text: 'The quick brown fox jumps over the lazy dog.' },
  });
  assert.equal(await handleWebUiTranslationRoutes(english.ctx), true);
  assert.equal(english.out.status, 200);
  assert.equal(english.out.payload.code, 'en');
  assert.equal(english.out.payload.confidence, 'high');

  const japanese = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/detect',
    body: { text: 'これは日本語のテキストです。' },
  });
  assert.equal(await handleWebUiTranslationRoutes(japanese.ctx), true);
  assert.equal(japanese.out.status, 200);
  assert.equal(japanese.out.payload.code, 'ja');
});

test('translation model resolution keeps namespace ids and strips only redundant provider prefixes', () => {
  const { resolveRequestModel } = __private;
  const catalog = {
    models: [
      { id: 'opencode/glm-5.3-flash-free', provider: 'opencode' },
      { id: 'gemini-3.8-flash-low', provider: 'agy' },
      { id: 'claude-sonnet-4', provider: 'claude' },
    ],
  };

  // `opencode/...` 是目录里的真实 id（命名空间型模型），不能拆成裸名。
  assert.deepEqual(
    resolveRequestModel({ model: 'opencode/glm-5.3-flash-free' }, catalog),
    { model: 'opencode/glm-5.3-flash-free', provider: '' },
  );

  // 目录里没有 `agy/gemini-...` 这个完整 id：兼容旧写法时拆成 provider + 裸模型。
  assert.deepEqual(
    resolveRequestModel({ model: 'agy/gemini-3.8-flash-low' }, catalog),
    { model: 'gemini-3.8-flash-low', provider: 'agy' },
  );

  // 显式 provider + 冗余前缀：目录没有完整 id 时剥掉，避免网关按字面 id 选号。
  assert.deepEqual(
    resolveRequestModel({ model: 'claude/claude-sonnet-4', provider: 'claude' }, catalog),
    { model: 'claude-sonnet-4', provider: 'claude' },
  );

  // 显式 provider + 命名空间型完整 id：保持原样。
  assert.deepEqual(
    resolveRequestModel({ model: 'opencode/glm-5.3-flash-free', provider: 'opencode' }, catalog),
    { model: 'opencode/glm-5.3-flash-free', provider: 'opencode' },
  );
});

test('translation stream falls back to saved settings before the catalog default', () => {
  const { resolveTranslationFallbackCatalog } = __private;
  const catalog = {
    models: [
      { id: 'claude-opus-4-6-thinking', provider: 'agy' },
      { id: 'gemini-2.5-flash', provider: 'agy' },
    ],
    defaultModel: 'claude-opus-4-6-thinking',
    defaultProvider: 'agy',
  };

  // 保存的设置优先：页面刚打开、请求还没带 model 时不能再落到首位 thinking 模型。
  assert.deepEqual(
    resolveTranslationFallbackCatalog(catalog, { model: 'gemini-2.5-flash', provider: 'agy' }),
    { ...catalog, defaultModel: 'gemini-2.5-flash', defaultProvider: 'agy' },
  );

  // 保存的模型已不在目录里：回落到目录默认，避免把已下线 id 送进网关。
  assert.deepEqual(
    resolveTranslationFallbackCatalog(catalog, { model: 'removed-model', provider: 'agy' }),
    catalog,
  );

  // provider 不匹配同样视为不可用（同名模型可能属于别的 provider）。
  assert.deepEqual(
    resolveTranslationFallbackCatalog(catalog, { model: 'gemini-2.5-flash', provider: 'gemini' }),
    catalog,
  );
});

test('translation default prefers fast flash models over thinking/pro tiers', () => {
  const { translationDefaultScore } = __private;
  const flash = translationDefaultScore({ id: 'gemini-2.5-flash' });
  assert.ok(flash > translationDefaultScore({ id: 'claude-opus-4-6-thinking' }));
  assert.ok(flash > translationDefaultScore({ id: 'gemini-2.5-pro' }));
  // 名字里有 flash 但思考很重的档位不能靠字母序抢到默认位。
  assert.ok(flash > translationDefaultScore({ id: 'gemini-3.8-flash-low' }));
  assert.ok(flash > translationDefaultScore({ id: 'gemini-3.1-flash-lite' }));
});

test('translation settings GET returns defaults then round-trips a partial patch', async (t) => {
  const aiHomeDir = withTempHome(t);

  const first = createHarness({ aiHomeDir, pathname: '/v0/webui/translation/settings' });
  assert.equal(await handleWebUiTranslationRoutes(first.ctx), true);
  assert.equal(first.out.status, 200);
  assert.equal(first.out.payload.settings.source, 'auto');
  assert.equal(first.out.payload.settings.target, 'zh-Hans');
  assert.equal(first.out.payload.settings.model, '');

  const save = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/settings',
    body: { source: 'en', target: 'ja', model: 'claude-sonnet-4', provider: 'Claude' },
  });
  assert.equal(await handleWebUiTranslationRoutes(save.ctx), true);
  assert.equal(save.out.status, 200);
  assert.equal(save.out.payload.settings.source, 'en');
  assert.equal(save.out.payload.settings.target, 'ja');
  assert.equal(save.out.payload.settings.model, 'claude-sonnet-4');
  // provider 统一小写
  assert.equal(save.out.payload.settings.provider, 'claude');
  assert.ok(save.out.payload.settings.updatedAt > 0);

  const second = createHarness({ aiHomeDir, pathname: '/v0/webui/translation/settings' });
  assert.equal(await handleWebUiTranslationRoutes(second.ctx), true);
  assert.equal(second.out.payload.settings.source, 'en');
  assert.equal(second.out.payload.settings.target, 'ja');
});

test('translation settings rejects an unsupported target instead of silently rewriting it', async (t) => {
  const aiHomeDir = withTempHome(t);
  const save = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/settings',
    body: { target: 'not-a-language' },
  });
  assert.equal(await handleWebUiTranslationRoutes(save.ctx), true);
  assert.equal(save.out.status, 400);
  assert.equal(save.out.payload.error, 'translation_target_unsupported');

  const readBack = createHarness({ aiHomeDir, pathname: '/v0/webui/translation/settings' });
  assert.equal(await handleWebUiTranslationRoutes(readBack.ctx), true);
  assert.equal(readBack.out.payload.settings.target, 'zh-Hans');
});

test('translation settings route is unavailable without a data directory', async () => {
  const { ctx, out } = createHarness({
    aiHomeDir: '',
    pathname: '/v0/webui/translation/settings',
  });
  assert.equal(await handleWebUiTranslationRoutes(ctx), true);
  assert.equal(out.status, 503);
  assert.equal(out.payload.error, 'translation_home_dir_unavailable');
});

test('translation models route returns a stable catalog shape on an empty state', async (t) => {
  const aiHomeDir = withTempHome(t);
  const { ctx, out } = createHarness({
    aiHomeDir,
    pathname: '/v0/webui/translation/models',
    state: { accounts: {} },
  });

  assert.equal(await handleWebUiTranslationRoutes(ctx), true);
  assert.equal(out.status, 200);
  assert.equal(out.payload.ok, true);
  assert.ok(Array.isArray(out.payload.models));
  assert.equal(typeof out.payload.defaultModel, 'string');
  assert.equal(typeof out.payload.defaultProvider, 'string');
  for (const model of out.payload.models) {
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.availableAccountCount, 'number');
  }
});

test('translation stream validates the request before opening the SSE response', async (t) => {
  const aiHomeDir = withTempHome(t);

  const missingTarget = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/stream',
    body: { text: 'hello' },
    state: { accounts: {} },
  });
  assert.equal(await handleWebUiTranslationRoutes(missingTarget.ctx), true);
  assert.equal(missingTarget.out.status, 400);
  assert.equal(missingTarget.out.payload.error, 'translation_target_unsupported');
  assert.equal(missingTarget.out.writes.length, 0);

  const blank = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/stream',
    body: { text: '   ', target: 'zh-Hans' },
    state: { accounts: {} },
  });
  assert.equal(await handleWebUiTranslationRoutes(blank.ctx), true);
  assert.equal(blank.out.status, 400);
  assert.equal(blank.out.payload.error, 'translation_text_required');
  assert.equal(blank.out.writes.length, 0);

  const tooLarge = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/stream',
    body: { text: 'x'.repeat(MAX_TRANSLATION_INPUT_CHARS + 1), target: 'zh-Hans' },
    state: { accounts: {} },
  });
  assert.equal(await handleWebUiTranslationRoutes(tooLarge.ctx), true);
  assert.equal(tooLarge.out.status, 413);
  assert.equal(tooLarge.out.payload.error, 'translation_input_too_large');
  assert.equal(tooLarge.out.writes.length, 0);
});

test('translation stream skips requests whose source already equals the target', async (t) => {
  const aiHomeDir = withTempHome(t);

  const explicit = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/stream',
    body: { text: 'hello', source: 'en', target: 'en' },
    state: { accounts: {} },
  });
  assert.equal(await handleWebUiTranslationRoutes(explicit.ctx), true);
  assert.equal(explicit.out.status, 400);
  assert.equal(explicit.out.payload.error, 'translation_same_language');
  assert.equal(explicit.out.writes.length, 0);

  // auto 时以本地检测为权威：整句英文 → 目标英语同样不发翻译请求。
  const auto = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/stream',
    body: { text: 'The quick brown fox jumps over the lazy dog.', target: 'en' },
    state: { accounts: {} },
  });
  assert.equal(await handleWebUiTranslationRoutes(auto.ctx), true);
  assert.equal(auto.out.status, 400);
  assert.equal(auto.out.payload.error, 'translation_same_language');
  assert.equal(auto.out.writes.length, 0);

  // 简体 / 繁体是不同语言：不能被当作「同语言」跳过（继续走到模型解析）。
  const chinese = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/stream',
    body: { text: '这是一段简体中文文本。', source: 'zh-Hans', target: 'zh-Hant' },
    state: { accounts: {} },
  });
  assert.equal(await handleWebUiTranslationRoutes(chinese.ctx), true);
  assert.equal(chinese.out.status, 409);
  assert.equal(chinese.out.payload.error, 'translation_model_unavailable');
});

test('translation stream fails closed when no translation model is available', async (t) => {
  const aiHomeDir = withTempHome(t);
  const { ctx, out } = createHarness({
    aiHomeDir,
    method: 'POST',
    pathname: '/v0/webui/translation/stream',
    body: { text: 'hello', target: 'zh-Hans' },
    state: { accounts: {} },
  });

  assert.equal(await handleWebUiTranslationRoutes(ctx), true);
  assert.equal(out.status, 409);
  assert.equal(out.payload.error, 'translation_model_unavailable');
  assert.equal(out.writes.length, 0);
});

test('unknown translation subpaths answer 404 without leaking other routers', async (t) => {
  const aiHomeDir = withTempHome(t);
  const { ctx, out } = createHarness({
    aiHomeDir,
    pathname: '/v0/webui/translation/unknown',
  });

  assert.equal(await handleWebUiTranslationRoutes(ctx), true);
  assert.equal(out.status, 404);
  assert.equal(out.payload.error, 'translation_route_not_found');
});
