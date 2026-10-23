'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const {
  readToolPermissionSettings
} = require('../lib/cli/services/toolkit/tool-app-settings');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += String(chunk);
    }
  };
}

function createBaseDeps(home) {
  const aiHomeDir = path.join(home, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return {
    fs,
    hostHomeDir: home,
    aiHomeDir,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      upsertAccountState() {},
      removeAccount() {},
      getAccountState() { return null; }
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return path.join(home, 'tool-config'); },
    getProfileDir() { return path.join(home, 'profile'); },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [], agy: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: true }; },
    ensureSessionStoreLinks() {},
    pickProjectDirectory() { return null; }
  };
}

async function runSettingsRequest(pathname, { method = 'GET', body, deps } = {}) {
  const req = body === undefined
    ? new EventEmitter()
    : Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.url = pathname;
  req.headers = {};
  const res = createResCapture();
  const url = new URL(`http://localhost${pathname}`);
  const handled = await handleWebUIRequest({
    method,
    pathname: url.pathname,
    url,
    req,
    res,
    deps,
    options: {},
    state: {}
  });
  return { handled, res, data: res.body ? JSON.parse(res.body) : null };
}

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tool-app-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, deps: createBaseDeps(home) };
}

test('GET tool app settings returns default max permission and capability', async (t) => {
  const { deps } = withHome(t);
  const { handled, res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/settings',
    { deps }
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(data.ok, true);
  assert.equal(data.appId, 'claude');
  assert.deepEqual(data.settings, {
    maxPermission: true,
    applyToHost: false,
    permissionArgs: [],
    // 默认关：装会话 Hook 要写用户的全局 CLI 配置，必须由用户显式打开。
    sessionHook: false,
    updatedAt: 0
  });
  assert.equal(data.capability.maxSupported, true);
  assert.deepEqual(data.capability.maxArgs, ['--permission-mode', 'bypassPermissions']);
  assert.equal(data.capability.hostSupported, true);
  assert.match(data.capability.hostDisplayPath, /\.claude[/\\]settings\.json$/);
  // 会话 Hook 的现状随能力一起下发，前端据此决定显不显示那个开关。
  assert.equal(data.capability.sessionHookSupported, true);
  assert.equal(typeof data.capability.sessionHookInstalled, 'boolean');
  // 权限参数目录随能力一起下发：前端只渲染这份数据，不维护 provider 名单
  const catalog = data.capability.permissionCatalog;
  assert.equal(catalog.verifiedCliVersion, '2.1.306');
  assert.ok(catalog.flags.some((entry) => entry.flag === '--permission-mode'));
  assert.ok(catalog.groups.approval);
});

test('PUT tool app settings persists WebUI-selected permission args', async (t) => {
  const { deps } = withHome(t);
  const { res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/settings',
    {
      method: 'PUT',
      body: {
        maxPermission: true,
        applyToHost: false,
        permissionArgs: ['--permission-mode', 'acceptEdits']
      },
      deps
    }
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(data.settings.permissionArgs, ['--permission-mode', 'acceptEdits']);
  const stored = readToolPermissionSettings(fs, deps.aiHomeDir);
  assert.deepEqual(stored.apps.claude.permissionArgs, ['--permission-mode', 'acceptEdits']);
});

test('PUT tool app settings rejects mutually exclusive or unknown permission args', async (t) => {
  const { deps } = withHome(t);

  // 互斥组合绝不落库（kimi 实测 -y × --auto 上游直接报错）
  const conflict = await runSettingsRequest('/v0/webui/toolkit/apps/kimi/settings', {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: false, permissionArgs: ['--yolo', '--auto'] },
    deps
  });
  assert.equal(conflict.res.statusCode, 400);
  assert.equal(conflict.data.error, 'permission_args_invalid');
  assert.equal(conflict.data.validation.conflicts.length, 1);

  // 取值不在枚举内
  const badValue = await runSettingsRequest('/v0/webui/toolkit/apps/claude/settings', {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: false, permissionArgs: ['--permission-mode', 'nope'] },
    deps
  });
  assert.equal(badValue.res.statusCode, 400);
  assert.equal(badValue.data.error, 'permission_args_invalid');

  // 关闭最大权限时不允许挑选具体参数（语义矛盾）
  const contradictory = await runSettingsRequest('/v0/webui/toolkit/apps/claude/settings', {
    method: 'PUT',
    body: { maxPermission: false, applyToHost: false, permissionArgs: ['--permission-mode', 'plan'] },
    deps
  });
  assert.equal(contradictory.res.statusCode, 400);
  assert.equal(contradictory.data.error, 'permission_args_requires_max_permission');
});

