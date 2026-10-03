'use strict';

const {
  buildBrewPlan,
  buildWingetPlan,
  createLifecyclePlan,
  shellQuote
} = require('../plan-builders');
const { PLATFORM_IDS, parameters } = require('../parameters');
const { detectCommandRuntime } = require('../probe');
const { buildProfileAwareCleanupPlan, resolveHome } = require('../platforms/shared');
const { appendProfileLinesSnippet } = require('./shell-snippets');

const GO_PROFILE_MARKER = '# aih-go';
const GOENV_REPOSITORY = 'https://github.com/go-nv/goenv.git';

function parseGoVersion(output) {
  const match = String(output || '').match(/\bgo(\d+\.\d+(?:\.\d+)?[\w.-]*)/);
  return match ? match[1] : String(output || '').trim().split(/\r?\n/)[0] || '';
}

function listGoenvVersions({ path, home, listDirectories }) {
  return home ? listDirectories(path.join(home, '.goenv', 'versions')) : [];
}

const TOOLS = Object.freeze([
  Object.freeze({
    id: 'go',
    name: 'Go',
    runtime: 'go',
    category: 'runtime',
    description: 'Go 官方工具链',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({
      command: 'go',
      args: Object.freeze(['version']),
      knownPaths: Object.freeze(['.local/go/bin/go', '/usr/local/go/bin/go', 'C:\\Program Files\\Go\\bin\\go.exe']),
      parseVersion: parseGoVersion
    }),
    tasks: Object.freeze([
      { id: 'install-package', label: '安装命令行工具', template: 'go install {{package}}@latest', category: 'install', parameters: parameters('package') },
      { id: 'add-package', label: '添加项目依赖', template: 'go get {{package}}', category: 'use', parameters: parameters('package') },
      { id: 'tidy', label: '整理依赖', template: 'go mod tidy', category: 'use', parameters: [] },
      { id: 'run-script', label: '运行程序', template: 'go run {{script}}', category: 'use', parameters: parameters('script') },
      { id: 'env', label: '查看 Go 环境', template: 'go env', category: 'inspect', parameters: [] }
    ])
  }),
  Object.freeze({
    id: 'goenv',
    name: 'goenv',
    runtime: 'go',
    category: 'version-manager',
    description: 'Go 多版本管理',
    platforms: Object.freeze(['macos', 'linux']),
    probe: Object.freeze({
      command: 'goenv',
      args: Object.freeze(['--version']),
      knownPaths: Object.freeze(['.goenv/bin/goenv']),
      listVersions: listGoenvVersions
    }),
    tasks: Object.freeze([
      { id: 'install-version', label: '安装 Go 版本', template: 'goenv install {{version}}', category: 'install', parameters: parameters('version') },
      { id: 'global-version', label: '设置全局版本', template: 'goenv global {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'local-version', label: '设置当前项目版本', template: 'goenv local {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'list-versions', label: '查看已安装版本', template: 'goenv versions', category: 'inspect', parameters: [] },
      { id: 'remove-version', label: '卸载 Go 版本', template: 'goenv uninstall -f {{version}}', category: 'uninstall', parameters: parameters('version') }
    ])
  })
]);

/**
 * 用户级 Go 安装：下载 go.dev 最新稳定版，按官方 .sha256 校验后解压到 ~/.local/go，
 * 并在 Shell 配置追加带标记的 PATH 行（卸载时按标记撤销）。无需 sudo。
 */
function buildGoTarballPlan(action, options) {
  const home = resolveHome(options);
  const goOs = options.platform === 'macos' ? 'darwin' : 'linux';
  const script = [
    'set -euo pipefail',
    'arch="$(uname -m)"',
    'case "$arch" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "不支持的 CPU 架构: $arch" >&2; exit 64 ;; esac',
    'raw="$(curl -fsSL \'https://go.dev/VERSION?m=text\')"',
    'version="$(printf \'%s\\n\' "$raw" | sed -n 1p)"',
    'case "$version" in go[0-9]*) ;; *) echo "无法解析 Go 最新版本" >&2; exit 65 ;; esac',
    `file="$version.${goOs}-$arch.tar.gz"`,
    'tmp="$(mktemp -d "${TMPDIR:-/tmp}/aih-go.XXXXXX")"',
    'trap \'rm -rf "$tmp"\' EXIT',
    'curl -fsSL "https://dl.google.com/go/$file" -o "$tmp/$file"',
    'expected="$(curl -fsSL "https://dl.google.com/go/$file.sha256" | tr -d \'[:space:]\')"',
    'if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$file" | cut -d\' \' -f1)"; else actual="$(shasum -a 256 "$tmp/$file" | cut -d\' \' -f1)"; fi',
    '[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Go 安装包 SHA-256 校验失败" >&2; exit 66; }',
    `mkdir -p ${shellQuote(`${home}/.local`)}`,
    `rm -rf ${shellQuote(`${home}/.local/go`)}`,
    `tar -C ${shellQuote(`${home}/.local`)} -xzf "$tmp/$file"`,
    ...appendProfileLinesSnippet(home, GO_PROFILE_MARKER, [
      `export PATH="$HOME/.local/go/bin:$HOME/go/bin:$PATH" ${GO_PROFILE_MARKER}`
    ])
  ].join('\n');
  return createLifecyclePlan('go', action, 'bash', ['-c', script], {
    id: `go_${action}_official_tarball`,
    label: `${action === 'update' ? '更新' : '安装'} Go（官方发布包）`,
    method: 'go.dev 官方发布包',
    effect: `${action === 'update' ? '覆盖更新' : '安装'} Go 到 ~/.local/go，并在 Shell 配置追加 PATH`
  });
}

function buildGoCleanupPlan(options) {
  return buildProfileAwareCleanupPlan('go', 'Go', [GO_PROFILE_MARKER], { trees: ['.local/go'] }, options);
}

function resolveGoPlans(action, options) {
  if (options.platform === 'windows') return [buildWingetPlan('go', action, 'GoLang.Go', { name: 'Go' })];
  const brew = options.platform === 'macos' ? [buildBrewPlan('go', action, 'go', { name: 'Go' })] : [];
  if (action === 'uninstall') return [...brew, buildGoCleanupPlan(options)];
  return [...brew, buildGoTarballPlan(action, options)];
}

function buildGoenvGitPlan(action, options) {
  const home = resolveHome(options);
  const root = `${home}/.goenv`;
  const script = [
    'set -euo pipefail',
    `root=${shellQuote(root)}`,
    `if [ -d "$root/.git" ]; then git -C "$root" pull --ff-only; else git clone --depth 1 ${shellQuote(GOENV_REPOSITORY)} "$root"; fi`,
    ...appendProfileLinesSnippet(home, 'GOENV_ROOT', [
      'export GOENV_ROOT="$HOME/.goenv"',
      'export PATH="$GOENV_ROOT/bin:$PATH"',
      'eval "$(goenv init -)"'
    ])
  ].join('\n');
  return createLifecyclePlan('goenv', action, 'bash', ['-c', script], {
    id: `goenv_${action}_git`,
    label: `${action === 'update' ? '更新' : '安装'} goenv`,
    method: 'Git',
    effect: `${action === 'update' ? '拉取' : '克隆'} goenv 到 ~/.goenv，并写入 Shell 初始化`
  });
}

function resolveGoenvPlans(action, options) {
  const brew = options.platform === 'macos' ? [buildBrewPlan('goenv', action, 'goenv', { name: 'goenv' })] : [];
  if (action === 'uninstall') {
    return [
      ...brew,
      buildProfileAwareCleanupPlan('goenv', 'goenv', ['GOENV_ROOT', 'goenv init'], { trees: ['.goenv'] }, options)
    ];
  }
  return [...brew, buildGoenvGitPlan(action, options)];
}

function resolveGoToolPlans(toolId, action, options = {}) {
  if (toolId === 'go') return resolveGoPlans(action, options);
  if (toolId === 'goenv') return resolveGoenvPlans(action, options);
  return [];
}

function detectGoRuntime(options = {}) {
  return detectCommandRuntime({
    id: 'go',
    name: 'Go',
    command: 'go',
    args: ['version'],
    knownPaths: ['.local/go/bin/go', '/usr/local/go/bin/go', 'C:\\Program Files\\Go\\bin\\go.exe'],
    parseVersion: parseGoVersion
  }, options);
}

module.exports = Object.freeze({
  id: 'go',
  name: 'Go',
  icon: 'go',
  tools: TOOLS,
  detectRuntime: detectGoRuntime,
  resolvePlans: resolveGoToolPlans
});
