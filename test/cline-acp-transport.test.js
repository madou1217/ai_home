'use strict';

// cline 续聊的 ACP 通道契约：传输声明（resumeMode）→ 启动档案派生 → 入口参数与认证方法。
// 这条链是「TUI 敲入被启动期吞掉」根因（2026-10-16）的修复面，回归必须锁死。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveNativeChatTransport,
  typesPromptIntoTerminal,
  usesNativeStreamUsage
} = require('../lib/server/native-session-chat-transport');
const {
  resolveNativeSessionLaunchProfile,
  nativeSessionSpawnOptions
} = require('../lib/server/native-session-launch-profile');
const { buildAcpEntryArgs, isAcpProvider } = require('../lib/runtime/acp-layouts');
const { clineStrategy } = require('../lib/cli/services/ai-cli/launch-profile/cline-strategy');
const { clineAuth, providersDocument } = require('./helpers/cline-credential');

test('cline 续聊声明为 acp-session 通道（prompt 不再 typed 敲入）', () => {
  const resume = resolveNativeChatTransport('cline', { isResume: true });
  assert.equal(resume.mode, 'acp-session');
  assert.equal(resume.promptDelivery, 'argv');
  assert.equal(typesPromptIntoTerminal('cline', { isResume: true }), false);

  const fresh = resolveNativeChatTransport('cline', { isResume: false });
  assert.equal(fresh.mode, 'headless-stream', '新会话保持 headless（实测可用，不动）');
});

test('只有本地会话文件缺 usage 的 provider 从 stream-json result.usage 记账', () => {
  assert.equal(usesNativeStreamUsage('qoder'), true);
  assert.equal(usesNativeStreamUsage('qodercn'), true);
  assert.equal(resolveNativeChatTransport('qoder').streamUsage, true);
  assert.equal(usesNativeStreamUsage('claude'), false);
  assert.equal(usesNativeStreamUsage('qoder', { isResume: true }), true);
  assert.equal(usesNativeStreamUsage('codebuddy'), false);
});

test('acp-session 形态派生：非 PTY、prompt 走 argv 通道、transcript 收尾', () => {
  const profile = resolveNativeSessionLaunchProfile('cline', { isResume: true });
  assert.equal(profile.mode, 'acp-session');
  assert.equal(profile.interactiveCli, false, 'ACP 无 TTY');
  assert.equal(profile.promptChannel, 'argv');
  assert.equal(profile.completeOnTranscriptUpdate, true, '完成判定仍靠 transcript 收尾');

  const spawnOptions = nativeSessionSpawnOptions(profile, { prompt: 'ping' });
  assert.equal(spawnOptions.prompt, 'ping');
  assert.equal(spawnOptions.initialInput, '', '不再敲入 PTY');
  assert.equal(spawnOptions.interactiveCli, false);
});

test('ACP 入口参数来自 acp-layouts 布局表（不写 provider 特判）', () => {
  assert.equal(isAcpProvider('cline'), true);
  assert.deepEqual(buildAcpEntryArgs('cline'), ['--acp']);
});

test('resolveAcpAuthMethod 与 -P 槽位同源：有 cline-pass 凭据给出 cline-pass', () => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-acp-'));
  try {
    // 无凭据文档：返回 ''（与 CLI 默认 cline 槽位对齐，不调 authenticate）。
    assert.equal(clineStrategy.resolveAcpAuthMethod({ fs, sandboxDir, path }), '');
    assert.deepEqual(clineStrategy.buildLaunchArgs({ fs, sandboxDir, path, argv: [] }), []);

    fs.mkdirSync(path.join(sandboxDir, '.cline', 'data', 'settings'), { recursive: true });
    const document = providersDocument('cline-pass', clineAuth('cline-user-1', 1, {
      expiresAt: Date.now() + 30 * 86400000
    }));
    fs.writeFileSync(
      path.join(sandboxDir, '.cline', 'data', 'settings', 'providers.json'),
      JSON.stringify(document)
    );

    assert.equal(clineStrategy.resolveAcpAuthMethod({ fs, sandboxDir, path }), 'cline-pass');
    assert.deepEqual(
      clineStrategy.buildLaunchArgs({ fs, sandboxDir, path, argv: [] }),
      ['-P', 'cline-pass'],
      '同一个槽位推导：-P 参数与 ACP authenticate 不得分叉'
    );
    // 用户显式指定 -P 时不覆盖（argv 形态专属行为）。
    assert.deepEqual(clineStrategy.buildLaunchArgs({ fs, sandboxDir, path, argv: ['-P', 'cline'] }), []);
  } finally {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
});
