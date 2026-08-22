'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AGY_MANAGED_HOOK_NAME,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  MANAGED_HOOK_MARKER,
  buildProviderHookReceiverUrl,
  buildProviderSessionHookConfigPatch,
  buildProviderSessionHookSenderCommand,
  diagnoseProviderSessionHookConfig,
  getProviderSessionSyncMode,
  installProviderSessionHookConfig,
  isManagedCommand
} = require('../lib/server/provider-session-hook-config');

test('builds Windows Codex hook commands quote-free for host mangling safety', () => {
  const command = buildProviderSessionHookSenderCommand({
    provider: 'codex',
    eventName: 'SessionStart',
    platform: 'win32',
    nodeExecPath: 'D:\\nvm4w\\nodejs\\node.exe',
    senderScriptPath: 'C:\\repo\\scripts\\aih-provider-session-hook-sender.js'
  });

  // codex 0.149 宿主经 MSVCRT arg 转义把 " 变成 \"，cmd 报 not recognized
  // → hook exit 1（2026-08-22）。无空格路径必须产出完全无引号、URL 无查询串
  // 的命令；含空格的 node 路径退回裸 node。
  assert.equal(command.includes('"'), false);
  assert.equal(command.includes('?'), false);
  assert.equal(
    command,
    'D:/nvm4w/nodejs/node.exe C:/repo/scripts/aih-provider-session-hook-sender.js'
    + ' --aih-provider-session-hook --provider codex --event SessionStart'
    + ' --url http://127.0.0.1:9527/v0/webui/session-events/provider-hook'
  );
  assert.equal(command.includes('powershell'), false);
  assert.equal(command.includes('/usr/bin/env'), false);
  assert.equal(isManagedCommand(command, 'codex'), true);
});

test('falls back to PATH node for spaced Windows node installs', () => {
  const command = buildProviderSessionHookSenderCommand({
    provider: 'codex',
    eventName: 'SessionStart',
    platform: 'win32',
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
    senderScriptPath: 'C:\\repo path\\scripts\\aih-provider-session-hook-sender.js'
  });

  assert.match(command, /^node /);
  assert.match(command, /"C:\/repo path\/scripts\/aih-provider-session-hook-sender\.js"/);
  assert.equal(isManagedCommand(command, 'codex'), true);
});

test('builds Codex hooks.json without replacing user hooks', () => {
  const existing = {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '/tmp/user-stop.sh'
            }
          ]
        }
      ]
    }
  };
  const patch = buildProviderSessionHookConfigPatch('codex', existing, {
    senderScriptPath: '/tmp/aih-hook.js',
    serverUrl: 'http://127.0.0.1:8317/v0/webui/session-events/provider-hook'
  });

  assert.equal(patch.ok, true);
  assert.equal(patch.targetKind, 'hooks.json');
  assert.equal(patch.config.hooks.Stop.length, 2);
  assert.equal(patch.config.hooks.Stop[0].hooks[0].command, '/tmp/user-stop.sh');
  assert.equal(isManagedCommand(patch.config.hooks.Stop[1].hooks[0].command, 'codex'), true);
  assert.equal(patch.config.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
});

test('replaces only managed Codex hook entries on rebuild', () => {
  const first = buildProviderSessionHookConfigPatch('codex', {}, {
    senderScriptPath: '/tmp/old.js',
    serverUrl: 'http://127.0.0.1:8317/v0/webui/session-events/provider-hook'
  }).config;
  first.hooks.Stop.unshift({
    hooks: [{ type: 'command', command: '/tmp/user-stop.sh' }]
  });

  const second = buildProviderSessionHookConfigPatch('codex', first, {
    senderScriptPath: '/tmp/new.js',
    serverUrl: 'http://127.0.0.1:8317/v0/webui/session-events/provider-hook'
  });

  assert.equal(second.config.hooks.Stop.length, 2);
  assert.equal(second.config.hooks.Stop[0].hooks[0].command, '/tmp/user-stop.sh');
  assert.match(second.config.hooks.Stop[1].hooks[0].command, /\/tmp\/new\.js/);
  assert.doesNotMatch(JSON.stringify(second.config), /\/tmp\/old\.js/);
});

test('builds Claude settings hooks with required lifecycle events', () => {
  const patch = buildProviderSessionHookConfigPatch('claude', { theme: 'dark' }, {
    senderScriptPath: '/tmp/aih-hook.js',
    serverUrl: 'http://127.0.0.1:8317/v0/webui/session-events/provider-hook'
  });

  assert.equal(patch.ok, true);
  assert.equal(patch.targetKind, 'settings.json');
  assert.equal(patch.config.theme, 'dark');
  assert.deepEqual(patch.events, ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);
  assert.equal(isManagedCommand(patch.config.hooks.Stop[0].hooks[0].command, 'claude'), true);
});

