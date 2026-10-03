'use strict';

const {
  buildBrewPlan,
  buildCommandPlan,
  buildPowerShellScriptPlan,
  buildShellScriptPlan,
  buildWingetPlan,
  createLifecyclePlan
} = require('../plan-builders');
const { PLATFORM_IDS, parameters } = require('../parameters');
const { detectCommandRuntime } = require('../probe');
const { buildHomeCleanupPlan, resolveHome, resolvePath } = require('../platforms/shared');
const { resolveBinarySnippet } = require('./shell-snippets');

const SEMVER_PATTERN = /(\d+\.\d+\.\d+[\w.-]*)/;

function parseSemver(output) {
  const match = String(output || '').match(SEMVER_PATTERN);
  return match ? match[1] : String(output || '').trim().split(/\r?\n/)[0] || '';
}

const RUSTUP_INSTALLER = Object.freeze({ url: 'https://sh.rustup.rs', hosts: ['sh.rustup.rs'] });
const BINSTALL_INSTALLERS = Object.freeze({
  posix: Object.freeze({
    url: 'https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh',
    hosts: ['raw.githubusercontent.com']
  }),
  windows: Object.freeze({
    url: 'https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.ps1',
    hosts: ['raw.githubusercontent.com']
  })
});

function listRustupToolchains({ execCommand, executablePath }) {
  const result = execCommand(executablePath || 'rustup', ['toolchain', 'list']);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/)
    .map((line) => line.replace(/\s*\((?:default|active|override)[^)]*\)\s*/g, ' ').trim())
    .filter(Boolean);
}

const TOOLS = Object.freeze([
  Object.freeze({
    id: 'rustup',
    name: 'rustup',
    runtime: 'rust',
    category: 'version-manager',
    description: 'Rust 工具链安装与多版本管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({
      command: 'rustup',
      args: Object.freeze(['--version']),
      knownPaths: Object.freeze(['.cargo/bin/rustup']),
      parseVersion: parseSemver,
      listVersions: listRustupToolchains
    }),
    tasks: Object.freeze([
      { id: 'install-toolchain', label: '安装工具链', template: 'rustup toolchain install {{version}}', category: 'install', parameters: parameters('version') },
      { id: 'default-toolchain', label: '设置默认工具链', template: 'rustup default {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'override-toolchain', label: '设置当前项目工具链', template: 'rustup override set {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'list-toolchains', label: '查看已安装工具链', template: 'rustup toolchain list', category: 'inspect', parameters: [] },
      { id: 'remove-toolchain', label: '卸载工具链', template: 'rustup toolchain uninstall {{version}}', category: 'uninstall', parameters: parameters('version') }
    ])
  }),
  Object.freeze({
    id: 'cargo-binstall',
    name: 'cargo-binstall',
    runtime: 'rust',
    category: 'package-manager',
    description: '直接安装 Rust 预编译二进制',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({
      command: 'cargo-binstall',
      args: Object.freeze(['-V']),
      knownPaths: Object.freeze(['.cargo/bin/cargo-binstall']),
      parseVersion: parseSemver
    }),
    tasks: Object.freeze([
      { id: 'install-package', label: '安装二进制包', template: 'cargo binstall -y {{package}}', category: 'install', parameters: parameters('package') },
      { id: 'add-package', label: '添加项目依赖', template: 'cargo add {{package}}', category: 'use', parameters: parameters('package') },
      { id: 'run-project', label: '运行项目', template: 'cargo run', category: 'use', parameters: [] },
      { id: 'remove-package', label: '卸载二进制包', template: 'cargo uninstall {{package}}', category: 'uninstall', parameters: parameters('package') }
    ])
  })
]);

function rustupPosixScriptPlan(action, args, options, meta) {
  const home = resolveHome(options);
  const script = [
    'set -euo pipefail',
    ...resolveBinarySnippet('rustup_bin', `${home}/.cargo/bin/rustup`, 'rustup'),
    `"$rustup_bin" ${args}`
  ].join('\n');
  return createLifecyclePlan('rustup', action, 'bash', ['-c', script], meta);
}

function rustupWindowsExe(options) {
  return resolvePath(options, 'windows').join(resolveHome(options), '.cargo', 'bin', 'rustup.exe');
}

const UPDATE_META = Object.freeze({
  id: 'rustup_update_toolchains',
  label: '更新 rustup 与工具链',
  method: 'rustup',
  effect: '更新 rustup 自身及已安装的 Rust 工具链'
});

