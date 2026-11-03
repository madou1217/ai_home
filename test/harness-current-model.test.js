'use strict';

// 「标题里的模型来自 harness 自己的配置，而不是账号目录的默认模型」的回归测试。

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const { resolveHarnessCurrentModel } = require('../lib/harness/harness-current-model');

function makeHome() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aih-harness-model-'));
}

function writeJson(filePath, value) {
  nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  nodeFs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test('codebuddy 家族：读 settings.json 的 model（用户实际选的那个）', () => {
  const home = makeHome();
  writeJson(nodePath.join(home, '.codebuddy-cn', 'settings.json'), { model: 'deepseek-v4.1-flash' });
  writeJson(nodePath.join(home, '.codebuddy', 'settings.json'), { model: 'client-default' });
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'codebuddycn', env: { HOME: home } }),
    'deepseek-v4.1-flash'
  );
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'codebuddy', env: { HOME: home } }),
    'client-default'
  );
});

test('claude：--settings 文件优先，其次项目级，最后用户级', () => {
  const home = makeHome();
  const projectDir = nodePath.join(home, 'proj');
  writeJson(nodePath.join(home, '.claude', 'settings.json'), { model: 'user-model' });
  writeJson(nodePath.join(projectDir, '.claude', 'settings.json'), { model: 'project-model' });
  const settingsFile = nodePath.join(home, 'launch-settings.json');
  writeJson(settingsFile, { model: 'launch-model' });

  assert.equal(
    resolveHarnessCurrentModel({
      provider: 'claude',
      env: { HOME: home },
      forwardArgs: ['--settings', settingsFile],
      projectDir
    }),
    'launch-model'
  );
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'claude', env: { HOME: home }, projectDir }),
    'project-model'
  );
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'claude', env: { HOME: home }, projectDir: nodePath.join(home, 'other') }),
    'user-model'
  );
});

test('gemini / opencode / agy / grok / codex：各自配置口径', () => {
  const home = makeHome();
  writeJson(nodePath.join(home, '.gemini', 'settings.json'), { model: { name: 'gemini-4-flash' } });
  writeJson(nodePath.join(home, '.config', 'opencode', 'opencode.json'), { model: 'opencode/deepseek-v4.1-flash' });
  writeJson(nodePath.join(home, '.gemini', 'antigravity-cli', 'settings.json'), { model: 'Gemini 3.8 Flash (Low)' });
  nodeFs.mkdirSync(nodePath.join(home, '.grok'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(home, '.grok', 'config.toml'), '[models]\ndefault = "grok-5-code-fast"\n');
  nodeFs.mkdirSync(nodePath.join(home, '.codex'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(home, '.codex', 'config.toml'), 'model = "gpt-6.1-sol"\n');

  assert.equal(resolveHarnessCurrentModel({ provider: 'gemini', env: { HOME: home } }), 'gemini-4-flash');
  assert.equal(resolveHarnessCurrentModel({ provider: 'opencode', env: { HOME: home } }), 'opencode/deepseek-v4.1-flash');
  assert.equal(resolveHarnessCurrentModel({ provider: 'agy', env: { HOME: home } }), 'Gemini 3.8 Flash (Low)');
  assert.equal(resolveHarnessCurrentModel({ provider: 'grok', env: { HOME: home } }), 'grok-5-code-fast');
  assert.equal(resolveHarnessCurrentModel({ provider: 'codex', env: { HOME: home } }), 'gpt-6.1-sol');
});

test('读不到就返回空串（宁缺一段，也不写假模型名）', () => {
  const home = makeHome();
  for (const provider of ['claude', 'codebuddy', 'codebuddycn', 'gemini', 'opencode', 'grok', 'agy', 'codex']) {
    assert.equal(resolveHarnessCurrentModel({ provider, env: { HOME: home } }), '', provider);
  }
  // 没有配置口径的 provider 永远是空串，不回退到账号目录默认模型。
  assert.equal(resolveHarnessCurrentModel({ provider: 'kiro', env: { HOME: home } }), '');
  assert.equal(resolveHarnessCurrentModel({ provider: 'cline', env: { HOME: home } }), '');
  assert.equal(resolveHarnessCurrentModel({ provider: 'unknown', env: { HOME: home } }), '');
});

test('配置里是对象形状（{id} / {name}）也能读出来', () => {
  const home = makeHome();
  writeJson(nodePath.join(home, '.claude', 'settings.json'), { model: { id: 'claude-opus-5-5' } });
  assert.equal(resolveHarnessCurrentModel({ provider: 'claude', env: { HOME: home } }), 'claude-opus-5-5');
});


test('账号沙箱的配置根：CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME 优先于 HOME', () => {
  const home = makeHome();
  const sandbox = nodePath.join(home, 'sandbox');
  // HOME 里放一份「错的」，沙箱里放 CLI 真正会读的那份。
  writeJson(nodePath.join(home, '.claude', 'settings.json'), { model: 'home-model' });
  writeJson(nodePath.join(sandbox, '.claude', 'settings.json'), { model: 'sandbox-model' });
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'claude', env: { HOME: home, CLAUDE_CONFIG_DIR: nodePath.join(sandbox, '.claude') } }),
    'sandbox-model'
  );

  nodeFs.mkdirSync(nodePath.join(home, '.codex'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(home, '.codex', 'config.toml'), 'model = "home-codex"\n');
  nodeFs.mkdirSync(nodePath.join(sandbox, 'codex'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(sandbox, 'codex', 'config.toml'), 'model = "sandbox-codex"\n');
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'codex', env: { HOME: home, CODEX_HOME: nodePath.join(sandbox, 'codex') } }),
    'sandbox-codex'
  );

  writeJson(nodePath.join(sandbox, '.gemini', 'settings.json'), { model: { name: 'sandbox-gemini' } });
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'gemini', env: { HOME: home, GEMINI_CLI_HOME: nodePath.join(sandbox, '.gemini') } }),
    'sandbox-gemini'
  );
  // 显式 system settings 路径优先级最高（agy 就是这么注入的）
  const agySettings = nodePath.join(sandbox, 'agy-settings.json');
  writeJson(agySettings, { model: 'Gemini 3.8 Flash (Low)' });
  assert.equal(
    resolveHarnessCurrentModel({ provider: 'agy', env: { HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: agySettings } }),
    'Gemini 3.8 Flash (Low)'
  );
});

