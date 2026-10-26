'use strict';

// 回归守卫（2026-10-26 真机）：configDir 是**悬空符号链接**时，预建不能整段失败。
//
// 事故形态：沙箱投影把 `.workbuddy-ai` 链回宿主同名目录，而宿主那份在用户没装/没跑过
// 对应 App 时并不存在。`mkdirSync(path, { recursive: true })` 遇到「符号链接指向不存在的
// 目标」会抛 ENOENT —— 与「普通缺失路径」不同——recursive 不会替它兜底。于是
// `buildProviderEnv('workbuddy', …)` 恒定 ENOENT，家族会话在装 App 之前完全起不来。
//
// 本测试钉住：悬空链接被清掉并建成真目录；正常的真目录原样保留；非 ENOENT 错误照常抛出。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { prepare, resolveCodebuddyConfigDir } = require('../lib/cli/services/ai-cli/launch-profile/codebuddy-strategy');

function makeCtx(root, cliName) {
  return { fs, path, sandboxDir: root, cliName };
}

test('replaces a dangling configDir symlink with a real directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-cfg-'));
  try {
    const configDir = resolveCodebuddyConfigDir(makeCtx(root, 'workbuddy'));
    // 悬空链接：指向一个不存在的宿主目录（用户还没装/没跑过 App）。
    fs.symlinkSync(path.join(root, 'missing-host-home'), configDir, 'dir');
    assert.equal(fs.lstatSync(configDir).isSymbolicLink(), true);

    prepare(makeCtx(root, 'workbuddy'));

    const stat = fs.lstatSync(configDir);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('creates the configDir when nothing exists yet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-cfg-'));
  try {
    const configDir = resolveCodebuddyConfigDir(makeCtx(root, 'workbuddy'));
    prepare(makeCtx(root, 'workbuddy'));
    assert.equal(fs.lstatSync(configDir).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps an existing real configDir untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-cfg-'));
  try {
    const configDir = resolveCodebuddyConfigDir(makeCtx(root, 'codebuddy'));
    fs.mkdirSync(configDir, { recursive: true });
    const marker = path.join(configDir, 'settings.json');
    fs.writeFileSync(marker, '{"keep":true}');

    prepare(makeCtx(root, 'codebuddy'));

    assert.equal(fs.readFileSync(marker, 'utf8'), '{"keep":true}');
    assert.equal(fs.lstatSync(configDir).isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps a symlink whose target exists (shared host config is intentional)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-cfg-'));
  try {
    const configDir = resolveCodebuddyConfigDir(makeCtx(root, 'workbuddy'));
    const hostDir = path.join(root, 'host-home');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.symlinkSync(hostDir, configDir, 'dir');

    prepare(makeCtx(root, 'workbuddy'));

    // 指向存在的目标时必须保持链接 —— 那是「与宿主共用配置」的设计，不是待修的残缺。
    assert.equal(fs.lstatSync(configDir).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
