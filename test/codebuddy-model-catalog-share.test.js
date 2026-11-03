'use strict';

// 需求第 71 条回归守卫：CodeBuddy 家族账号投影里的模型清单（<configDir>/models.json）
// 必须与宿主是同一份物理文件——一份自定义模型，四个配置根、所有账号投影都是链接。
// 事故现场：5 个 codebuddy 投影里 4 个没有 models.json、1 个是 CLI 自建的空壳
// {"models":[]}，WebUI 打开 Desktop 后模型列表为空。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FAMILY_PROVIDERS } = require('../lib/runtime/codebuddy-family-layouts');
const { FAMILY_SHARED_ENTRIES, ensureFamilySessionLinks } = require('../lib/runtime/codebuddy-family-session-store');
const { getProviderStoragePolicy } = require('../lib/runtime/provider-storage-policy');
const { collectSharedToolEntryNames } = require('../lib/cli/services/session-store');

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cb-models-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('家族四支都把 models.json 声明为共享条目', () => {
  for (const provider of FAMILY_PROVIDERS) {
    const policy = getProviderStoragePolicy(provider);
    assert.ok(policy.sharedEntries.includes('models.json'), provider + ' 缺少 models.json');
  }
});

test('家族共享条目包含 models.json（与 mcp.json 同口径）', () => {
  assert.ok(FAMILY_SHARED_ENTRIES.includes('models.json'));
  assert.ok(FAMILY_SHARED_ENTRIES.includes('mcp.json'));
});

test('宿主模型清单建链到其余配置根（文件链接，不是目录链接）', (t) => {
  const home = withHome(t);
  const canonical = path.join(home, '.codebuddy');
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'models.json'), JSON.stringify({ models: [{ id: 'deepseek-v4.1-flash' }] }));

  const result = ensureFamilySessionLinks({ fs, hostHomeDir: home });
  assert.deepEqual(result.failed, []);

  for (const configDir of ['.codebuddy-cn', '.workbuddy-ai', '.workbuddy']) {
    const linkPath = path.join(home, configDir, 'models.json');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), configDir + ' 的 models.json 不是链接');
    assert.equal(fs.realpathSync(linkPath), fs.realpathSync(path.join(canonical, 'models.json')));
  }
});

test('宿主没有模型清单时不凭空造', (t) => {
  const home = withHome(t);
  fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true });
  ensureFamilySessionLinks({ fs, hostHomeDir: home });
  for (const configDir of ['.codebuddy-cn', '.workbuddy-ai', '.workbuddy']) {
    assert.equal(fs.existsSync(path.join(home, configDir, 'models.json')), false);
  }
});

test('账号投影的共享面严格等于声明：models.json 与 history.jsonl 都进', (t) => {
  const home = withHome(t);
  const configDir = path.join(home, '.codebuddy');
  fs.mkdirSync(configDir, { recursive: true });
  for (const name of ['models.json', 'mcp.json', 'history.jsonl']) {
    fs.writeFileSync(path.join(configDir, name), '{}');
  }

  const shared = collectSharedToolEntryNames(fs, 'codebuddy', [configDir]);
  assert.ok(shared.includes('models.json'));
  assert.ok(shared.includes('mcp.json'));
  assert.ok(shared.includes('history.jsonl'));
});

test('配置根里的空清单（[] 与 {"models":[]}）换成指向规范存储的链接', (t) => {
  const home = withHome(t);
  const canonical = path.join(home, '.codebuddy');
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'models.json'), JSON.stringify({ models: [{ id: 'deepseek-v4.1-flash' }] }));
  for (const [configDir, body] of [['.codebuddy-cn', '[]'], ['.workbuddy-ai', '{"models":[]}'], ['.workbuddy', '[]']]) {
    fs.mkdirSync(path.join(home, configDir), { recursive: true });
    fs.writeFileSync(path.join(home, configDir, 'models.json'), body);
  }

  const result = ensureFamilySessionLinks({ fs, hostHomeDir: home });
  assert.deepEqual(result.failed, []);
  for (const configDir of ['.codebuddy-cn', '.workbuddy-ai', '.workbuddy']) {
    const linkPath = path.join(home, configDir, 'models.json');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), configDir + ' 的空清单没被换成链接');
  }
});

test('配置根里已有一份非空清单时原样不动（不覆盖用户数据）', (t) => {
  const home = withHome(t);
  const canonical = path.join(home, '.codebuddy');
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'models.json'), JSON.stringify({ models: [{ id: 'a' }] }));
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
  const ownCatalog = path.join(home, '.workbuddy', 'models.json');
  fs.writeFileSync(ownCatalog, JSON.stringify({ models: [{ id: 'b' }] }));

  const result = ensureFamilySessionLinks({ fs, hostHomeDir: home });
  assert.equal(fs.lstatSync(ownCatalog).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(ownCatalog, 'utf8')).models[0].id, 'b');
  assert.ok(result.unresolved.includes(ownCatalog));
});

