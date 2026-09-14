'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CHANNELS,
  detectCliChannel
} = require('../lib/server/provider-cli-upgrade/upgrade-channel');

// 用真实文件系统造链接，因为这个模块的全部价值就在于 realpath 解析正确。
function makeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-upgrade-channel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('codex shim → standalone/current 链条能解析到 standalone_release', (t) => {
  const root = makeTree(t);
  const releaseBin = path.join(root, '.codex/packages/standalone/releases/0.154.0-arm64/bin');
  fs.mkdirSync(releaseBin, { recursive: true });
  fs.writeFileSync(path.join(releaseBin, 'codex'), '#!/bin/sh\n');
  const current = path.join(root, '.codex/packages/standalone/current');
  fs.symlinkSync(path.join(root, '.codex/packages/standalone/releases/0.154.0-arm64'), current);
  // aih 自己写的 ~/.local/bin/codex shim 这一层也要能穿透。
  const localBin = path.join(root, '.local/bin');
  fs.mkdirSync(localBin, { recursive: true });
  fs.symlinkSync(path.join(current, 'bin/codex'), path.join(localBin, 'codex'));

  const result = detectCliChannel({
    resolvedPath: path.join(localBin, 'codex'),
    standaloneRoots: [path.join(root, '.codex/packages/standalone/releases')],
    npmGlobalRoot: path.join(root, 'npm-global')
  });

  assert.equal(result.channel, CHANNELS.STANDALONE_RELEASE);
  assert.equal(result.pinnable, true);
  // 旧 release 目录还在本地，回滚可跳过整包下载（但 resolve_release 仍要联网）。
  assert.equal(result.rollbackReusesLocalRelease, true);
  assert.ok(result.evidence.includes('resolved_through_link'));
});

test('npm 全局安装判定为 npm_global 且可钉版本但不可离线回滚', (t) => {
  const root = makeTree(t);
  const pkgBin = path.join(root, 'npm-global/@google/gemini-cli/dist');
  fs.mkdirSync(pkgBin, { recursive: true });
  fs.writeFileSync(path.join(pkgBin, 'gemini.js'), '');

  const result = detectCliChannel({
    resolvedPath: path.join(pkgBin, 'gemini.js'),
    npmGlobalRoot: path.join(root, 'npm-global'),
    standaloneRoots: []
  });

  assert.equal(result.channel, CHANNELS.NPM_GLOBAL);
  assert.equal(result.pinnable, true);
  assert.equal(result.rollbackReusesLocalRelease, false);
});

test('provider 自带更新器的布局判定为 vendor_selfupdate 且不可钉版本', (t) => {
  const root = makeTree(t);
  const versionDir = path.join(root, '.local/share/claude/versions/2.1.267');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, 'claude'), '');

  const result = detectCliChannel({
    resolvedPath: path.join(versionDir, 'claude'),
    vendorSelfUpdateRoots: [path.join(root, '.local/share/claude/versions')],
    npmGlobalRoot: path.join(root, 'npm-global')
  });

  assert.equal(result.channel, CHANNELS.VENDOR_SELFUPDATE);
  // 不可钉版本 → policy 会直接判 ineligible，永远不会自动接管它。
  assert.equal(result.pinnable, false);
});

// 本机实测形态：opencode 同时存在三份非 npm 安装，而 npm 里还装着 opencode-ai。
// 这是「升级成功、回滚成功、跑的还是坏的那份」的温床，必须被标出来。
test('npm 装了但 PATH 赢的是别处 → 标记 shadowedNpmInstall', (t) => {
  const root = makeTree(t);
  const winner = path.join(root, '.opencode/bin');
  fs.mkdirSync(winner, { recursive: true });
  fs.writeFileSync(path.join(winner, 'opencode'), '');
  const npmRoot = path.join(root, 'npm-global');
  const npmPkg = path.join(npmRoot, 'opencode-ai');
  fs.mkdirSync(npmPkg, { recursive: true });

  const result = detectCliChannel({
    resolvedPath: path.join(winner, 'opencode'),
    npmGlobalRoot: npmRoot,
    npmPackageDir: npmPkg,
    standaloneRoots: []
  });

  assert.equal(result.channel, CHANNELS.UNKNOWN);
  assert.equal(result.shadowedNpmInstall, true);
  assert.equal(result.pinnable, false);
  assert.ok(result.evidence.includes('npm_install_shadowed'));
});