test('builds Grok hooks.json under ~/.grok/hooks/, matching official x.ai schema', () => {
  const patch = buildProviderSessionHookConfigPatch('grok', {}, {
    homeDir: '/home/u',
    senderScriptPath: '/tmp/aih-hook.js',
    serverUrl: 'http://127.0.0.1:8317/v0/webui/session-events/provider-hook'
  });

  assert.equal(patch.ok, true);
  assert.equal(patch.targetKind, 'hooks.json');
  assert.equal(patch.targetPath, require('node:path').join('/home/u', '.grok', 'hooks', 'aih-session-sync.json'));
  assert.deepEqual(patch.events, ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);
  assert.equal(patch.config.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(isManagedCommand(patch.config.hooks.Stop[0].hooks[0].command, 'grok'), true);

  const diagnostic = diagnoseProviderSessionHookConfig('grok', patch.config, { homeDir: '/home/u' });
  assert.equal(diagnostic.supported, true);
  assert.equal(diagnostic.syncMode, 'hook');
  assert.equal(diagnostic.installed, true);
  assert.deepEqual(diagnostic.missingEvents, []);
});

test('builds Gemini settings hooks and avoids model chunk hooks by default', () => {
  const patch = buildProviderSessionHookConfigPatch('gemini', {}, {
    senderScriptPath: '/tmp/aih-hook.js'
  });

  assert.equal(patch.ok, true);
  assert.deepEqual(patch.events, ['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd']);
  assert.equal(Object.prototype.hasOwnProperty.call(patch.config.hooks, 'AfterModel'), false);
  assert.equal(isManagedCommand(patch.config.hooks.AfterAgent[0].hooks[0].command, 'gemini'), true);
});

test('uses provider-specific hook timeout units', () => {
  const codex = buildProviderSessionHookConfigPatch('codex', {}, {
    senderScriptPath: '/tmp/aih-hook.js'
  });
  const gemini = buildProviderSessionHookConfigPatch('gemini', {}, {
    senderScriptPath: '/tmp/aih-hook.js'
  });

  assert.equal(codex.config.hooks.Stop[0].hooks[0].timeout, DEFAULT_HOOK_TIMEOUT_SECONDS);
  assert.equal(gemini.config.hooks.AfterAgent[0].hooks[0].timeout, DEFAULT_HOOK_TIMEOUT_MS);
});

test('builds Agy hooks.json using hookName schema and explicit event flag', () => {
  const patch = buildProviderSessionHookConfigPatch('agy', {}, {
    senderScriptPath: '/tmp/aih-hook.js',
    serverUrl: 'http://127.0.0.1:8317/v0/webui/session-events/provider-hook'
  });
  const hookDefinition = patch.config[AGY_MANAGED_HOOK_NAME];

  assert.equal(patch.ok, true);
  assert.equal(patch.targetKind, 'hooks.json');
  assert.equal(hookDefinition.enabled, true);
  assert.equal(Array.isArray(hookDefinition.PreInvocation), true);
  assert.equal(Array.isArray(hookDefinition.PostInvocation), true);
  assert.equal(Array.isArray(hookDefinition.Stop), true);
  // Windows 命令无引号化后 event 由 --event 标志携带（posix 为引号值），
  // URL 查询串仅 posix 保留；断言两种平台都可见的标志形式。
  assert.match(hookDefinition.PreInvocation[0].command, /--event .?PreInvocation\b/);
  assert.match(hookDefinition.PostInvocation[0].command, /--event .?PostInvocation\b/);
  assert.match(hookDefinition.Stop[0].command, /--event .?Stop\b/);
});

test('diagnoses installed and missing provider hook configs', () => {
  const missing = diagnoseProviderSessionHookConfig('gemini', {});
  assert.equal(missing.supported, true);
  assert.equal(missing.installed, false);
  assert.deepEqual(missing.missingEvents, ['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd']);

  const config = buildProviderSessionHookConfigPatch('gemini', {}, {
    senderScriptPath: '/tmp/aih-hook.js'
  }).config;
  const installed = diagnoseProviderSessionHookConfig('gemini', config);
  assert.equal(installed.installed, true);
  assert.deepEqual(installed.missingEvents, []);
});

test('getProviderSessionSyncMode reports honest tri-state instead of hiding unsupported providers', () => {
  // 有官方 hook 接入(DEFAULT_EVENTS_BY_PROVIDER / opencode 插件桥 / grok 官方 hooks.json)。
  assert.equal(getProviderSessionSyncMode('claude'), 'hook');
  assert.equal(getProviderSessionSyncMode('opencode'), 'hook');
  assert.equal(getProviderSessionSyncMode('grok'), 'hook');
  // 无官方 hook(或尚未验证接入),但 resolveSessionFilePath 有实现,靠 500ms 文件轮询兜底。
  assert.equal(getProviderSessionSyncMode('qoder'), 'polling');
  assert.equal(getProviderSessionSyncMode('qodercn'), 'polling');
  assert.equal(getProviderSessionSyncMode('kiro'), 'polling');
  // 连会话文件读取都没有,同步彻底不可用。
  assert.equal(getProviderSessionSyncMode('kimi'), 'unavailable');
});

test('diagnoseProviderSessionHookConfig surfaces syncMode on every branch, including unsupported providers', () => {
  const unsupported = diagnoseProviderSessionHookConfig('qoder', {});
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.syncMode, 'polling');

  const unavailable = diagnoseProviderSessionHookConfig('kimi', {});
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.syncMode, 'unavailable');

  const hookSupported = diagnoseProviderSessionHookConfig('gemini', {});
  assert.equal(hookSupported.syncMode, 'hook');

  const opencode = diagnoseProviderSessionHookConfig('opencode', {}, { fs: { existsSync: () => false } });
  assert.equal(opencode.syncMode, 'hook');
});

