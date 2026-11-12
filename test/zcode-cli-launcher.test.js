'use strict';

// 回归守卫（2026-11-04 用户指令）：WebUI/CLI 打开 zcode 时**绝不允许**落到第三方
// `zcode-app-cli`（kingsword09 非官方客户端，实测会弹它自己的更新横幅
// "Update available! 3.16.3-41 → 3.17.2-44 … github.com/kingsword09/zcode-cli"）。
//
// 事故链：官方 Desktop 3.16.3 的 bundle 曾不含 @zcode/tui，于是引入了「本地托管
// 工具」候选（<aiHome>/tools/zcode-cli，npm 装第三方包）并且它排在桌面 bundle 之前；
// Desktop 3.17.2（CLI 0.17.1）已自带全屏 TUI，第三方候选整体移除。本文件守住：
//   1. 第三方目录即便残留在磁盘上也不再被解析（防止回归时又静默用回去）；
//   2. 官方发行包布局按 zai-org/ZCode scripts/zcode-distribution/installer.mjs 的
//      真实安装形态识别（current 符号链接 + releases/<version>/bin/zcode.mjs）；
//   3. PATH 兜底不认 aih 自己的启动垫片目录（避免垫片套垫片）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveZcodeCliRuntimeCandidates,
  resolveZcodeDistCli,
  ensureZcodeCliLauncher
} = require('../lib/runtime/zcode-cli-launcher');
const { resolveProviderCliExecutable } = require('../lib/runtime/provider-cli-executable');

function makeRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-cli-'));
  const hostHome = path.join(root, 'host');
  const aiHome = path.join(root, 'ai-home');
  fs.mkdirSync(hostHome, { recursive: true });
  fs.mkdirSync(aiHome, { recursive: true });
  return { root, hostHome, aiHome };
}

function write(filePath, content = '#!/bin/sh\n') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function makeBundle(hostHome) {
  const cliPath = path.join(hostHome, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  const configPath = path.join(hostHome, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json');
  write(cliPath, '/* bundle */');
  write(configPath, '{}');
  return { cliPath, configPath };
}

function makeThirdPartyResidue(aiHome) {
  // 复刻第三方包被 npm 装进托管工具目录后的形态（bin 名与官方一致，叫 zcode）。
  write(path.join(aiHome, 'tools', 'zcode-cli', 'node_modules', '.bin', 'zcode'), '#!/usr/bin/env node\n');
}

test('第三方 zcode-app-cli 目录残留也不再被解析，bundle 是唯一兜底', () => {
  const { hostHome, aiHome } = makeRoots();
  const bundle = makeBundle(hostHome);
  makeThirdPartyResidue(aiHome);
  const candidates = resolveZcodeCliRuntimeCandidates({
    hostHomeDir: hostHome,
    aiHomeDir: aiHome
  });
  assert.deepEqual(candidates.map((candidate) => candidate.kind), ['desktop-bundle']);
  assert.equal(candidates[0].cliPath, bundle.cliPath);
});

test('官方发行包命令入口（~/.local/bin/zcode）优先于桌面 bundle', () => {
  const { hostHome, aiHome } = makeRoots();
  makeBundle(hostHome);
  const binPath = path.join(hostHome, '.local', 'bin', 'zcode');
  write(binPath);
  const candidates = resolveZcodeCliRuntimeCandidates({ hostHomeDir: hostHome, aiHomeDir: aiHome });
  assert.equal(candidates[0].kind, 'dist-bin');
  assert.equal(candidates[0].command, binPath);
});

test('官方安装器布局：current 符号链接指向 releases/<version>/bin/zcode.mjs', () => {
  const { hostHome, aiHome } = makeRoots();
  const version = '0.17.1';
  const entry = path.join(hostHome, '.zcode', 'runtime', 'releases', version, 'bin', 'zcode.mjs');
  write(entry, '// runtime entry\n');
  fs.symlinkSync(path.join(hostHome, '.zcode', 'runtime', 'releases', version),
    path.join(hostHome, '.zcode', 'runtime', 'current'));
  const resolved = resolveZcodeDistCli({ hostHomeDir: hostHome, aiHomeDir: aiHome });
  assert.equal(resolved.kind, 'dist-runtime');
  assert.equal(resolved.source, 'dist-runtime:current');
  assert.deepEqual(resolved.args, [path.join(hostHome, '.zcode', 'runtime', 'current', 'bin', 'zcode.mjs')]);
});

test('官方安装器布局：无 current 时回退 releases/<version>', () => {
  const { hostHome, aiHome } = makeRoots();
  const entry = path.join(hostHome, '.zcode', 'runtime', 'releases', '0.17.1', 'bin', 'zcode.mjs');
  write(entry);
  const resolved = resolveZcodeDistCli({ hostHomeDir: hostHome, aiHomeDir: aiHome });
  assert.equal(resolved.source, 'dist-runtime:releases/0.17.1');
  assert.deepEqual(resolved.args, [entry]);
});

test('PATH 兜底跳过 aih 启动垫片目录，不造成垫片套垫片', () => {
  const { hostHome, aiHome, root } = makeRoots();
  const elsewhere = path.join(root, 'elsewhere');
  const aihBin = path.join(aiHome, 'bin');
  write(path.join(aihBin, 'zcode'), '#!/bin/sh\nexec node /bundle/zcode.cjs "$@"\n');
  write(path.join(elsewhere, 'zcode'));
  const resolved = resolveZcodeDistCli({
    hostHomeDir: hostHome,
    aiHomeDir: aiHome,
    env: { PATH: `${aihBin}${path.delimiter}${elsewhere}` }
  });
  assert.equal(resolved.kind, 'path-bin');
  assert.equal(resolved.command, path.join(elsewhere, 'zcode'));

  const selfOnly = resolveZcodeDistCli({
    hostHomeDir: hostHome,
    aiHomeDir: aiHome,
    env: { PATH: aihBin }
  });
  assert.equal(selfOnly, null);
});

test('resolveZcodeCliExecutable：第三方残留时仍落到官方 bundle 垫片', () => {
  const { hostHome, aiHome } = makeRoots();
  const bundle = makeBundle(hostHome);
  makeThirdPartyResidue(aiHome);
  const executable = resolveProviderCliExecutable('zcode', bundle.cliPath, {
    hostHomeDir: hostHome,
    aiHomeDir: aiHome
  });
  // bundle 走 provider 配置垫片（<aiHome>/bin/zcode），内容 exec node <bundle>。
  assert.equal(executable, path.join(aiHome, 'bin', 'zcode'));
  const source = fs.readFileSync(executable, 'utf8');
  assert.ok(source.includes('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'), source);
  assert.ok(source.includes(JSON.stringify(bundle.cliPath).slice(1, -1)), source);
  assert.ok(!source.includes('tools/zcode-cli'), source);
});

test('ensureZcodeCliLauncher 幂等：内容不变时不重写垫片', () => {
  const { hostHome, aiHome } = makeRoots();
  const bundle = makeBundle(hostHome);
  const first = ensureZcodeCliLauncher({
    cliPath: bundle.cliPath,
    configPath: bundle.configPath,
    aiHomeDir: aiHome
  });
  assert.equal(first, path.join(aiHome, 'bin', 'zcode'));
  const stat = fs.statSync(first);
  const second = ensureZcodeCliLauncher({
    cliPath: bundle.cliPath,
    configPath: bundle.configPath,
    aiHomeDir: aiHome
  });
  assert.equal(second, first);
  const statAfter = fs.statSync(first);
  assert.equal(stat.mtimeMs, statAfter.mtimeMs);
});
