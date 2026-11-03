'use strict';

// 「这个 harness 现在用的是哪个模型」——只读 harness 自己的配置口径，不猜。
//
// 为什么不能用账号目录里的默认模型：那是**该账号可路由的第一个模型**（WebUI 选择器的
// 默认项，见 harness/pinned-default-model.js），跟用户在这个会话里实际选的模型没有关系。
// 2026-11-01 用户报的「codebuddycn 会话标题显示 deepseek-v4-pro，实际用的是
// DeepSeek-V4.1-Flash」就是拿它当标题模型的结果：目录第一条是 deepseek-v4-pro，
// 而用户选的是 deepseek-v4.1-flash。
//
// 取值顺序由调用方决定（命令行 --model 最权威），本模块只回答「harness 配置里写的是
// 哪个模型」。读不到就返回空串——宁可标题少一段，也不写一个假模型名。
//
// 各 harness 的配置口径（2026-11-01 核对，来源见 docs/providers/harness-statusline.md）：
//   claude       settings.json        `model`（别名或全名）
//   codebuddy*   settings.json        `model`
//   codex        config.toml          `model = "..."`
//   gemini       settings.json        `model.name`
//   agy          settings.json        `model`（客户端给的是显示名）
//   opencode     opencode.json        `model`（provider/model）
//   grok         config.toml          `[models] default = "..."`
//   kiro / cline / qoder / qodercn / zcode / kimi
//                没有可解析的「当前模型」声明 → 返回空串（调用方继续按空处理）

const nodeFs = require('node:fs');
const nodePath = require('node:path');

// 配置里 `model` 可能被写成对象（{id/name/model}）或字符串，统一压成字符串。
function coerceModelValue(value, depth = 0) {
  if (value == null || depth > 2) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['id', 'name', 'model', 'modelId', 'model_id']) {
      const nested = coerceModelValue(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

function readJsonField(content, keys) {
  let parsed;
  try { parsed = JSON.parse(content); } catch (_error) { return ''; }
  let cursor = parsed;
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object') return '';
    cursor = cursor[key];
  }
  return coerceModelValue(cursor);
}

// TOML 只认「一行一个键」这一种写法：这些 harness 的 model 声明都是顶层标量，
// 引一个完整 TOML 解析器换不来更多事实（codex 侧同样只用正则，见 codex-launch-support）。
function readTomlField(content, keys) {
  const lines = String(content || '').split(/\r?\n/);
  const sectionName = keys.length > 1 ? keys[0] : '';
  const keyName = keys[keys.length - 1];
  // 顶层键只认「第一个 [section] 之前」的行；表内键只在对应段落里找。
  let section = '';
  for (const line of lines) {
    const header = line.match(/^[ \t]*\[([^\]]+)\][ \t]*$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== sectionName) continue;
    const assignment = line.match(new RegExp(`^[ \\t]*${keyName}[ \\t]*=[ \\t]*\"([^\"]+)\"`));
    if (assignment) return String(assignment[1]).trim();
  }
  return '';
}

const CONFIG_MODEL_SOURCES = Object.freeze({
  claude: Object.freeze({ parts: ['.claude', 'settings.json'], keys: ['model'], format: 'json' }),
  codebuddy: Object.freeze({ parts: ['.codebuddy', 'settings.json'], keys: ['model'], format: 'json' }),
  codebuddycn: Object.freeze({ parts: ['.codebuddy-cn', 'settings.json'], keys: ['model'], format: 'json' }),
  workbuddy: Object.freeze({ parts: ['.workbuddy-ai', 'settings.json'], keys: ['model'], format: 'json' }),
  workbuddycn: Object.freeze({ parts: ['.workbuddy', 'settings.json'], keys: ['model'], format: 'json' }),
  codex: Object.freeze({ parts: ['.codex', 'config.toml'], keys: ['model'], format: 'toml' }),
  gemini: Object.freeze({ parts: ['.gemini', 'settings.json'], keys: ['model', 'name'], format: 'json' }),
  agy: Object.freeze({ parts: ['.gemini', 'antigravity-cli', 'settings.json'], keys: ['model'], format: 'json' }),
  opencode: Object.freeze({ parts: ['.config', 'opencode', 'opencode.json'], keys: ['model'], format: 'json' }),
  grok: Object.freeze({ parts: ['.grok', 'config.toml'], keys: ['models', 'default'], format: 'toml' })
});

// 同一份配置在一次会话里会被反复问（标题轮播、状态刷新）。按 mtime+size 记忆化，
// 内容没变就不重复读——文件通常只有几百字节，但没必要每个标题节拍都走一次 IO。
const CACHE_LIMIT = 64;
const configCache = new Map();

