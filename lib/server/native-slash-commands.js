'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CLAUDE_COMMANDS,
  CODEX_COMMANDS,
  OPENCODE_COMMANDS,
  AGY_COMMANDS,
  GEMINI_COMMANDS
} = require('./native-slash-command-catalog');

// 用户自定义 claude slash 命令目录（markdown）：<HOME>/.claude/commands/*.md。
// 之前这里硬编码到 ~/Downloads/package/cli/src/commands 去解析 claude 源码——那是台机器上的
// 陈旧开发包(且是 .ts 源码)，实际机器上不存在 → 列表为空/残缺 → /clear 等真实命令被 gate 拒绝。
const DEFAULT_CLAUDE_COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');

// 这些 provider 有真实交互式 CLI，slash 命令的权威是 CLI 本身；未匹配静态清单的命令一律放行
// 交给 CLI 执行（不硬拒）。静态清单（native-slash-command-catalog.js）只用于 autocomplete。
const SLASH_PASSTHROUGH_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'agy', 'opencode']);

const SOURCE_CACHE_TTL_MS = 15000;
let cachedClaudeCommands = null;
let cachedClaudeCommandsAt = 0;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveClaudeCommandsDir() {
  return normalizeString(process.env.AIH_CLAUDE_CODE_COMMANDS_DIR) || DEFAULT_CLAUDE_COMMANDS_DIR;
}

// 扫描用户自定义 claude 命令：<HOME>/.claude/commands/**/*.md → /<name>。
function scanClaudeUserCommands() {
  const commandsDir = resolveClaudeCommandsDir();
  if (!commandsDir || !fs.existsSync(commandsDir)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}${entry.name}:`);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const name = entry.name.slice(0, -3);
        out.push({
          command: `/${prefix}${name}`,
          description: '用户自定义命令',
          argumentHint: '',
          aliases: [],
          source: 'claude-user'
        });
      }
    }
  };
  try {
    walk(commandsDir, '');
  } catch (_error) {
    return out;
  }
  return out;
}

function loadClaudeSlashCommandsFromSource() {
  const now = Date.now();
  if (cachedClaudeCommands && (now - cachedClaudeCommandsAt) < SOURCE_CACHE_TTL_MS) {
    return cachedClaudeCommands;
  }

  // 内置清单（catalog,实测校验）+ 用户自定义命令（.md）。
  const merged = [...CLAUDE_COMMANDS, ...scanClaudeUserCommands()];
  const deduped = [];
  const seen = new Set();
  merged.forEach((command) => {
    if (!command || seen.has(command.command)) return;
    seen.add(command.command);
    deduped.push(command);
  });

  cachedClaudeCommands = deduped.sort((left, right) => left.command.localeCompare(right.command));
  cachedClaudeCommandsAt = now;
  return cachedClaudeCommands;
}

function getProviderSlashCommands(provider) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  if (normalizedProvider === 'claude') return loadClaudeSlashCommandsFromSource();
  if (normalizedProvider === 'gemini') return GEMINI_COMMANDS;
  if (normalizedProvider === 'codex') return CODEX_COMMANDS;
  if (normalizedProvider === 'opencode') return OPENCODE_COMMANDS;
  if (normalizedProvider === 'agy') return AGY_COMMANDS;
  return [];
}

function parseSlashInput(input) {
  const trimmed = normalizeString(input);
  if (!trimmed.startsWith('/')) return null;
  const firstToken = trimmed.split(/\s+/, 1)[0];
  return firstToken || null;
}

function findEmbeddedSlashToken(commands, input) {
  const trimmed = normalizeString(input);
  if (!trimmed || trimmed.startsWith('/')) return null;
  const candidates = Array.isArray(commands)
    ? commands.flatMap((item) => [item.command, ...(Array.isArray(item.aliases) ? item.aliases : [])])
    : [];
  if (candidates.length === 0) return null;
  const tokens = trimmed.split(/\s+/).map((item) => normalizeString(item)).filter(Boolean);
  return tokens.find((token) => candidates.includes(token)) || null;
}

function validateNativeSlashCommand(provider, input) {
  const commands = getProviderSlashCommands(provider);
  const slashToken = parseSlashInput(input);
  if (!slashToken) {
    const embeddedSlashToken = findEmbeddedSlashToken(commands, input);
    if (embeddedSlashToken) {
      const error = new Error(`命令 ${embeddedSlashToken} 必须单独输入，不能和普通文本混发`);
      error.code = 'native_slash_command_must_be_standalone';
      error.provider = provider;
      error.command = embeddedSlashToken;
      error.commands = commands.map((item) => item.command);
      throw error;
    }
    return {
      ok: true,
      isSlashCommand: false,
      matched: null,
      commands
    };
  }

  const matched = commands.find((item) => item.command === slashToken || item.aliases.includes(slashToken)) || null;
  if (!matched) {
    // slash 命令的权威是各 provider 的真实 CLI（内置 + 用户自定义 + 插件命令，数量多且会变），
    // AIH 的静态清单只用于 autocomplete，不该当硬门槛。未匹配的命令一律放行、交给 CLI 交互执行；
    // CLI 若不认识会把错误打进 terminal 流，用户能看到。避免真实命令(/clear /model 等)被误拒。
    if (SLASH_PASSTHROUGH_PROVIDERS.has(normalizeString(provider).toLowerCase())) {
      return {
        ok: true,
        isSlashCommand: true,
        matched: {
          command: slashToken,
          description: '',
          argumentHint: '',
          aliases: [],
          source: 'cli-passthrough'
        },
        commands
      };
    }
    const error = new Error(`当前 provider 不支持命令 ${slashToken}`);
    error.code = 'native_slash_command_unsupported';
    error.provider = provider;
    error.command = slashToken;
    error.commands = commands.map((item) => item.command);
    throw error;
  }

  return {
    ok: true,
    isSlashCommand: true,
    matched,
    commands
  };
}

function clearNativeSlashCommandCache() {
  cachedClaudeCommands = null;
  cachedClaudeCommandsAt = 0;
}

module.exports = {
  getProviderSlashCommands,
  validateNativeSlashCommand,
  clearNativeSlashCommandCache
};