test('二进制本就在 npm 全局里时不算影子安装', (t) => {
  const root = makeTree(t);
  const npmRoot = path.join(root, 'npm-global');
  const npmPkg = path.join(npmRoot, 'opencode-ai');
  const bin = path.join(npmPkg, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'opencode'), '');

  const result = detectCliChannel({
    resolvedPath: path.join(bin, 'opencode'),
    npmGlobalRoot: npmRoot,
    npmPackageDir: npmPkg
  });

  assert.equal(result.channel, CHANNELS.NPM_GLOBAL);
  assert.equal(result.shadowedNpmInstall, false);
});

test('未解析到 CLI 时返回 unknown 而不抛', () => {
  const result = detectCliChannel({ resolvedPath: '' });
  assert.equal(result.channel, CHANNELS.UNKNOWN);
  assert.equal(result.pinnable, false);
  assert.deepEqual(result.evidence, ['cli_not_resolved']);
});

// 前缀相同但不是子目录，不能误判。
test('路径前缀相近不会被误判为同一渠道', (t) => {
  const root = makeTree(t);
  const decoy = path.join(root, 'npm-global-other');
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, 'gemini'), '');

  const result = detectCliChannel({
    resolvedPath: path.join(decoy, 'gemini'),
    npmGlobalRoot: path.join(root, 'npm-global')
  });

  assert.equal(result.channel, CHANNELS.UNKNOWN);
});

// 误报防线：npm 里压根没装这个包时，不能因为路径拼得出来就喊影子安装。
// 实测该 bug 会让 codex 与 claude 全部误报。
test('npm 包目录不存在时不报影子安装', (t) => {
  const root = makeTree(t);
  const winner = path.join(root, '.codex/bin');
  fs.mkdirSync(winner, { recursive: true });
  fs.writeFileSync(path.join(winner, 'codex'), '');
  const npmRoot = path.join(root, 'npm-global');
  fs.mkdirSync(npmRoot, { recursive: true });

  const result = detectCliChannel({
    resolvedPath: path.join(winner, 'codex'),
    npmGlobalRoot: npmRoot,
    npmPackageDir: path.join(npmRoot, '@openai/codex')
  });

  assert.equal(result.shadowedNpmInstall, false);
  assert.ok(!result.evidence.includes('npm_install_shadowed'));
});

