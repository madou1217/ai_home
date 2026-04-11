'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CLAUDE_COMMANDS_DIR = path.join(
  os.homedir(),
  'Downloads',
  'package',
  'cli',
  'src',
  'commands'
);
const GEMINI_COMMANDS_DOC_URL = 'https://google-gemini.github.io/gemini-cli/docs/cli/commands.html';
const CODEX_REPO_URL = 'https://github.com/openai/codex';

const SOURCE_CACHE_TTL_MS = 15000;
let cachedClaudeCommands = null;
let cachedClaudeCommandsAt = 0;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveClaudeCommandsDir() {
  return normalizeString(process.env.AIH_CLAUDE_CODE_COMMANDS_DIR) || DEFAULT_CLAUDE_COMMANDS_DIR;
}

function listClaudeCommandCandidateFiles(commandsDir) {
  if (!commandsDir || !fs.existsSync(commandsDir)) return [];

  const results = [];
  const queue = [commandsDir];
  while (queue.length > 0) {
    const currentDir = queue.shift();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        return;
      }
      if (!entry.isFile()) return;
      if (entry.name === 'index.ts' || (currentDir === commandsDir && entry.name.endsWith('.ts'))) {
        results.push(fullPath);
      }
    });
  }
  return results;
}

function extractCommandBlocks(content) {
  return [...String(content || '').matchAll(
    /(?:const|export\s+const)\s+\w+[^{=]*=\s*{([\s\S]*?)}\s*(?:satisfies\s+Command)?/g
  )].map((match) => String(match[1] || ''));
}

function parseAliases(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((item) => normalizeString(item).replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .map((alias) => alias.startsWith('/') ? alias : `/${alias}`);
}

function parseCommandMetaFromBlock(block, filePath) {
  if (!/supportsNonInteractive\s*:\s*true/.test(block)) return null;

  const nameMatch = block.match(/name\s*:\s*['"]([^'"]+)['"]/);
  const descriptionMatch = block.match(/description\s*:\s*['"`]([^'"`]+)['"`]/);
  const argumentHintMatch = block.match(/argumentHint\s*:\s*['"]([^'"]+)['"]/);
  const aliasesMatch = [...block.matchAll(/aliases\s*:\s*\[([^\]]*)\]/g)]
    .map((match) => String(match[1] || ''))
    .join(',');

  const aliases = parseAliases(aliasesMatch);

  const name = normalizeString(nameMatch && nameMatch[1]);
  if (!name) return null;

  return {
    command: `/${name}`,
    description: normalizeString(descriptionMatch && descriptionMatch[1]) || `Run ${name}`,
    argumentHint: normalizeString(argumentHintMatch && argumentHintMatch[1]),
    aliases,
    source: filePath
  };
}

function parseCommandMeta(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return extractCommandBlocks(content)
    .map((block) => parseCommandMetaFromBlock(block, filePath))
    .filter(Boolean);
}

function loadClaudeSlashCommandsFromSource() {
  const now = Date.now();
  if (cachedClaudeCommands && (now - cachedClaudeCommandsAt) < SOURCE_CACHE_TTL_MS) {
    return cachedClaudeCommands;
  }

  const commandsDir = resolveClaudeCommandsDir();
  const commands = listClaudeCommandCandidateFiles(commandsDir)
    .map(parseCommandMeta)
    .flat()
    .filter(Boolean);
  const deduped = [];
  const seen = new Set();
  commands.forEach((command) => {
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
  if (normalizedProvider === 'claude') {
    return loadClaudeSlashCommandsFromSource();
  }
  if (normalizedProvider === 'gemini') {
    return [
      {
        command: '/about',
        description: '显示 Gemini CLI 版本信息',
        argumentHint: '',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/help',
        description: '显示 Gemini CLI 命令帮助',
        argumentHint: '',
        aliases: ['/?'],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/stats',
        description: '显示当前会话统计信息',
        argumentHint: '',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/compress',
        description: '把当前上下文压缩成摘要以节省 token',
        argumentHint: '',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/mcp',
        description: '显示 MCP server、连接状态和工具列表',
        argumentHint: '[desc|nodesc|schema]',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/tools',
        description: '显示当前可用工具列表',
        argumentHint: '[desc|nodesc]',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/memory',
        description: '管理或查看 GEMINI.md 分层记忆',
        argumentHint: '<show|list|refresh|add ...>',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/directory',
        description: '管理额外工作目录',
        argumentHint: '<show|add ...>',
        aliases: ['/dir'],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/chat',
        description: '管理聊天检查点与恢复',
        argumentHint: '<save|resume|list|delete|share ...>',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      },
      {
        command: '/init',
        description: '为当前目录生成 GEMINI.md 上下文文件',
        argumentHint: '',
        aliases: [],
        source: GEMINI_COMMANDS_DOC_URL
      }
    ];
  }
  if (normalizedProvider === 'codex') {
    return [
      {
        command: '/clear',
        description: '清空当前对话上下文并开始新一轮会话',
        argumentHint: '',
        aliases: [],
        source: CODEX_REPO_URL
      }
    ];
  }
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
