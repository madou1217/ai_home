'use strict';

/**
 * shell 集成片段的**唯一生成处**：按 shell 选 zsh / bash 实现，并决定写进哪个 rc 文件。
 *
 * 为什么 rc 目标要在这里收口：macOS 上 Terminal 默认起登录 shell（读 ~/.zprofile /
 * ~/.bash_profile），Linux 上读 ~/.bashrc——写错文件的表现是「命令执行了但补全没生效」，
 * 只能靠用户自己排查。所以目标文件由这里按平台 + 现有文件推断，`aih shell status` 会打印出来。
 */

const nodePath = require('node:path');
const nodeOs = require('node:os');
const { buildZshSnippet } = require('./snippet-zsh');
const { buildBashSnippet } = require('./snippet-bash');
const { buildFishSnippet } = require('./snippet-fish');
const { buildPowerShellSnippet } = require('./snippet-powershell');

const SHELL_BLOCK_NAME = 'shell';
const SHELL_BLOCK_PREFIX = 'aih';
const SUPPORTED_SHELLS = Object.freeze(['zsh', 'bash', 'fish', 'powershell']);

/** `$SHELL` 的 basename → 我们支持的 shell 名。 */
const SHELL_ALIASES = Object.freeze({
  zsh: 'zsh',
  bash: 'bash',
  fish: 'fish',
  pwsh: 'powershell',
  powershell: 'powershell'
});

/**
 * 父进程名（POSIX：`ps -o comm= -p <ppid>`）。
 * 为什么要看父进程：`aih shell apply` 常常在「登录 shell 与当前 shell 不是同一个」的
 * 情况下执行（例：登录 shell 是 zsh，但用户在 pwsh / fish 里敲命令），只看 `$SHELL`
 * 会把片段写进错误的 rc。父进程不是已知 shell（脚本、agent 等）时返回空串。
 */
function detectParentShell(options = {}) {
  const processObj = options.processObj || process;
  const platform = String(options.platform || process.platform);
  if (platform === 'win32') return '';
  const spawnSync = options.spawnSync || require('node:child_process').spawnSync;
  try {
    const result = spawnSync('ps', ['-o', 'comm=', '-p', String(processObj.ppid || 0)], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    });
    const name = String((result && result.stdout) || '').trim().split('/').pop().toLowerCase();
    return SHELL_ALIASES[name] || '';
  } catch (_error) {
    return '';
  }
}

/**
 * 从「当前进程所在环境」推 shell：显式 → 父进程 → PowerShell 标记 → `$SHELL`。
 * `PSModulePath` 是 PowerShell 自己导出给子进程的，所以「在 pwsh 里跑」这件事能可靠识别。
 */
function detectShell(options = {}) {
  const env = options.env || process.env;
  const explicit = String(options.shell || '').trim().toLowerCase();
  if (explicit) return SHELL_ALIASES[explicit] || '';
  const fromParent = detectParentShell(options);
  if (fromParent) return fromParent;
  if (String(env.PSModulePath || '').trim()) return 'powershell';
  const fromEnv = String(env.SHELL || '').trim();
  const base = nodePath.basename(fromEnv).toLowerCase().replace(/\.exe$/, '');
  return SHELL_ALIASES[base] || '';
}

/**
 * 目标 rc 文件。
 * zsh：优先 `$ZDOTDIR/.zshrc`，否则 `~/.zshrc`。
 * bash：优先已存在的 `~/.bashrc`；macOS 上登录 shell 读 `~/.bash_profile`，
 *       因此若 `.bashrc` 不存在而 `.bash_profile` 存在，就写后者。
 * fish：`$XDG_CONFIG_HOME/fish/config.fish`（默认 `~/.config/fish/config.fish`）。
 * powershell：Windows 是 `Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1`（PS7）
 *       或 `Documents\\WindowsPowerShell\\...`（5.1）；类 Unix 是
 *       `~/.config/powershell/Microsoft.PowerShell_profile.ps1`。
 */
function resolveRcFile(shell, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const env = options.env || process.env;
  const platform = String(options.platform || process.platform);
  const homeDir = String(options.homeDir || nodeOs.homedir());
  const exists = (file) => {
    try {
      return fsImpl.existsSync(file);
    } catch (_error) {
      return false;
    }
  };
  if (shell === 'zsh') {
    const zdotdir = String(env.ZDOTDIR || '').trim();
    return nodePath.join(zdotdir || homeDir, '.zshrc');
  }
  if (shell === 'bash') {
    const bashrc = nodePath.join(homeDir, '.bashrc');
    const profile = nodePath.join(homeDir, '.bash_profile');
    if (exists(bashrc)) return bashrc;
    if (exists(profile)) return profile;
    return bashrc;
  }
  if (shell === 'fish') {
    const configHome = String(env.XDG_CONFIG_HOME || '').trim() || nodePath.join(homeDir, '.config');
    return nodePath.join(configHome, 'fish', 'config.fish');
  }
  if (shell === 'powershell') {
    if (platform === 'win32') {
      const documents = nodePath.join(homeDir, 'Documents');
      const ps7 = nodePath.join(documents, 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      const ps5 = nodePath.join(documents, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      if (exists(ps7)) return ps7;
      if (exists(ps5)) return ps5;
      return ps7;
    }
    const configHome = String(env.XDG_CONFIG_HOME || '').trim() || nodePath.join(homeDir, '.config');
    return nodePath.join(configHome, 'powershell', 'Microsoft.PowerShell_profile.ps1');
  }
  return '';
}

function buildSnippet(shell, options = {}) {
  if (shell === 'zsh') return buildZshSnippet(options);
  if (shell === 'bash') return buildBashSnippet(options);
  if (shell === 'fish') return buildFishSnippet(options);
  if (shell === 'powershell') return buildPowerShellSnippet(options);
  return '';
}

/** 片段里需要落盘的“生成参数”，用于 `status` 判断当前文件是不是最新。 */
function normalizeSnippetOptions(options = {}) {
  return {
    aihBinPath: String(options.aihBinPath || 'aih'),
    completion: options.completion !== false,
    typo: options.typo !== false,
    wrapper: options.wrapper !== false,
    historyTail: Math.max(200, Number(options.historyTail) || 1000)
  };
}

module.exports = {
  SHELL_ALIASES,
  SHELL_BLOCK_NAME,
  SHELL_BLOCK_PREFIX,
  SUPPORTED_SHELLS,
  buildSnippet,
  detectParentShell,
  detectShell,
  normalizeSnippetOptions,
  resolveRcFile
};
