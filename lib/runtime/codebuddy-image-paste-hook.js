'use strict';

// 把「CLI 粘贴图片自动借视觉」的 UserPromptSubmit hook 装进 CodeBuddy 的共享
// settings.json。装的是 `scripts/codebuddy-image-paste-hook.js`。
//
// 为什么放在 CodeBuddy 配置里：iTerm2 粘贴图片只会给 CLI 一个临时路径；CLI 提供
// UserPromptSubmit hook，能在提交前把路径换成视觉描述。aih 的 codebuddy 启动策略
// 在 prepare 阶段调用本模块，保证新账号/新登录也自动带上，不依赖用户手改 settings。
//
// 纪律：
//   * 只对 CodeBuddy 两支 CLI（.codebuddy / .codebuddy-cn）生效；WorkBuddy 桌面
//     settings 是另一套 schema，绝不动。
//   * 合并而不是覆盖：保留用户已有的 hook 与其它 settings。
//   * settings.json 可能是指向规范存储的软链接；写之前解析 realpath，避免把
//     「一份物理文件」换成普通文件。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { writeFileAtomic } = require('./atomic-file-write');

const HOOK_SCRIPT_BASENAME = 'codebuddy-image-paste-hook.js';
const HOOK_EVENT = 'UserPromptSubmit';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveHookScriptPath(pathImpl = nodePath) {
  return pathImpl.join(__dirname, '..', '..', 'scripts', HOOK_SCRIPT_BASENAME);
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildHookCommand(nodePathValue, scriptPath) {
  // 共享 settings 也会被非 aih 启动的 CodeBuddy 读到；脚本/Node 路径失效时
  // 必须安静地放行用户提交（不能因为 hook 把 prompt 卡住）。
  return `${shellQuote(nodePathValue)} ${shellQuote(scriptPath)} 2>/dev/null || true`;
}

function readJsonObject(fs, filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function resolveWritablePath(fs, filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (_error) {
    return filePath;
  }
}

/**
 * 确保 settings.json 里存在我们的 UserPromptSubmit hook。
 *
 * @param {object} input
 * @param {any} input.fs
 * @param {any} [input.path]
 * @param {string} input.configDir           账号投影的 CodeBuddy configDir
 * @param {string} [input.settingsPath]     直接指定 settings 路径（测试用）
 * @param {string} [input.nodePathValue]    hook 使用的 node 可执行文件（默认 process.execPath）
 * @param {string} [input.scriptPath]       hook 脚本路径（测试用）
 * @returns {{changed: boolean, path: string}}
 */
function ensureCodebuddyImagePasteHook(input = {}) {
  const fs = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const configDir = normalizeText(input.configDir);
  const settingsPath = normalizeText(input.settingsPath)
    || (configDir ? pathImpl.join(configDir, 'settings.json') : '');
  if (!settingsPath) return { changed: false, path: '' };
  const scriptPath = normalizeText(input.scriptPath) || resolveHookScriptPath(pathImpl);
  try {
    if (!fs.existsSync(scriptPath)) return { changed: false, path: settingsPath };
  } catch (_error) {
    return { changed: false, path: settingsPath };
  }
  const writablePath = resolveWritablePath(fs, settingsPath);
  const settings = readJsonObject(fs, writablePath) || {};
  const hooks = isPlainObject(settings.hooks) ? { ...settings.hooks } : {};
  const entries = Array.isArray(hooks[HOOK_EVENT]) ? hooks[HOOK_EVENT].slice() : [];
  const command = buildHookCommand(input.nodePathValue || process.execPath, scriptPath);
  let found = false;
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (!isPlainObject(entry)) return entry;
    const hookList = Array.isArray(entry.hooks) ? entry.hooks.slice() : [];
    let entryChanged = false;
    for (let index = 0; index < hookList.length; index += 1) {
      const hook = hookList[index];
      if (!isPlainObject(hook) || hook.type !== 'command') continue;
      if (!normalizeText(hook.command).includes(HOOK_SCRIPT_BASENAME)) continue;
      found = true;
      if (hook.command !== command) {
        hookList[index] = { ...hook, command };
        entryChanged = true;
        changed = true;
      }
    }
    return entryChanged ? { ...entry, hooks: hookList } : entry;
  });
  if (!found) {
    nextEntries.push({
      matcher: '',
      hooks: [{ type: 'command', command }]
    });
    changed = true;
  }
  if (!changed) return { changed: false, path: writablePath };
  settings.hooks = { ...hooks, [HOOK_EVENT]: nextEntries };
  try {
    writeFileAtomic(fs, writablePath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (_error) {
    return { changed: false, path: writablePath };
  }
  return { changed: true, path: writablePath };
}

module.exports = {
  HOOK_EVENT,
  HOOK_SCRIPT_BASENAME,
  buildHookCommand,
  ensureCodebuddyImagePasteHook,
  resolveHookScriptPath,
  shellQuote
};