// aih 给 codex 写的是 shell 垫片而非符号链接，realpath 追不进 exec。
test('带 aih 标记的 shell 垫片能被解析到真正的上游二进制', (t) => {
  const root = makeTree(t);
  const releaseDir = path.join(root, '.codex/packages/standalone/releases/0.153.4-arm64/bin');
  fs.mkdirSync(releaseDir, { recursive: true });
  const upstream = path.join(releaseDir, 'codex');
  fs.writeFileSync(upstream, '#!/bin/sh\n');
  const shimDir = path.join(root, '.local/bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, 'codex');
  fs.writeFileSync(shim, `#!/bin/sh\n# aih-codex-cli-hook-alias\nexec '${upstream}' "$@"\n`);

  const result = detectCliChannel({
    resolvedPath: shim,
    standaloneRoots: [path.join(root, '.codex/packages/standalone/releases')]
  });

  assert.equal(result.channel, CHANNELS.STANDALONE_RELEASE);
  assert.ok(result.evidence.includes('resolved_through_aih_shim'));
});

// 没有 aih 标记的普通脚本一律不解析，避免把用户自己的 wrapper 当成我们的。
test('无 aih 标记的脚本不被解析', (t) => {
  const root = makeTree(t);
  const dir = path.join(root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'other');
  fs.writeFileSync(target, '#!/bin/sh\n');
  const script = path.join(dir, 'codex');
  fs.writeFileSync(script, `#!/bin/sh\nexec '${target}' "$@"\n`);

  const result = detectCliChannel({ resolvedPath: script, standaloneRoots: [] });
  assert.ok(!result.evidence.includes('resolved_through_aih_shim'));
});

// ---------------------------------------------------------------------------
// Windows 形状的路径不能用真实文件系统造（macOS 上反斜杠不是分隔符），所以这一组
// 用注入的 path.win32 + 假 fs。fixture 直接照抄 2026-09-14 真机侦察的输出：
//   codex   d:\nvm4w\nodejs\codex.cmd → C:\Users\madou\AppData\Local\nvm\v22.23.1\codex.cmd
//   gemini  C:\Users\madou\AppData\Local\pnpm\gemini.cmd
//   qoder   C:\Program Files\Qoder\bin\qoder.cmd
//   npm root -g = d:\nvm4w\nodejs\node_modules

const NVM_LINK = 'd:\\nvm4w\\nodejs';
const NVM_REAL = 'C:\\Users\\madou\\AppData\\Local\\nvm\\v22.23.1';

// npm 生成的 .cmd 垫片原文。注意 `IF EXIST "%dp0%\node.exe"` 这一行也长得很像目标，
// 判据必须只认含 node_modules 的那一段，否则会把 node.exe 当成 CLI 本体。
function npmCmdShim(relativeTarget) {
  return [
    '@ECHO off',
    'SET dp0=%~dp0',
    ':start',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeTarget}" %*`
  ].join('\r\n');
}

// 只实现 detectCliChannel 真正会用到的四个方法；realpath 用前缀替换模拟 nvm4w 的目录链接。
function winFs({ files = {}, dirs = [], links = {} } = {}) {
  const fileMap = new Map(Object.entries(files));
  const dirSet = new Set(dirs);
  const realpath = (target) => {
    for (const [from, to] of Object.entries(links)) {
      if (target === from) return to;
      if (target.toLowerCase().startsWith(`${from.toLowerCase()}\\`)) return to + target.slice(from.length);
    }
    return target;
  };
  const missing = (target) => {
    const error = new Error(`ENOENT: ${target}`);
    error.code = 'ENOENT';
    return error;
  };
  return {
    realpathSync: (target) => realpath(target),
    existsSync: (target) => fileMap.has(realpath(target)) || dirSet.has(realpath(target)),
    statSync: (target) => {
      const real = realpath(target);
      if (fileMap.has(real)) return { isFile: () => true, size: fileMap.get(real).length };
      if (dirSet.has(real)) return { isFile: () => false, size: 0 };
      throw missing(target);
    },
    readFileSync: (target) => {
      const real = realpath(target);
      if (fileMap.has(real)) return fileMap.get(real);
      throw missing(target);
    }
  };
}