function readConfigFile(filePath, fsImpl) {
  let stats;
  try { stats = fsImpl.statSync(filePath); } catch (_error) { return ''; }
  if (!stats || !stats.isFile()) return '';
  const key = `${filePath}\u0000${stats.size}\u0000${stats.mtimeMs}`;
  const cached = configCache.get(key);
  if (cached !== undefined) return cached;
  let content = '';
  try { content = String(fsImpl.readFileSync(filePath, 'utf8') || ''); } catch (_error) { content = ''; }
  if (configCache.size >= CACHE_LIMIT) configCache.clear();
  configCache.set(key, content);
  return content;
}

function parseSettingsModel(content, source) {
  if (!content) return '';
  return source.format === 'toml'
    ? readTomlField(content, source.keys)
    : readJsonField(content, source.keys);
}

/**
 * 从 `--settings <file>` / `--settings=<file>` 里取模型：Claude 允许用一份独立设置文件
 * 覆盖用户设置，那份文件里的 model 比 ~/.claude/settings.json 更贴近当前会话。
 */
function readSettingsFileArg(forwardArgs = []) {
  const list = Array.isArray(forwardArgs) ? forwardArgs : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '').trim();
    if (token === '--settings') {
      const value = String(list[index + 1] || '').trim();
      if (value && !value.startsWith('-')) return value;
    }
    if (token.startsWith('--settings=')) {
      const value = token.slice('--settings='.length).trim();
      if (value) return value;
    }
  }
  return '';
}

/**
 * 候选配置文件，按「优先级从高到低」排。
 *
 * 为什么不能只看 `$HOME`：aih 启动 harness 时用的是**账号沙箱**，各 CLI 的配置根
 * 往往不是 HOME 本身——Claude 认 `CLAUDE_CONFIG_DIR`、Codex 认 `CODEX_HOME`、
 * Gemini 认 `GEMINI_CLI_HOME` / `GEMINI_CLI_SYSTEM_SETTINGS_PATH`。
 * 这些变量就在 pty 子进程的 env 里（`shared.lastRuntimeEnv`），照抄才对得上
 * 「CLI 自己会读哪一份」。
 */
function configCandidates(provider, source, ctx) {
  const { env, homeDir, projectDir, pathImpl } = ctx;
  const envText = (key) => String((env && env[key]) || '').trim();
  const list = [];

  if (provider === 'claude') {
    // 独立设置文件由调用方先查（--settings），这里只关心「用户级」落在哪。
    const configDir = envText('CLAUDE_CONFIG_DIR');
    if (projectDir) {
      list.push(pathImpl.join(projectDir, '.claude', 'settings.local.json'));
      list.push(pathImpl.join(projectDir, '.claude', 'settings.json'));
    }
    if (configDir) list.push(pathImpl.join(configDir, 'settings.json'));
  }

  if (provider === 'codex') {
    const codexHome = envText('CODEX_HOME');
    if (codexHome) list.push(pathImpl.join(codexHome, 'config.toml'));
  }

  if (provider === 'gemini' || provider === 'agy') {
    const settingsPath = envText('GEMINI_CLI_SYSTEM_SETTINGS_PATH');
    if (settingsPath) list.push(settingsPath);
    const geminiHome = envText('GEMINI_CLI_HOME');
    if (geminiHome) list.push(pathImpl.join(geminiHome, 'settings.json'));
  }

  if (homeDir) list.push(pathImpl.join(homeDir, ...source.parts));
  return list;
}

/**
 * 该 harness 配置里声明的当前模型；读不到返回空串。
 *
 * @param {object} input
 * @param {string} input.provider      provider id（claude / codebuddycn / codex / …）
 * @param {object} [input.env]         该会话 harness 子进程的 env（账号沙箱后的）
 * @param {string} [input.homeDir]     该会话的 HOME（缺省取 env.HOME / process.env.HOME）
 * @param {string[]} [input.forwardArgs] 转发给 harness 的参数（用于 --settings）
 * @param {string} [input.projectDir]  工作目录（Claude 的项目级设置）
 * @param {object} [input.fs]          注入的文件系统（测试用）
 */
function resolveHarnessCurrentModel(input = {}) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const source = CONFIG_MODEL_SOURCES[provider];
  if (!source) return '';
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const env = input.env || process.env;
  const homeDir = String(input.homeDir || env.HOME || process.env.HOME || '').trim();

  // Claude 的 --settings 文件优先级最高：它按会话注入，压过用户级 settings.json。
  if (provider === 'claude') {
    const settingsPath = readSettingsFileArg(input.forwardArgs);
    if (settingsPath) {
      const fromFile = parseSettingsModel(readConfigFile(settingsPath, fsImpl), source);
      if (fromFile) return fromFile;
    }
  }

  const candidates = configCandidates(provider, source, {
    env,
    homeDir,
    projectDir: String(input.projectDir || '').trim(),
    pathImpl
  });
  for (const configPath of candidates) {
    if (!configPath) continue;
    const model = parseSettingsModel(readConfigFile(configPath, fsImpl), source);
    if (model) return model;
  }
  return '';
}

module.exports = {
  CONFIG_MODEL_SOURCES,
  resolveHarnessCurrentModel
};
