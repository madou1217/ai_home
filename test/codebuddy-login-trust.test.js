'use strict';

// 回归守卫（2026-10-30 真机）：新增 codebuddy 2 号账号时，登录作业把 CLI 起在
// `<aiHomeDir>/run/login/codebuddy/auth-<jobId>/workspace`，CodeBuddy Code 首启弹
// 「Do you trust the files in this folder?」四个选项，作业就卡在那里不动。
//
// 修法：登录前把该工作目录写进 `<CODEBUDDY_CONFIG_DIR>/settings.json` 的
// `trustedDirectories`（CLI 自己选完信任项后写回的就是这个键）。真机验证：预写后同一
// 目录直接进 TUI，不再出现信任框。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CODEBUDDY_LOGIN_STRATEGY,
  SETTINGS_FILE,
  TRUST_PROMPT_PATTERN,
  SITE_MENU_PATTERN,
  LOGIN_URL_PATTERN,
  buildTrustPatterns,
  extractLoginUrl,
  resolveSiteIndex,
  resolveSiteMenuKeys,
  seedFolderTrust
} = require('../lib/server/oauth-strategies/codebuddy');
const { resolveLoginStrategy, DEFAULT_STRATEGY } = require('../lib/server/oauth-strategies');

function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-trust-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('登录前把工作目录写进 settings.json 的 trustedDirectories', () => withTemp((root) => {
  const configDir = path.join(root, '.codebuddy');
  const spawnCwd = path.join(root, 'workspace');
  fs.mkdirSync(spawnCwd, { recursive: true });

  const result = seedFolderTrust({ fs, path, configDir, spawnCwd });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  const settings = JSON.parse(fs.readFileSync(path.join(configDir, SETTINGS_FILE), 'utf8'));
  assert.deepEqual(settings.trustedDirectories, buildTrustPatterns(spawnCwd, path));
  // 必须带 `/**`：CLI 用 minimatch 匹配，纯目录名只对「完全相等」的路径生效。
  assert.ok(settings.trustedDirectories.every((pattern) => pattern.endsWith('/**')));
}));

test('幂等：第二次调用不再改文件，也不动其它键', () => withTemp((root) => {
  const configDir = path.join(root, '.codebuddy');
  const spawnCwd = path.join(root, 'workspace');
  fs.mkdirSync(spawnCwd, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const settingsPath = path.join(configDir, SETTINGS_FILE);
  fs.writeFileSync(settingsPath, JSON.stringify({
    trustedDirectories: ['/some/existing/**'],
    theme: 'dark',
    env: { FOO: '1' }
  }));

  const first = seedFolderTrust({ fs, path, configDir, spawnCwd });
  assert.equal(first.changed, true);
  const afterFirst = fs.readFileSync(settingsPath, 'utf8');
  const second = seedFolderTrust({ fs, path, configDir, spawnCwd });
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), afterFirst);

  const settings = JSON.parse(afterFirst);
  // 已有条目与无关键全部保留，只追加登录工作目录。
  assert.equal(settings.trustedDirectories[0], '/some/existing/**');
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.env, { FOO: '1' });
}));

test('settings.json 内容损坏时不抛错，重写成合法 JSON', () => withTemp((root) => {
  const configDir = path.join(root, '.codebuddy');
  const spawnCwd = path.join(root, 'workspace');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(spawnCwd, { recursive: true });
  const settingsPath = path.join(configDir, SETTINGS_FILE);
  fs.writeFileSync(settingsPath, '{ not json');

  const result = seedFolderTrust({ fs, path, configDir, spawnCwd });
  assert.equal(result.ok, true);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.ok(settings.trustedDirectories.some((pattern) => pattern.startsWith(spawnCwd)));
}));

test('入参不全时安静返回 ok:false（登录流程不能被它打断）', () => {
  assert.equal(seedFolderTrust({}).ok, false);
  assert.equal(seedFolderTrust({ fs, path, configDir: '/tmp/x', spawnCwd: '' }).ok, false);
});

test('codebuddy / codebuddycn 解析到带信任预置的登录策略', () => {
  for (const provider of ['codebuddy', 'codebuddycn']) {
    const strategy = resolveLoginStrategy(provider, '');
    assert.notEqual(strategy, DEFAULT_STRATEGY);
    assert.equal(typeof strategy.prepareLogin, 'function');
    assert.equal(typeof strategy.handlePrompt, 'function');
    assert.equal(strategy.prepareLogin, CODEBUDDY_LOGIN_STRATEGY.prepareLogin);
  }
});

