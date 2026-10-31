'use strict';

// Git（系统级开发工具）：远程工作区的检查点 / 撤销依赖它，远端没有时由 toolkit 安装。
//
// 安装方式按平台（计划是回退链，前一个失败自动试下一个）：
//   - Linux：系统包管理器，执行时识别 apt-get / dnf / yum / apk / pacman / zypper；
//            root 直接装，非 root 用 `sudo -n`（免密 sudo）；没有免密 sudo 时当场失败并说明原因，
//            不在后台卡住等密码。
//   - macOS：Homebrew（有 brew 时）→ Xcode 命令行工具（softwareupdate 无界面安装，需要免密 sudo）。
//            不用 `xcode-select --install`：它弹图形对话框，SSH 会话里没人点。
//   - Windows：WinGet（Git.Git）。
//
// 不提供卸载：Git 常被系统其他组件依赖（发行版的包、Xcode 工具链），由 toolkit 卸掉风险大于收益。

const { buildBrewPlan, buildWingetPlan, createLifecyclePlan } = require('../plan-builders');
const { PLATFORM_IDS } = require('../parameters');
const { detectCommandRuntime, detectCommandRuntimeAsync } = require('../probe');

function parseGitVersion(output) {
  const match = String(output || '').match(/git version (\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : String(output || '').trim().split(/\r?\n/)[0] || '';
}

// 安装后当前会话的 PATH 不会刷新（尤其 Windows），按已知位置兜底探测。
const GIT_KNOWN_PATHS = Object.freeze([
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  'C:\\Program Files\\Git\\cmd\\git.exe'
]);

const TOOLS = Object.freeze([
  Object.freeze({
    id: 'git',
    name: 'Git',
    runtime: 'git',
    category: 'version-control',
    description: '版本控制（远程工作区的检查点与撤销依赖它）',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({
      command: 'git',
      args: Object.freeze(['--version']),
      knownPaths: GIT_KNOWN_PATHS,
      parseVersion: parseGitVersion
    }),
    tasks: Object.freeze([
      { id: 'status', label: '查看工作区状态', template: 'git status', category: 'inspect', parameters: [] },
      { id: 'log', label: '查看最近提交', template: 'git log --oneline -20', category: 'inspect', parameters: [] }
    ])
  })
]);

// 以 root 或免密 sudo 执行；两者都没有时退出码 77 并给出可操作的说明。
const SUDO_SNIPPET = [
  'if [ "$(id -u)" -eq 0 ]; then SUDO=""',
  'elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO="sudo -n"',
  'else echo "需要 root 或免密 sudo 才能用系统包管理器安装 Git（可在远端执行：sudo visudo 为该用户开启 NOPASSWD，或手动安装 Git）" >&2; exit 77',
  'fi'
];

const LINUX_COMMANDS = Object.freeze({
  install: [
    ['apt-get', '$SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -q && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q git'],
    ['dnf', '$SUDO dnf install -y git'],
    ['yum', '$SUDO yum install -y git'],
    ['apk', '$SUDO apk add --no-cache git'],
    ['pacman', '$SUDO pacman -Sy --noconfirm git'],
    ['zypper', '$SUDO zypper --non-interactive install git']
  ],
  update: [
    ['apt-get', '$SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -q && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --only-upgrade git'],
    ['dnf', '$SUDO dnf upgrade -y git'],
    ['yum', '$SUDO yum update -y git'],
    ['apk', '$SUDO apk upgrade --no-cache git'],
    ['pacman', '$SUDO pacman -Sy --noconfirm git'],
    ['zypper', '$SUDO zypper --non-interactive update git']
  ]
});

function buildLinuxPackagePlan(action) {
  const branches = LINUX_COMMANDS[action]
    .map(([manager, command], index) => `${index === 0 ? 'if' : 'elif'} command -v ${manager} >/dev/null 2>&1; then echo "使用 ${manager}" >&2; ${command}`)
    .join('\n');
  const script = [
    'set -eu',
    ...SUDO_SNIPPET,
    branches,
    'else echo "未识别的包管理器（支持 apt-get / dnf / yum / apk / pacman / zypper）" >&2; exit 78',
    'fi'
  ].join('\n');
  const verb = action === 'update' ? '更新' : '安装';
  return createLifecyclePlan('git', action, 'sh', ['-c', script], {
    id: `git_${action}_system_package`,
    label: `系统包管理器${verb} Git`,
    method: '系统包管理器（apt / dnf / yum / apk / pacman / zypper）',
    effect: `用发行版的包管理器${verb} Git（需要 root 或免密 sudo）`
  });
}

function buildMacCommandLineToolsPlan(action) {
  // softwareupdate 只在存在这个标记文件时才列出命令行工具（Apple 官方的按需安装机制）。
  const script = [
    'set -eu',
    ...SUDO_SNIPPET,
    'marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress',
    'touch "$marker"',
    'trap \'rm -f "$marker"\' EXIT',
    'label="$(softwareupdate -l 2>/dev/null | sed -n \'s/^[[:space:]]*\\* Label: //p\' | grep -i \'Command Line Tools\' | sort -V | tail -n 1)"',
    '[ -n "$label" ] || { echo "softwareupdate 没有提供命令行工具（可能已是最新，或需要在本机图形界面执行 xcode-select --install）" >&2; exit 79; }',
    'echo "安装 $label" >&2',
    '$SUDO softwareupdate -i "$label" --verbose'
  ].join('\n');
  const verb = action === 'update' ? '更新' : '安装';
  return createLifecyclePlan('git', action, 'sh', ['-c', script], {
    id: `git_${action}_xcode_clt`,
    label: `${verb} Xcode 命令行工具（含 Git）`,
    method: 'softwareupdate',
    effect: `无界面${verb} Apple 命令行工具（包含 Git，约 700MB，需要免密 sudo）`,
    timeoutMs: 60 * 60 * 1000
  });
}

function resolveGitPlans(toolId, action, options = {}) {
  if (toolId !== 'git' || action === 'uninstall') return [];
  if (options.platform === 'windows') return [buildWingetPlan('git', action, 'Git.Git', { name: 'Git' })];
  if (options.platform === 'macos') {
    return [buildBrewPlan('git', action, 'git', { name: 'Git' }), buildMacCommandLineToolsPlan(action)];
  }
  return [buildLinuxPackagePlan(action)];
}

const GIT_RUNTIME_SPEC = Object.freeze({
  id: 'git',
  name: 'Git',
  command: 'git',
  args: Object.freeze(['--version']),
  knownPaths: GIT_KNOWN_PATHS,
  parseVersion: parseGitVersion
});

module.exports = Object.freeze({
  id: 'git',
  name: 'Git',
  icon: 'git',
  tools: TOOLS,
  knownPaths: GIT_KNOWN_PATHS,
  detectRuntime: (options) => detectCommandRuntime(GIT_RUNTIME_SPEC, options),
  detectRuntimeAsync: (options) => detectCommandRuntimeAsync(GIT_RUNTIME_SPEC, options),
  resolvePlans: resolveGitPlans,
  parseGitVersion
});
