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
    quoteWindowsCommandArg(context.nodeCommand),
    quoteWindowsCommandArg(context.senderScriptPath),
    context.managedMarker,
    '--provider',
    quoteWindowsCommandArg(context.provider),
    '--event',
    quoteWindowsCommandArg(context.eventName),
    '--url',
    quoteWindowsCommandArg(context.receiverUrl)
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
  const strategy = resolveProviderHookCommandStrategy(platform);
  return strategy.buildCommand({
    nodeCommand: normalizeText(options.nodeCommand) || (platform === 'win32' ? process.execPath : ''),
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