test('信任框兜底：PTY 里出现该提示时回车确认默认项', () => {
  const writes = [];
  const job = {
    status: 'running',
    provider: 'codebuddy',
    logs: 'Do you trust the files in this folder?\n  > 1. Trust folder only (workspace)',
    _ptyProcess: { write: (value) => writes.push(value) }
  };
  const handled = CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps: {} });
  assert.equal(handled, true);
  assert.deepEqual(writes, ['\r']);
  // 同一个作业只回答一次，避免把后续输入吞掉。
  assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps: {} }), false);
  assert.equal(writes.length, 1);
});

// 信任框之后还有第二道必答题：站点菜单。没人按键作业就停在 starting，
// 连 authorizationUrl 都拿不到 —— 用户看到的就是「一直转圈」。
const SITE_MENU_LOG = [
  ' Select login method:',
  '',
  ' \u276f Log in via Chinese Site',
  '',
  '   Log in via International Site',
  '',
  '   Log in via Enterprise Domain',
  '',
  '   Log in via iOA (Tencent only)',
  '',
  ' (Use \u2191\u2193 to select, Enter to login)'
].join('\n');

test('站点菜单按键序列按 provider 区分：codebuddy 走国际站，codebuddycn 走国内站', () => {
  const intl = resolveSiteMenuKeys('codebuddy');
  assert.deepEqual(intl.map((step) => step.value), ['\x1b[B', '\r']);
  assert.ok(intl[1].delayMs > 0, '下移和回车必须错开，否则回车读到的还是旧选中项');

  const cn = resolveSiteMenuKeys('codebuddycn');
  assert.deepEqual(cn.map((step) => step.value), ['\r']);
  // 未知/空 provider 按国际站处理（codebuddy 是主 provider）。
  assert.deepEqual(resolveSiteMenuKeys('').map((step) => step.value), ['\x1b[B', '\r']);
});

test('站点菜单：codebuddy 作业自动下移并回车，且只回答一次', async () => {
  const writes = [];
  const states = [];
  const job = {
    status: 'running',
    provider: 'codebuddy',
    logs: SITE_MENU_LOG,
    _ptyProcess: { write: (value) => writes.push(value) }
  };
  const deps = {
    states: { LOGIN_METHOD_SELECTED: 'login_method_selected' },
    setAuthProgressState: (_job, state) => states.push(state),
    appendJobLog: () => {}
  };

  assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps }), true);
  assert.deepEqual(writes, ['\x1b[B'], '下移键立即写入');
  assert.deepEqual(states, ['login_method_selected']);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(writes, ['\x1b[B', '\r'], '回车在下移之后写入');

  // 后续任何输出都不能再往 PTY 里写键。
  assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps }), false);
  assert.equal(writes.length, 2);
});

test('站点菜单：回车被吞时定时补敲，CLI 开始等授权后立刻停手', async () => {
  const writes = [];
  const job = {
    status: 'running',
    provider: 'codebuddy',
    logs: SITE_MENU_LOG,
    _ptyProcess: { write: (value) => writes.push(value) }
  };
  // 用短间隔代替生产里的 3s。
  const deps = { siteMenuRetryIntervalMs: 60 };
  assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps }), true);
  assert.deepEqual(writes, ['\x1b[B']);

  // 回车没生效、PTY 也没有新日志：定时器照样补敲。
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(writes.includes('\r'), '必须靠定时器补敲，不能等下一次日志回调');

  // CLI 开始等授权后，即使菜单文字还在历史日志里也不能再敲。
  job.logs = SITE_MENU_LOG + '\n Waiting for auth... (Press ESC to cancel)';
  const settled = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(writes.length, settled, '看到前进信号后必须停手');
});

test('站点菜单：codebuddycn 直接回车选中默认项', () => {
  const writes = [];
  const job = {
    status: 'running',
    provider: 'codebuddycn',
    logs: SITE_MENU_LOG,
    _ptyProcess: { write: (value) => writes.push(value) }
  };
  assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps: {} }), true);
  assert.deepEqual(writes, ['\r']);
});