// 这条是整个 Windows 闭环的总开关：判不出 npm_global → pinnable false →
// upgrade-policy 直接 channel_not_pinnable，真机上一次 apply 都不会发生。
test('Windows: npm 全局垫片解析到 node_modules,判定为 npm_global', () => {
  const target = `${NVM_REAL}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const result = detectCliChannel({
    path: path.win32,
    fs: winFs({
      links: { [NVM_LINK]: NVM_REAL },
      files: {
        [`${NVM_REAL}\\codex.cmd`]: npmCmdShim('node_modules\\@openai\\codex\\bin\\codex.js'),
        [target]: '#!/usr/bin/env node\n'
      },
      dirs: [`${NVM_REAL}\\node_modules`, `${NVM_REAL}\\node_modules\\@openai\\codex`]
    }),
    resolvedPath: `${NVM_LINK}\\codex.cmd`,
    npmGlobalRoot: `${NVM_LINK}\\node_modules`,
    npmPackageDir: `${NVM_LINK}\\node_modules\\@openai\\codex`
  });

  assert.equal(result.channel, CHANNELS.NPM_GLOBAL);
  assert.equal(result.pinnable, true);
  assert.equal(result.ownerPath, target);
  assert.ok(result.evidence.includes('resolved_through_npm_cmd_shim'));
  // 修之前这里是 true：垫片落在 prefix 根而不是 node_modules 里，于是每个 npm 装的
  // CLI 都被误报成影子安装。渠道判对之后这个误报是结构性消失的，不是被短路掉的。
  assert.equal(result.shadowedNpmInstall, false);
});

// 覆盖率换正确性：解析垫片不等于认领垫片。pnpm 的全局垫片同样指向某个 node_modules，
// 但那不是 `npm root -g` 给的根，用 npm i -g 去升它只会在另一个前缀再造一份。
test('Windows: pnpm 垫片即便指向 node_modules 也不算 npm 渠道,且如实报影子安装', () => {
  const pnpmDir = 'C:\\Users\\madou\\AppData\\Local\\pnpm';
  const pnpmTarget = `${pnpmDir}\\global\\5\\node_modules\\@google\\gemini-cli\\dist\\index.js`;
  const result = detectCliChannel({
    path: path.win32,
    fs: winFs({
      links: { [NVM_LINK]: NVM_REAL },
      files: {
        [`${pnpmDir}\\gemini.cmd`]: npmCmdShim('global\\5\\node_modules\\@google\\gemini-cli\\dist\\index.js'),
        [pnpmTarget]: ''
      },
      // npm 全局里**也**装着这个包，但真正会被启动的是 pnpm 那份 —— 这正是
      // shadowedNpmInstall 存在的理由，是真阳性，不能被这次修复一起抹掉。
      dirs: [`${NVM_REAL}\\node_modules`, `${NVM_REAL}\\node_modules\\@google\\gemini-cli`]
    }),
    resolvedPath: `${pnpmDir}\\gemini.cmd`,
    npmGlobalRoot: `${NVM_LINK}\\node_modules`,
    npmPackageDir: `${NVM_LINK}\\node_modules\\@google\\gemini-cli`
  });

  assert.equal(result.channel, CHANNELS.UNKNOWN);
  assert.equal(result.pinnable, false);
  assert.equal(result.shadowedNpmInstall, true);
});

test('Windows: 非 npm 垫片（Program Files 下的启动器）仍判不出渠道', () => {
  const qoderDir = 'C:\\Program Files\\Qoder\\bin';
  const result = detectCliChannel({
    path: path.win32,
    fs: winFs({
      files: { [`${qoderDir}\\qoder.cmd`]: '@echo off\r\n"%~dp0\\..\\Qoder.exe" %*\r\n' }
    }),
    resolvedPath: `${qoderDir}\\qoder.cmd`,
    npmGlobalRoot: `${NVM_REAL}\\node_modules`
  });

  assert.equal(result.channel, CHANNELS.UNKNOWN);
  assert.ok(result.evidence.includes('no_known_root_matched'));
  assert.ok(!result.evidence.includes('resolved_through_npm_cmd_shim'));
});

// 垫片写着的目标不存在（包被卸载、目录被搬走）时不能硬跟：认不出渠道是安全的一侧。
test('Windows: 垫片目标不存在时不跟随', () => {
  const result = detectCliChannel({
    path: path.win32,
    fs: winFs({
      files: { [`${NVM_REAL}\\kimi.cmd`]: npmCmdShim('node_modules\\@moonshot-ai\\kimi-code\\bin\\kimi.js') },
      dirs: [`${NVM_REAL}\\node_modules`]
    }),
    resolvedPath: `${NVM_REAL}\\kimi.cmd`,
    npmGlobalRoot: `${NVM_REAL}\\node_modules`
  });

  assert.equal(result.channel, CHANNELS.UNKNOWN);
  assert.equal(result.ownerPath, `${NVM_REAL}\\kimi.cmd`);
});
