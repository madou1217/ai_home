'use strict';

// 用户硬规则（2026-10-31）：会话数据在磁盘上**绝不允许出现第二份**。
// 允许的只有：软链接、硬链接（同一 inode）、以及同文件系统的 rename（移动）。
// 复制（cpSync / copyFileSync / fs-extra copy 及其 EXDEV 退化）一律不许。
//
// 这里守两件事：
//   1) 会话存储相关的四个模块源码里不许再出现复制原语（静态守卫，防回归）；
//   2) cline 的"接管"在跨设备时 fail-closed：不复制、不建链、原文件留在原处。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureClineSharedSessionState } = require('../lib/cli/services/ai-cli/launch-profile/cline-shared-session-store');

const SESSION_STORE_MODULES = [
  'lib/cli/services/session-store.js',
  'lib/cli/services/ai-cli/launch-profile/cline-shared-session-store.js',
  'lib/cli/services/ai-cli/launch-profile/opencode-strategy.js',
  'lib/runtime/codebuddy-family-session-store.js'
];

test('会话存储模块不再调用任何复制原语（白名单必须写明理由）', () => {
  const offenders = [];
  for (const relative of SESSION_STORE_MODULES) {
    const lines = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const primitive = ['cpSync(', 'copyFileSync(', 'copySync('].find((name) => line.includes(name));
      if (!primitive) return;
      // 允许"非会话数据"的复制，但必须在紧邻的三行内写明 session-copy-allow 及理由。
      const context = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
      if (!context.includes('session-copy-allow')) offenders.push(`${relative}:${index + 1} ${primitive}`);
    });
  }
  assert.deepEqual(offenders, []);
});

function withRoot(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-no-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fn({ root, sandboxDir: path.join(root, 'sandbox'), hostHomeDir: path.join(root, 'home') });
}

function crossDeviceFs() {
  return {
    ...fs,
    renameSync: (from, to) => {
      if (String(from).includes(`${path.sep}sandbox${path.sep}`)) {
        const error = new Error('EXDEV: cross-device link not permitted');
        error.code = 'EXDEV';
        throw error;
      }
      return fs.renameSync(from, to);
    }
  };
}

test('cline 有真实会话数据：不接管（不搬/不复制/不建链），原文件还在', (t) => withRoot(t, ({ sandboxDir, hostHomeDir }) => {
  const projectionFile = path.join(sandboxDir, '.cline', 'data', 'sessions', 's1', 'session.json');
  fs.mkdirSync(path.dirname(projectionFile), { recursive: true });
  fs.writeFileSync(projectionFile, '{"messages":[]}\n');

  const summary = ensureClineSharedSessionState({
    fs: crossDeviceFs(),
    path,
    sandboxDir,
    hostHomeDir,
    DatabaseSync: null
  });

  assert.equal(summary.deferred, 'legacy-data-present');
  assert.equal(summary.linked, 0);
  // 原文件没被动过
  assert.equal(fs.existsSync(projectionFile), true);
  assert.equal(fs.readFileSync(projectionFile, 'utf8'), '{"messages":[]}\n');
  // 宿主侧没有冒出副本
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.cline', 'data', 'sessions', 's1', 'session.json')), false);
  // 也没有建链（fail-closed）
  assert.equal(fs.existsSync(path.join(sandboxDir, '.cline', 'data', 'sessions')), true);
  assert.equal(fs.lstatSync(path.join(sandboxDir, '.cline', 'data', 'sessions')).isSymbolicLink(), false);
}));

test('cline 投影里没有真实数据时：照常建链（行为未受影响）', (t) => withRoot(t, ({ sandboxDir, hostHomeDir }) => {
  fs.mkdirSync(path.join(sandboxDir, '.cline', 'data'), { recursive: true });

  const summary = ensureClineSharedSessionState({ fs, path, sandboxDir, hostHomeDir, DatabaseSync: null });

  assert.equal(summary.deferred, '');
  assert.equal(
    fs.lstatSync(path.join(sandboxDir, '.cline', 'data', 'sessions')).isSymbolicLink(),
    true
  );
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.cline', 'data', 'sessions')), true);
}));
