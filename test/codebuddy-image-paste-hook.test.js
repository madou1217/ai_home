'use strict';

// CLI 粘贴图片自动借视觉的回归守卫（2026-11-04）：
// iTerm2 粘贴图片只会在输入框里留下 `pasted-image-*.png` 临时路径；CodeBuddy 的
// UserPromptSubmit hook 必须能从 prompt 里认出它、调网关视觉模型，并把描述作为
// additionalContext 注入。这里锁住纯逻辑与 settings 合并，避免 hook 静默失效。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findPastedImagePaths,
  hookOutput,
  pickVisionModel,
  runHook
} = require('../scripts/codebuddy-image-paste-hook');
const {
  ensureCodebuddyImagePasteHook,
  HOOK_SCRIPT_BASENAME
} = require('../lib/runtime/codebuddy-image-paste-hook');

function tempDir(t, prefix = 'aih-image-hook-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeImage(dir, name = 'pasted-image-test.png') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return file;
}

function okJson(body) {
  return { ok: true, json: async () => body };
}

test('findPastedImagePaths 只认临时目录里的 pasted-image 文件', (t) => {
  const dir = tempDir(t);
  const file = writeImage(dir);
  assert.deepEqual(findPastedImagePaths(`看图 ${file}`), [file]);
  assert.deepEqual(findPastedImagePaths('没有图片'), []);
  // 非临时目录 / 非 pasted-image 一律不读
  const other = path.join(dir, 'other.png');
  fs.writeFileSync(other, 'x');
  assert.deepEqual(findPastedImagePaths(`看图 ${other}`), []);
});

test('pickVisionModel 优先选快模型，否则取第一个', () => {
  assert.equal(pickVisionModel([
    { id: 'claude-haiku-4.5' },
    { id: 'gemini-3-flash' }
  ]), 'gemini-3-flash');
  assert.equal(pickVisionModel([{ id: 'custom-vision' }]), 'custom-vision');
  assert.equal(pickVisionModel([]), '');
});

test('runHook：命中粘贴路径时调视觉模型并返回 additionalContext', async (t) => {
  const dir = tempDir(t);
  const file = writeImage(dir, `pasted-image-${Date.now()}.png`);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/v1/models')) {
      return okJson({ data: [{ id: 'gemini-3-flash' }, { id: 'claude-haiku-4.5' }] });
    }
    return okJson({
      choices: [{ message: { content: '一张卡片，写着“面”，有两条青色横线。' } }]
    });
  };
  const result = await runHook({
    hookInput: { prompt: `这张图是什么？${file}` },
    env: { AIH_GATEWAY_BASE_URL: 'http://127.0.0.1:9527', AIH_GATEWAY_API_KEY: 'test-key' },
    fetch: fakeFetch,
    fs
  });
  assert.match(result.additionalContext, /视觉模型（gemini-3-flash）/);
  assert.match(result.additionalContext, /面/);
  const completion = calls.find((call) => call.url.endsWith('/v1/chat/completions'));
  assert.ok(completion);
  const body = JSON.parse(completion.init.body);
  assert.equal(body.model, 'gemini-3-flash');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  // 输出信封是 CLI 认的 hookSpecificOutput.additionalContext
  const output = hookOutput(result.additionalContext);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /面/);
});

test('runHook：没有粘贴图片时不注入任何内容', async () => {
  const result = await runHook({ hookInput: { prompt: '普通问题' }, env: {} });
  assert.equal(result.additionalContext, '');
  assert.equal(hookOutput(result.additionalContext), null);
});

test('runHook：没有 aih 网关标记时保持静默（共享 settings 不影响原生 CodeBuddy）', async (t) => {
  const dir = tempDir(t);
  const file = writeImage(dir, `pasted-image-${Date.now()}.png`);
  const result = await runHook({
    hookInput: { prompt: `看图 ${file}` },
    env: {},
    fetch: async () => { throw new Error('should not fetch'); },
    fs
  });
  assert.equal(result.additionalContext, '');
});

test('runHook：有网关地址但缺 key 时给出 aih-collab fallback', async (t) => {
  const dir = tempDir(t);
  const file = writeImage(dir, `pasted-image-${Date.now()}.png`);
  const result = await runHook({
    hookInput: { prompt: `看图 ${file}` },
    env: { AIH_GATEWAY_BASE_URL: 'http://127.0.0.1:9527' },
    fetch: async () => { throw new Error('should not fetch'); },
    fs
  });
  assert.match(result.additionalContext, /AIH_GATEWAY_API_KEY/);
  assert.match(result.additionalContext, /aih-collab/);
});

test('ensureCodebuddyImagePasteHook 合并 hook 且幂等', (t) => {
  const dir = tempDir(t);
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    theme: 'light',
    hooks: {
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{ type: 'command', command: 'echo existing' }]
      }]
    }
  }, null, 2));
  const first = ensureCodebuddyImagePasteHook({
    fs,
    settingsPath,
    nodePathValue: '/usr/local/bin/node',
    scriptPath: path.join(__dirname, '..', 'scripts', HOOK_SCRIPT_BASENAME)
  });
  assert.equal(first.changed, true);
  const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(saved.theme, 'light');
  const entries = saved.hooks.UserPromptSubmit;
  assert.equal(entries.length, 2);
  assert.match(entries[0].hooks[0].command, /echo existing/);
  assert.match(entries[1].hooks[0].command, new RegExp(HOOK_SCRIPT_BASENAME));
  const second = ensureCodebuddyImagePasteHook({
    fs,
    settingsPath,
    nodePathValue: '/usr/local/bin/node',
    scriptPath: path.join(__dirname, '..', 'scripts', HOOK_SCRIPT_BASENAME)
  });
  assert.equal(second.changed, false);
});
