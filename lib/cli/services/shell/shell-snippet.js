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

const SHELL_BLOCK_NAME = 'shell';
const SHELL_BLOCK_PREFIX = 'aih';
const SUPPORTED_SHELLS = Object.freeze(['zsh', 'bash']);

/** 从 `$SHELL` 推当前 shell；认不出返回空串（调用方应要求显式 --shell）。 */
function detectShell(options = {}) {
  const env = options.env || process.env;
  const explicit = String(options.shell || '').trim().toLowerCase();
  if (explicit) return SUPPORTED_SHELLS.includes(explicit) ? explicit : '';
  const fromEnv = String(env.SHELL || '').trim();
  const base = nodePath.basename(fromEnv).toLowerCase();
  if (SUPPORTED_SHELLS.includes(base)) return base;
  return '';
}

/**
 * 目标 rc 文件。
 * zsh：优先 `$ZDOTDIR/.zshrc`，否则 `~/.zshrc`。
 * bash：优先已存在的 `~/.bashrc`；macOS 上登录 shell 读 `~/.bash_profile`，
 *       因此若 `.bashrc` 不存在而 `.bash_profile` 存在，就写后者。
 */
function resolveRcFile(shell, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const env = options.env || process.env;
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
  return '';
}

function buildSnippet(shell, options = {}) {
  if (shell === 'zsh') return buildZshSnippet(options);
  if (shell === 'bash') return buildBashSnippet(options);
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
  SHELL_BLOCK_NAME,
  SHELL_BLOCK_PREFIX,
  SUPPORTED_SHELLS,
  buildSnippet,
  detectShell,
  normalizeSnippetOptions,
  resolveRcFile
};