test('PUT tool app settings persists the per-provider switch', async (t) => {
  const { deps } = withHome(t);
  const { res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/settings',
    {
      method: 'PUT',
      body: { maxPermission: false, applyToHost: false },
      deps
    }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(data.settings.maxPermission, false);
  assert.equal(data.settings.applyToHost, false);
  const stored = readToolPermissionSettings(fs, deps.aiHomeDir);
  assert.equal(stored.apps.claude.maxPermission, false);
});

test('PUT tool app settings applyToHost writes the verified host config', async (t) => {
  const { home, deps } = withHome(t);
  const { res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/settings',
    {
      method: 'PUT',
      body: { maxPermission: true, applyToHost: true },
      deps
    }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(data.hostApply.applied, true);
  assert.equal(data.hostApply.changed, true);
  const hostConfig = path.join(home, '.claude', 'settings.json');
  assert.equal(fs.existsSync(hostConfig), true);
  assert.equal(JSON.parse(fs.readFileSync(hostConfig, 'utf8')).permissions.defaultMode, 'bypassPermissions');
});

test('PUT tool app settings rejects invalid payloads and unsupported hosts', async (t) => {
  const { deps } = withHome(t);

  const invalid = await runSettingsRequest('/v0/webui/toolkit/apps/claude/settings', {
    method: 'PUT',
    body: { maxPermission: 'yes', applyToHost: false },
    deps
  });
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(invalid.data.error, 'invalid_permission_payload');

  const contradictory = await runSettingsRequest('/v0/webui/toolkit/apps/claude/settings', {
    method: 'PUT',
    body: { maxPermission: false, applyToHost: true },
    deps
  });
  assert.equal(contradictory.res.statusCode, 400);
  assert.equal(contradictory.data.error, 'apply_to_host_requires_max_permission');

  const unsupportedHost = await runSettingsRequest('/v0/webui/toolkit/apps/gemini/settings', {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: true },
    deps
  });
  assert.equal(unsupportedHost.res.statusCode, 400);
  assert.equal(unsupportedHost.data.error, 'unsupported_app');
});

test('tool app settings route rejects unknown applications', async (t) => {
  const { deps } = withHome(t);
  const { res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/not-a-provider/settings',
    { deps }
  );

  assert.equal(res.statusCode, 400);
  assert.equal(data.ok, false);
  assert.equal(data.error, 'unsupported_app');
});

// ── 账户级作用域（2026-10-23）──────────────────────────────────────────────
// 路径 /v0/webui/toolkit/apps/<provider>/accounts/<ref>/settings：只作用于该账号，
// 优先级高于 provider 级；宿主配置是全局的，账户级不允许写。

const ACCOUNT_REF = 'acct_0123456789abcdefabcd';

test('an account-scoped PUT is stored under that account and read back by the same path', async (t) => {
  const { home, deps } = withHome(t);
  const providerPath = '/v0/webui/toolkit/apps/claude/settings';
  const accountPath = `/v0/webui/toolkit/apps/claude/accounts/${ACCOUNT_REF}/settings`;

  await runSettingsRequest(providerPath, {
    method: 'PUT',
    body: { maxPermission: false, applyToHost: false },
    deps
  });
  const scoped = await runSettingsRequest(accountPath, {
    method: 'PUT',
    // 账户级刻意只传一个字段：另一个没出现，就不该被写成默认值。
    body: { maxPermission: true },
    deps
  });
  assert.equal(scoped.res.statusCode, 200);
  assert.equal(scoped.data.accountRef, ACCOUNT_REF);
  assert.equal(scoped.data.settings.maxPermission, true);

  const readBack = await runSettingsRequest(accountPath, { deps });
  assert.equal(readBack.data.settings.maxPermission, true, '账户级读回自己那份');

  const providerWide = await runSettingsRequest(providerPath, { deps });
  assert.equal(providerWide.data.settings.maxPermission, false, 'provider 级不受影响');
  assert.equal(providerWide.data.accountRef, '');

  // 存储结构：provider 级在 apps，账户级在 accounts
  const store = readToolPermissionSettings(fs, deps.aiHomeDir);
  assert.equal(store.apps.claude.maxPermission, false);
  assert.equal(store.accounts[ACCOUNT_REF].maxPermission, true);
  assert.equal(store.accounts[ACCOUNT_REF].applyToHost, undefined, '账户级只记显式设过的字段');
});

test('an account-scoped PUT refuses to write the host config', async (t) => {
  const { deps } = withHome(t);
  const accountPath = `/v0/webui/toolkit/apps/claude/accounts/${ACCOUNT_REF}/settings`;
  const { res, data } = await runSettingsRequest(accountPath, {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: true },
    deps
  });
  assert.equal(res.statusCode, 400);
  assert.equal(data.error, 'account_scope_cannot_apply_to_host');
});

