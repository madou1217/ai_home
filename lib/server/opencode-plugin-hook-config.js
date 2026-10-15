'use strict';

// opencode 生命周期 hook 的安装/诊断(P4)——文件式,不同于 claude/codex 的 JSON patch。
// 目标文件:<homeDir>/.config/opencode/plugin/aih-session-hook.js(全局插件目录,run/serve/TUI
// 三形态都加载,见 docs/fabric/21-provider-hooks.md §4.1)。provider-session-hook-config.js 的
// 四个公共函数在 provider==='opencode' 时早分支到这里。

const path = require('node:path');
const os = require('node:os');
const { AIH_PLUGIN_MARKER, buildOpenCodePluginSource } = require('./opencode-plugin-template');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function resolveHomeDir(options = {}) {
  return normalizeText(options.homeDir) || os.homedir();
}

// 插件文件路径。允许 AIH_OPENCODE_CONFIG_DIR 覆盖(测试/非标准 XDG)。
function getOpenCodePluginPath(options = {}) {
  const override = normalizeText(process.env.AIH_OPENCODE_CONFIG_DIR);
  const configDir = override || path.join(resolveHomeDir(options), '.config', 'opencode');
  return path.join(configDir, 'plugin', `${AIH_PLUGIN_MARKER}.js`);
}

// receiver URL:与 claude/codex sender 同端点,默认本机端口。
function buildReceiverUrl(options = {}) {
  const explicit = normalizeText(options.receiverUrl);
  if (explicit) return explicit;
  const port = Number(options.port) || Number(process.env.AIH_SERVER_PORT) || 9527;
  return `http://127.0.0.1:${port}/v0/webui/session-events/provider-hook`;
}

function readFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

// 诊断:插件文件是否存在且是 AIH 托管的(marker),receiver URL 是否与期望一致,
// 以及是否是新版(v2 契约)源码。opencode v2 只接受 default 对象入口,旧版「工厂函数
// 导出」的托管文件在 v2 会直接加载失败——只查 marker/URL 会把这种陈旧文件误报为已安装。
function diagnoseOpenCodePluginHook(options = {}) {
  const fs = options.fs || require('fs-extra');
  const targetPath = getOpenCodePluginPath(options);
  const source = readFileSafe(fs, targetPath);
  const expectedUrl = buildReceiverUrl(options);
  const isManaged = source.includes(AIH_PLUGIN_MARKER);
  const urlMatches = isManaged && source.includes(expectedUrl);
  const hasCurrentShape = isManaged && source.includes('export default')
    && source.includes('ctx.event.subscribe') && source.includes('session.execution.started');
  // 需要重装的原因(优先级:未装 → URL 变 → 源码陈旧)。
  let missingEvents = [];
  if (!isManaged) missingEvents = ['plugin-file'];
  else if (!urlMatches) missingEvents = ['receiver-url-changed'];
  else if (!hasCurrentShape) missingEvents = ['plugin-file-outdated'];
  return {
    supported: true,
    provider: 'opencode',
    targetPath,
    targetKind: 'plugin.js',
    installed: missingEvents.length === 0,
    disabled: false,
    missingEvents,
    events: ['UserPromptSubmit', 'Stop'],
    receiverUrl: expectedUrl
  };
}

// 构建写入描述(供 dry-run 预览):目标路径 + 期望源码 + 是否变更。
function buildOpenCodePluginPatch(options = {}) {
  const fs = options.fs || require('fs-extra');
  const targetPath = getOpenCodePluginPath(options);
  const receiverUrl = buildReceiverUrl(options);
  const nextSource = buildOpenCodePluginSource({ receiverUrl });
  const current = readFileSafe(fs, targetPath);
  return {
    ok: true,
    provider: 'opencode',
    targetPath,
    targetKind: 'plugin.js',
    changed: current !== nextSource,
    source: nextSource,
    receiverUrl,
    events: ['UserPromptSubmit', 'Stop']
  };
}

// 安装:写插件文件(mkdir -p plugin 目录)。dryRun 只返回 patch。
function installOpenCodePluginHook(options = {}) {
  const fs = options.fs || require('fs-extra');
  const patch = buildOpenCodePluginPatch(options);
  if (!options.dryRun) {
    const dir = path.dirname(patch.targetPath);
    if (typeof fs.ensureDirSync === 'function') fs.ensureDirSync(dir);
    else fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(patch.targetPath, patch.source, 'utf8');
  }
  return {
    ok: true,
    provider: 'opencode',
    targetPath: patch.targetPath,
    targetKind: 'plugin.js',
    changed: patch.changed,
    receiverUrl: patch.receiverUrl,
    events: patch.events,
    dryRun: Boolean(options.dryRun)
  };
}

module.exports = {
  getOpenCodePluginPath,
  buildReceiverUrl,
  diagnoseOpenCodePluginHook,
  buildOpenCodePluginPatch,
  installOpenCodePluginHook
};
