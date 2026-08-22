'use strict';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function quoteShellArg(value) {
  const text = String(value == null ? '' : value);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsCommandArg(value) {
  const text = String(value == null ? '' : value).replace(/\\/g, '/');
  return `"${text.replace(/"/g, '""')}"`;
}

// codex 等宿主在 Windows 经 %COMSPEC% /C 执行 hook 命令串；旧版宿主（codex
// 0.149 实测）把命令串作为单个 argv 经 MSVCRT 转义传递，命令里的 " 变成 \"
// 后 cmd 报 not recognized、hook 以 exit 1 失败（2026-08-22）。因此 Windows
// hook 命令必须完全无引号才能穿过任意转义层：
// - 不含空格的 token 保持裸文本（反斜杠统一正斜杠，cmd 两种都认）；
// - 仅当 token 自身含空格才加引号（此时旧版宿主仍会失败，新版 raw_arg 宿主
//   可用，属尽力而为）；
// - URL 剥离查询串（含 & 且必须引号；provider/event 由 sender 写进 body，
//   接收端有 body fallback），node 含空格路径由调用方退回裸 node 走 PATH。
function toWindowsHookToken(value) {
  const text = normalizeText(value).replace(/\\/g, '/');
  if (!/\s/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function stripUrlQuery(value) {
  const text = normalizeText(value);
  const queryIndex = text.indexOf('?');
  return queryIndex >= 0 ? text.slice(0, queryIndex) : text;
}

function buildPosixCommand(context) {
  const nodeCommand = context.nodeCommand || '/usr/bin/env node';
  return [
    nodeCommand,
    quoteShellArg(context.senderScriptPath),
    context.managedMarker,
    '--provider',
    quoteShellArg(context.provider),
    '--event',
    quoteShellArg(context.eventName),
    '--url',
    quoteShellArg(context.receiverUrl)
  ].join(' ');
}

function buildWindowsCommand(context) {
  return [
    toWindowsHookToken(context.nodeCommand),
    toWindowsHookToken(context.senderScriptPath),
    context.managedMarker,
    '--provider',
    toWindowsHookToken(context.provider),
    '--event',
    toWindowsHookToken(context.eventName),
    '--url',
    toWindowsHookToken(stripUrlQuery(context.receiverUrl))
  ].join(' ');
}

const COMMAND_STRATEGIES = Object.freeze({
  win32: Object.freeze({ buildCommand: buildWindowsCommand }),
  posix: Object.freeze({ buildCommand: buildPosixCommand })
});

function resolveProviderHookCommandStrategy(platformRaw) {
  return normalizeText(platformRaw) === 'win32'
    ? COMMAND_STRATEGIES.win32
    : COMMAND_STRATEGIES.posix;
}

function buildProviderHookCommand(options = {}) {
  const platform = normalizeText(options.platform) || process.platform;
  let nodeCommand = normalizeText(options.nodeCommand) || (platform === 'win32' ? process.execPath : '');
  // Windows hook 命令必须无引号（见 toWindowsHookToken）；node 装在含空格的
  // 路径（如 Program Files）时退回裸 node 走 PATH，hook 继承宿主环境。
  if (platform === 'win32' && /\s/.test(nodeCommand)) nodeCommand = 'node';
  const strategy = resolveProviderHookCommandStrategy(platform);
  return strategy.buildCommand({
    nodeCommand,
    senderScriptPath: normalizeText(options.senderScriptPath),
    managedMarker: normalizeText(options.managedMarker),
    provider: normalizeText(options.provider),
    eventName: normalizeText(options.eventName),
    receiverUrl: normalizeText(options.receiverUrl)
  });
}

function commandReferencesProvider(command, providerRaw) {
  const provider = normalizeText(providerRaw);
  if (!provider) return false;
  const normalizedFlags = normalizeText(command).replace(/(['"])--provider\1/g, '--provider');
  return normalizedFlags.includes(`--provider '${provider}'`)
    || normalizedFlags.includes(`--provider "${provider}"`)
    || normalizedFlags.includes(`--provider ${provider}`);
}

module.exports = {
  buildProviderHookCommand,
  commandReferencesProvider,
  quoteShellArg,
  quoteWindowsCommandArg,
  resolveProviderHookCommandStrategy
};