const UNINSTALL_META = Object.freeze({
  id: 'rustup_self_uninstall',
  label: '卸载 rustup',
  method: '内置卸载器',
  effect: '移除 ~/.rustup 与 ~/.cargo（含 cargo install 安装的程序）并撤销 PATH 配置'
});

function resolveRustupPlans(action, options) {
  if (options.platform === 'windows') {
    if (action === 'install') return [buildWingetPlan('rustup', action, 'Rustlang.Rustup', { name: 'rustup' })];
    if (action === 'update') {
      return [
        buildCommandPlan('rustup', 'update', rustupWindowsExe(options), ['update'], UPDATE_META),
        buildWingetPlan('rustup', action, 'Rustlang.Rustup', { name: 'rustup' })
      ];
    }
    return [
      buildCommandPlan('rustup', 'uninstall', rustupWindowsExe(options), ['self', 'uninstall', '-y'], UNINSTALL_META),
      buildWingetPlan('rustup', action, 'Rustlang.Rustup', { name: 'rustup' })
    ];
  }
  if (action === 'install') {
    const effect = options.platform === 'macos'
      ? '安装 rustup 与 stable 工具链到 ~/.cargo；若已有 Homebrew rust，两套工具链并存，由 PATH 顺序决定生效版本'
      : '安装 rustup 与 stable 工具链到 ~/.cargo';
    return [buildShellScriptPlan('rustup', action, {
      ...RUSTUP_INSTALLER,
      label: '安装 rustup',
      method: 'rustup 官方安装器',
      scriptArgs: ['-y'],
      options: { effect }
    })];
  }
  if (action === 'update') return [rustupPosixScriptPlan('update', 'update', options, UPDATE_META)];
  return [rustupPosixScriptPlan('uninstall', 'self uninstall -y', options, UNINSTALL_META)];
}

function binstallScriptPlan(action, options) {
  const label = `${action === 'update' ? '更新' : '安装'} cargo-binstall`;
  if (options.platform === 'windows') {
    return buildPowerShellScriptPlan('cargo-binstall', action, {
      ...BINSTALL_INSTALLERS.windows,
      label,
      method: '官方安装器',
      options: { processObj: options.processObj }
    });
  }
  return buildShellScriptPlan('cargo-binstall', action, {
    ...BINSTALL_INSTALLERS.posix,
    label,
    method: '官方安装器'
  });
}

function resolveBinstallPlans(action, options) {
  const brew = options.platform === 'macos'
    ? [buildBrewPlan('cargo-binstall', action, 'cargo-binstall', { name: 'cargo-binstall' })]
    : [];
  if (action === 'uninstall') {
    return [
      ...brew,
      buildCommandPlan('cargo-binstall', 'uninstall', options.platform === 'windows' ? 'cargo.exe' : 'cargo', ['uninstall', 'cargo-binstall'], {
        id: 'cargo-binstall_uninstall_cargo',
        label: 'cargo 卸载 cargo-binstall',
        method: 'cargo',
        effect: '通过 cargo 安装记录移除 cargo-binstall'
      }),
      buildHomeCleanupPlan('cargo-binstall', 'cargo-binstall', options, {
        files: [options.platform === 'windows' ? '.cargo/bin/cargo-binstall.exe' : '.cargo/bin/cargo-binstall']
      })
    ];
  }
  return [...brew, binstallScriptPlan(action, options)];
}

function resolveRustPlans(toolId, action, options = {}) {
  if (toolId === 'rustup') return resolveRustupPlans(action, options);
  if (toolId === 'cargo-binstall') return resolveBinstallPlans(action, options);
  return [];
}

function detectRustRuntime(options = {}) {
  return detectCommandRuntime({
    id: 'rust',
    name: 'Rust',
    command: 'rustc',
    args: ['--version'],
    knownPaths: ['.cargo/bin/rustc'],
    parseVersion: parseSemver,
    packageManager: {
      command: 'cargo',
      args: ['--version'],
      knownPaths: ['.cargo/bin/cargo'],
      parseVersion: parseSemver
    }
  }, options);
}

module.exports = Object.freeze({
  id: 'rust',
  name: 'Rust',
  icon: 'rust',
  tools: TOOLS,
  detectRuntime: detectRustRuntime,
  resolvePlans: resolveRustPlans
});