test('an account path with an invalid ref is refused, not silently treated as provider level', async (t) => {
  const { deps } = withHome(t);
  // 非法 ref 绝不能回落到 provider 级：那会把「改某个账号」变成「改所有账号」。
  const { res } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/accounts/not-a-ref/settings',
    { deps }
  );
  assert.equal(res.statusCode, 404);
});

// ── 会话 Hook 开关（2026-10-23）────────────────────────────────────────────
// 安装 Hook 会写用户的全局 CLI 配置（~/.claude/settings.json 等），所以默认关、
// 由用户在「高级设置」里显式打开。打开后自动升级会守着它（见 hook-survival.js）。

test('会话 Hook 默认关，且没带 sessionHook 的 PUT 不动它', async (t) => {
  const { home, deps } = withHome(t);
  const providerPath = '/v0/webui/toolkit/apps/claude/settings';

  const initial = await runSettingsRequest(providerPath, { deps });
  assert.equal(initial.data.settings.sessionHook, false, '默认不接管');

  // 只改启动权限的请求不该顺手把 Hook 接管也改了。
  const saved = await runSettingsRequest(providerPath, {
    method: 'PUT',
    body: { maxPermission: false, applyToHost: false },
    deps
  });
  assert.equal(saved.res.statusCode, 200);
  assert.equal(saved.data.settings.sessionHook, false);
  assert.equal(saved.data.sessionHookApply, null, '没带这个字段就什么都不做');

  const store = readToolPermissionSettings(fs, deps.aiHomeDir);
  assert.equal(store.apps.claude.sessionHook, false);
});

test('打开会话 Hook 会真的写进宿主配置，并回报改了没有', async (t) => {
  const { home, deps } = withHome(t);
  const providerPath = '/v0/webui/toolkit/apps/claude/settings';

  const opened = await runSettingsRequest(providerPath, {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: false, sessionHook: true },
    deps
  });
  assert.equal(opened.res.statusCode, 200);
  assert.equal(opened.data.settings.sessionHook, true);
  assert.equal(opened.data.sessionHookApply.ok, true);
  assert.equal(opened.data.sessionHookApply.enabled, true);

  // 宿主配置里真的出现了 aih 托管的 Hook 命令。
  const settingsPath = path.join(home, '.claude', 'settings.json');
  assert.equal(fs.existsSync(settingsPath), true, '应该创建/更新宿主配置文件');
  const written = fs.readFileSync(settingsPath, 'utf8');
  assert.match(written, /--aih-provider-session-hook/);

  // 再读一次能力面：应当报「已装着」。
  const reread = await runSettingsRequest(providerPath, { deps });
  assert.equal(reread.data.capability.sessionHookInstalled, true);
});

// 关掉开关的语义是「别再动我的东西」，不是「把已经装好的拆掉」：删除会改写用户的
// 全局配置，而用户关掉它通常只是不想让 aih 继续维护。
test('关闭会话 Hook 只停掉接管，不删除已有配置', async (t) => {
  const { home, deps } = withHome(t);
  const providerPath = '/v0/webui/toolkit/apps/claude/settings';

  await runSettingsRequest(providerPath, {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: false, sessionHook: true },
    deps
  });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const installedText = fs.readFileSync(settingsPath, 'utf8');

  const closed = await runSettingsRequest(providerPath, {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: false, sessionHook: false },
    deps
  });
  assert.equal(closed.res.statusCode, 200);
  assert.equal(closed.data.settings.sessionHook, false);
  assert.equal(closed.data.sessionHookApply.action, 'kept_existing_hook');
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), installedText, '已有配置原样保留');
});

test('不支持会话 Hook 的应用打开开关会被拒', async (t) => {
  const { deps } = withHome(t);
  const { res, data } = await runSettingsRequest('/v0/webui/toolkit/apps/kiro/settings', {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: false, sessionHook: true },
    deps
  });
  assert.equal(res.statusCode, 400);
  assert.equal(data.error, 'unsupported_session_hook');
});