test('diagnoses Codex generated hooks as disabled when feature flag is false', () => {
  const config = buildProviderSessionHookConfigPatch('codex', {}, {
    senderScriptPath: '/tmp/aih-hook.js'
  }).config;
  const diagnostic = diagnoseProviderSessionHookConfig('codex', config, {
    codexConfigText: '[features]\nhooks = false\n',
    codexVersion: '0.137.0'
  });

  assert.equal(diagnostic.installed, false);
  assert.equal(diagnostic.disabled, true);
  assert.equal(diagnostic.codexFeatures.disabled, true);
  assert.deepEqual(diagnostic.missingEvents, []);
});

test('buildProviderHookReceiverUrl encodes provider and event', () => {
  assert.equal(
    buildProviderHookReceiverUrl({
      receiverUrl: 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook',
      provider: 'agy',
      eventName: 'PreInvocation'
    }),
    'http://127.0.0.1:9527/v0/webui/session-events/provider-hook?provider=agy&event=PreInvocation'
  );
});

test('sender command includes managed marker and shell-quoted values', () => {
  const command = buildProviderSessionHookSenderCommand({
    provider: 'agy',
    eventName: 'Stop',
    platform: 'linux',
    senderScriptPath: '/tmp/aih hook.js',
    receiverUrl: 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook?provider=agy&event=Stop'
  });

  assert.match(command, new RegExp(MANAGED_HOOK_MARKER));
  assert.match(command, /--provider 'agy'/);
  assert.match(command, /--event 'Stop'/);
  assert.match(command, /'\/tmp\/aih hook\.js'/);
});

test('installProviderSessionHookConfig writes Codex hooks and enables feature flag', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hook-install-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\ncodex_hooks = true\n', 'utf8');
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '/tmp/user-stop.sh'
            }
          ]
        }
      ]
    }
  }, null, 2), 'utf8');

  const result = installProviderSessionHookConfig('codex', {
    fs,
    path,
    homeDir,
    codexVersion: '0.137.0',
    senderScriptPath: '/tmp/aih-hook.js'
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
  assert.equal(hooksConfig.hooks.Stop.length, 2);
  assert.equal(hooksConfig.hooks.Stop[0].hooks[0].command, '/tmp/user-stop.sh');
  assert.equal(isManagedCommand(hooksConfig.hooks.Stop[1].hooks[0].command, 'codex'), true);
  const configToml = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.match(configToml, /^hooks = true$/m);
  assert.doesNotMatch(configToml, /^codex_hooks\s*=/m);
});

test('installProviderSessionHookConfig leaves absent Codex feature flag untouched', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hook-install-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = installProviderSessionHookConfig('codex', {
    fs,
    path,
    homeDir,
    codexVersion: '0.137.0',
    senderScriptPath: '/tmp/aih-hook.js'
  });

  assert.equal(result.ok, true);
  assert.equal(result.codexFeatures.changed, false);
  assert.equal(fs.existsSync(path.join(homeDir, '.codex', 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(homeDir, '.codex', 'hooks.json')), true);
});

test('installProviderSessionHookConfig writes Agy hookName schema', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hook-install-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = installProviderSessionHookConfig('agy', {
    fs,
    path,
    homeDir,
    senderScriptPath: '/tmp/aih-hook.js'
  });

  assert.equal(result.ok, true);
  const hooksPath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
  const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.equal(Boolean(hooksConfig[AGY_MANAGED_HOOK_NAME]), true);
  assert.equal(Array.isArray(hooksConfig[AGY_MANAGED_HOOK_NAME].Stop), true);
  // Windows 命令无引号化后 provider 由 --provider 标志携带（URL 查询串仅 posix 保留）
  assert.match(hooksConfig[AGY_MANAGED_HOOK_NAME].Stop[0].command, /--provider .?agy\b/);
});