test('站点可显式指定：作业字段 > deps > AIH_CODEBUDDY_SITE > provider 默认', () => {
  // 作业字段最优先：codebuddy 也能选国内站。
  assert.deepEqual(resolveSiteMenuKeys('codebuddy', 'cn').map((s) => s.value), ['\r']);
  assert.deepEqual(resolveSiteMenuKeys('codebuddy', 'chinese-site').map((s) => s.value), ['\r']);
  // codebuddycn 也能选国际站。
  const intl = resolveSiteMenuKeys('codebuddycn', 'international');
  assert.deepEqual(intl.map((s) => s.value), ['\x1b[B', '\r']);
  assert.ok(intl[1].delayMs > 0);

  // 环境变量作为兜底（作业字段/deps 都没给时）。
  const previous = process.env.AIH_CODEBUDDY_SITE;
  process.env.AIH_CODEBUDDY_SITE = 'cn';
  try {
    const writes = [];
    const job = {
      status: 'running',
      provider: 'codebuddy',
      logs: SITE_MENU_LOG,
      _ptyProcess: { write: (value) => writes.push(value) }
    };
    assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps: {} }), true);
    assert.deepEqual(writes, ['\r'], '环境变量说国内站就直接回车，不再下移');
  } finally {
    if (previous === undefined) delete process.env.AIH_CODEBUDDY_SITE;
    else process.env.AIH_CODEBUDDY_SITE = previous;
  }
});

test('站点指定写错时不盲敲：退回 provider 默认', () => {
  // Enterprise Domain / iOA 需要再输入域名或工号，自动选择做不到，所以不认。
  assert.equal(resolveSiteIndex('codebuddy', 'enterprise'), 1);
  assert.equal(resolveSiteIndex('codebuddycn', 'ioa'), 0);
  assert.equal(resolveSiteIndex('codebuddy', 'nonsense'), 1);
  assert.equal(resolveSiteIndex('codebuddycn', ''), 0);
});

test('站点菜单文案只认 CodeBuddy 的选择框', () => {
  assert.equal(SITE_MENU_PATTERN.test(SITE_MENU_LOG), true);
  assert.equal(SITE_MENU_PATTERN.test('Select model'), false);
  const job = {
    status: 'running',
    provider: 'codebuddy',
    logs: 'Welcome to CodeBuddy Code',
    _ptyProcess: { write: () => { throw new Error('must not write'); } }
  };
  assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps: {} }), false);
});

// CLI 打印的授权地址没有 redirect_uri / code_challenge，通用提取器认不出来，
// 于是 job.authorizationUrl 一直是空，WebUI 上没有可点的授权链接。
const LOGIN_URL = 'https://www.codebuddy.ai/login?platform=CLI&state=20e96612-e7b8-47fc-bc23-0194a593f21f&version=2.178.1';

test('从 CLI 输出里认出 codebuddy 的授权地址', () => {
  assert.equal(extractLoginUrl('Open this URL: ' + LOGIN_URL + '\n Waiting for auth...'), LOGIN_URL);
  assert.equal(extractLoginUrl('no url here'), '');
  assert.equal(LOGIN_URL_PATTERN.test('https://www.codebuddy.cn/login?platform=CLI&state=x'), true);
  assert.equal(LOGIN_URL_PATTERN.test('https://evil.example.com/login?platform=CLI&state=x'), false);
});

test('updateProgress 把授权地址写进 job，并进入 auth_url_ready', () => {
  const states = [];
  const job = {
    status: 'running',
    provider: 'codebuddy',
    logs: 'Open this URL: ' + LOGIN_URL + '\n Waiting for auth...',
    authorizationUrl: '',
    redirectUri: ''
  };
  const deps = {
    stripAnsi: (text) => String(text || ''),
    states: { AUTH_URL_READY: 'auth_url_ready' },
    setAuthProgressState: (_job, state) => states.push(state)
  };
  CODEBUDDY_LOGIN_STRATEGY.updateProgress({ job, hints: { authorizationUrl: '', redirectUri: '', state: '' }, deps });
  assert.equal(job.authorizationUrl, LOGIN_URL);
  assert.deepEqual(states, ['auth_url_ready']);
});

test('提示文案只认 CodeBuddy 的信任框，不误伤其它输出', () => {
  assert.equal(TRUST_PROMPT_PATTERN.test('Do you trust the files in this folder?'), true);
  assert.equal(TRUST_PROMPT_PATTERN.test('trustedDirectories'), false);
  const job = { status: 'running', logs: 'Welcome to CodeBuddy', _ptyProcess: { write: () => { throw new Error('must not write'); } } };
  assert.equal(CODEBUDDY_LOGIN_STRATEGY.handlePrompt({ job, deps: {} }), false);
});
