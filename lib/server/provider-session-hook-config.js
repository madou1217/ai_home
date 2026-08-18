'use strict';

const path = require('node:path');
const { listProviderDefinitions } = require('../provider-catalog');
const {
  enableCodexHooksFeatureFlag,
  getCodexHooksFeatureFlagState
} = require('../cli/config/codex-feature-flags');
const {
  diagnoseOpenCodePluginHook,
  buildOpenCodePluginPatch,
  installOpenCodePluginHook,
  getOpenCodePluginPath
} = require('./opencode-plugin-hook-config');
const {
  buildProviderHookCommand,
  commandReferencesProvider,
  quoteShellArg,
  quoteWindowsCommandArg
} = require('./provider-hook-command-strategy');

const MANAGED_HOOK_MARKER = '--aih-provider-session-hook';
const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;
const DEFAULT_HOOK_TIMEOUT_MS = DEFAULT_HOOK_TIMEOUT_SECONDS * 1000;
const DEFAULT_RECEIVER_URL = 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook';
const DEFAULT_SENDER_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'aih-provider-session-hook-sender.js');
const AGY_MANAGED_HOOK_NAME = 'aih-session-sync';

// 会话同步声明来自 Go Provider 合同；本模块只保留各 Hook 格式的具体写入策略。
const PROVIDER_SESSION_SYNC_BY_ID = Object.freeze(Object.fromEntries(
  listProviderDefinitions().map((definition) => [definition.id, definition.sessionSync])
));

// 独立 hooks.json 的 Provider 由合同 targetKind 推导，不再维护手写集合。
const HOOKS_JSON_TARGET_PROVIDERS = new Set(
  Object.entries(PROVIDER_SESSION_SYNC_BY_ID)
    .filter(([, sync]) => sync && sync.targetKind === 'hooks.json')
    .map(([provider]) => provider)
);

// JSON Hook 默认事件由合同生成；OpenCode 插件桥没有 JSON 事件清单，因此自然不在这里。
const DEFAULT_EVENTS_BY_PROVIDER = Object.freeze(Object.fromEntries(
  Object.entries(PROVIDER_SESSION_SYNC_BY_ID)
    .filter(([, sync]) => sync && sync.mode === 'hook' && Array.isArray(sync.events) && sync.events.length > 0)
    .map(([provider, sync]) => [provider, Object.freeze(sync.events.slice())])
));

const INSTALLABLE_PROVIDER_IDS = Object.freeze(
  listProviderDefinitions()
    .filter((definition) => definition.sessionSync
      && definition.sessionSync.mode === 'hook'
      && definition.sessionSync.adapter)
    .map((definition) => definition.id)
);

const CODEX_SESSION_START_MATCHER = 'startup|resume|clear|compact';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeProvider(value) {
  return normalizeText(value).toLowerCase();
}

function isProviderSessionHookSupported(providerRaw) {
  const provider = normalizeProvider(providerRaw);
  const sync = PROVIDER_SESSION_SYNC_BY_ID[provider];
  return Boolean(sync && sync.mode === 'hook' && sync.adapter);
}

// 会话实时同步的三态,供 WebUI 诚实展示(而非把没有官方 hook 的 provider 直接从卡片里滤掉):
// 'hook' = 官方 hook 已接入(事件驱动) / 'polling' = 无官方 hook,但 session-event-bus 仍能靠
// 文件 watch+轮询兜底(resolveSessionFilePath 有实现) / 'unavailable' = 连轮询都读不到会话文件。
function getProviderSessionSyncMode(providerRaw) {
  const provider = normalizeProvider(providerRaw);
  const sync = PROVIDER_SESSION_SYNC_BY_ID[provider];
  return sync && sync.mode ? sync.mode : 'unavailable';
}

function listInstallableProviderIds() {
  return INSTALLABLE_PROVIDER_IDS.slice();
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') return {};
  return JSON.parse(JSON.stringify(value));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEvents(provider, events) {
  const defaults = DEFAULT_EVENTS_BY_PROVIDER[provider] || [];
  const source = Array.isArray(events) && events.length > 0 ? events : defaults;
  return source.map(normalizeText).filter(Boolean);
}

function buildProviderHookReceiverUrl(options = {}) {
  const provider = normalizeProvider(options.provider);
  const eventName = normalizeText(options.eventName || options.event);
  const baseUrl = normalizeText(options.receiverUrl || options.serverUrl) || DEFAULT_RECEIVER_URL;
  const url = new URL(baseUrl);
  if (provider) url.searchParams.set('provider', provider);
  if (eventName) url.searchParams.set('event', eventName);
  return url.toString();
}

function buildProviderSessionHookSenderCommand(options = {}) {
  const provider = normalizeProvider(options.provider);
  const eventName = normalizeText(options.eventName || options.event);
  const senderScriptPath = normalizeText(options.senderScriptPath) || DEFAULT_SENDER_SCRIPT_PATH;
  const platform = normalizeText(options.platform) || process.platform;
  const configuredNodeCommand = normalizeText(options.nodeExecPath || options.nodeCommand);
  const receiverUrl = buildProviderHookReceiverUrl({
    receiverUrl: normalizeText(options.receiverUrl || options.serverUrl),
    provider,
    eventName
  });

  return buildProviderHookCommand({
    platform,
    nodeCommand: configuredNodeCommand,
    senderScriptPath,
    managedMarker: MANAGED_HOOK_MARKER,
    provider,
    eventName,
    receiverUrl
  });
}

function buildCommandHookHandler(provider, eventName, options = {}) {
  const timeout = provider === 'gemini'
    ? Math.max(100, Number(options.timeoutMs) || (Number(options.timeoutSeconds) || DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000)
    : Math.max(1, Number(options.timeoutSeconds) || DEFAULT_HOOK_TIMEOUT_SECONDS);
  return {
    type: 'command',
    command: buildProviderSessionHookSenderCommand({
      ...options,
      provider,
      eventName
    }),
    timeout
  };
}

function isManagedCommand(command, provider) {
  const text = normalizeText(command);
  if (!text || !text.includes(MANAGED_HOOK_MARKER)) return false;
  if (!provider) return true;
  return commandReferencesProvider(text, provider);
}

function isManagedHandler(handler, provider) {
  return isManagedCommand(handler && handler.command, provider);
}

function removeManagedHandlersFromGroup(group, provider) {
  if (!group || typeof group !== 'object') return { group, removed: false };
  if (!Array.isArray(group.hooks)) return { group, removed: false };
  const hooks = group.hooks.filter((hook) => !isManagedHandler(hook, provider));
  if (hooks.length === group.hooks.length) return { group, removed: false };
  if (hooks.length === 0) return { group: null, removed: true };
  return { group: { ...group, hooks }, removed: true };
}

function removeManagedHandlersFromHooksObject(hooksObject, provider) {
  let changed = false;
  const next = {};
  Object.entries(asObject(hooksObject)).forEach(([eventName, groups]) => {
    const keptGroups = [];
    asArray(groups).forEach((group) => {
      const result = removeManagedHandlersFromGroup(group, provider);
      if (result.removed) changed = true;
      if (result.group) keptGroups.push(result.group);
    });
    if (keptGroups.length > 0) next[eventName] = keptGroups;
    if (keptGroups.length === 0 && Array.isArray(groups) && groups.length > 0) changed = true;
  });
  return { hooks: next, changed };
}

function createProviderMatcherGroup(provider, eventName, handler) {
  const group = { hooks: [handler] };
  if (provider === 'codex' && eventName === 'SessionStart') {
    group.matcher = CODEX_SESSION_START_MATCHER;
  }
  return group;
}

function buildEventHooksConfig(provider, existingConfig, options = {}) {
  const events = normalizeEvents(provider, options.events);
  const next = cloneJson(existingConfig);
  const cleaned = removeManagedHandlersFromHooksObject(next.hooks, provider);
  next.hooks = cleaned.hooks;

  events.forEach((eventName) => {
    const handler = buildCommandHookHandler(provider, eventName, options);
    const group = createProviderMatcherGroup(provider, eventName, handler);
    next.hooks[eventName] = asArray(next.hooks[eventName]).concat(group);
  });

  return {
    config: next,
    events
  };
}

function createAgyEventValue(provider, eventName, handler) {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    return [
      {
        matcher: '*',
        hooks: [handler]
      }
    ];
  }
  return [handler];
}

function agyEventHasManagedHandler(eventValue, provider) {
  const items = asArray(eventValue);
  return items.some((item) => {
    if (isManagedHandler(item, provider)) return true;
    return asArray(item && item.hooks).some((hook) => isManagedHandler(hook, provider));
  });
}

function buildAgyHooksConfig(existingConfig, options = {}) {
  const provider = 'agy';
  const events = normalizeEvents(provider, options.events);
  const hookName = normalizeText(options.hookName) || AGY_MANAGED_HOOK_NAME;
  const next = cloneJson(existingConfig);
  const hookDefinition = { enabled: true };

  events.forEach((eventName) => {
    const handler = buildCommandHookHandler(provider, eventName, options);
    hookDefinition[eventName] = createAgyEventValue(provider, eventName, handler);
  });

  next[hookName] = hookDefinition;
  return {
    config: next,
    events,
    hookName
  };
}

function getProviderHookConfigTarget(providerRaw, options = {}) {
  const provider = normalizeProvider(providerRaw);
  const homeDir = normalizeText(options.homeDir) || '~';
  if (provider === 'codex') return path.join(homeDir, '.codex', 'hooks.json');
  if (provider === 'claude') return path.join(homeDir, '.claude', 'settings.json');
  if (provider === 'gemini') return path.join(homeDir, '.gemini', 'settings.json');
  if (provider === 'agy') return path.join(homeDir, '.gemini', 'config', 'hooks.json');
  if (provider === 'opencode') return getOpenCodePluginPath({ homeDir });
  // grok reads *.json files under ~/.grok/hooks/ (project hooks live under <project>/.grok/hooks/,
  // out of scope here) — AIH owns this one dedicated file entirely, unlike claude's shared settings.json.
  if (provider === 'grok') return path.join(homeDir, '.grok', 'hooks', 'aih-session-sync.json');
  return '';
}

function getCodexConfigTomlTarget(options = {}) {
  const homeDir = normalizeText(options.homeDir) || '~';
  return path.join(homeDir, '.codex', 'config.toml');
}

function buildProviderSessionHookConfigPatch(providerRaw, existingConfig = {}, options = {}) {
  const provider = normalizeProvider(providerRaw);
  if (!isProviderSessionHookSupported(provider)) {
    return { ok: false, error: 'unsupported_provider', provider };
  }
  if (provider === 'opencode') {
    return buildOpenCodePluginPatch(options);
  }

  const built = provider === 'agy'
    ? buildAgyHooksConfig(existingConfig, options)
    : buildEventHooksConfig(provider, existingConfig, options);
  const changed = JSON.stringify(asObject(existingConfig)) !== JSON.stringify(built.config);

  return {
    ok: true,
    provider,
    targetPath: getProviderHookConfigTarget(provider, options),
    targetKind: HOOKS_JSON_TARGET_PROVIDERS.has(provider) ? 'hooks.json' : 'settings.json',
    changed,
    ...built
  };
}

function eventHookHasManagedHandler(groups, provider) {
  return asArray(groups).some((group) =>
    asArray(group && group.hooks).some((hook) => isManagedHandler(hook, provider))
  );
}

function diagnoseProviderSessionHookConfig(providerRaw, config = {}, options = {}) {
  const provider = normalizeProvider(providerRaw);
  if (!isProviderSessionHookSupported(provider)) {
    return {
      supported: false,
      provider,
      reason: 'unsupported_provider',
      syncMode: getProviderSessionSyncMode(provider),
      installed: false,
      missingEvents: [],
      events: []
    };
  }
  if (provider === 'opencode') {
    return { ...diagnoseOpenCodePluginHook(options), syncMode: 'hook' };
  }

  const events = normalizeEvents(provider, options.events);
  const targetPath = getProviderHookConfigTarget(provider, options);
  if (provider === 'agy') {
    const hookName = normalizeText(options.hookName) || AGY_MANAGED_HOOK_NAME;
    const hookDefinition = asObject(asObject(config)[hookName]);
    const disabled = hookDefinition.enabled === false;
    const missingEvents = events.filter((eventName) => !agyEventHasManagedHandler(hookDefinition[eventName], provider));
    return {
      supported: true,
      provider,
      targetPath,
      targetKind: 'hooks.json',
      hookName,
      syncMode: 'hook',
      installed: !disabled && missingEvents.length === 0,
      disabled,
      missingEvents,
      events
    };
  }

  const hooks = asObject(asObject(config).hooks);
  const missingEvents = events.filter((eventName) => !eventHookHasManagedHandler(hooks[eventName], provider));
  const codexFeatures = provider === 'codex'
    ? diagnoseCodexHooksFeatureConfig(options.codexConfigText, options)
    : null;
  const disabled = Boolean(codexFeatures && codexFeatures.disabled);
  return {
    supported: true,
    provider,
    targetPath,
    targetKind: HOOKS_JSON_TARGET_PROVIDERS.has(provider) ? 'hooks.json' : 'settings.json',
    syncMode: 'hook',
    installed: missingEvents.length === 0 && !disabled,
    disabled,
    missingEvents,
    events,
    ...(codexFeatures ? { codexFeatures } : {})
  };
}

function readJsonFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return {};
  }
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function ensureDirForFile(fs, pathImpl, filePath) {
  const dir = pathImpl.dirname(filePath);
  if (dir && typeof fs.ensureDirSync === 'function') {
    fs.ensureDirSync(dir);
    return;
  }
  if (dir && typeof fs.mkdirSync === 'function') {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJsonFile(fs, pathImpl, filePath, value) {
  ensureDirForFile(fs, pathImpl, filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function enableCodexHooksFeatureInFile(fs, pathImpl, options = {}) {
  const patched = buildCodexHooksFeaturePatch(fs, options);
  if (patched.changed) {
    ensureDirForFile(fs, pathImpl, patched.path);
    fs.writeFileSync(patched.path, patched.content, 'utf8');
  }
  return {
    path: patched.path,
    changed: patched.changed,
    flagName: patched.flagName,
    codexVersion: patched.codexVersion,
    disabledBefore: patched.disabledBefore
  };
}

function buildCodexHooksFeaturePatch(fs, options = {}) {
  const configPath = getCodexConfigTomlTarget(options);
  const before = readTextFileSafe(fs, configPath);
  const beforeState = getCodexHooksFeatureFlagState(before, {
    codexVersion: options.codexVersion
  });
  const shouldPatch = beforeState.explicit
    && (!beforeState.enabled || beforeState.activeFlagName !== beforeState.flagName);
  const patched = shouldPatch
    ? enableCodexHooksFeatureFlag(before, { codexVersion: options.codexVersion })
    : { content: before, flagName: beforeState.flagName, codexVersion: beforeState.codexVersion };
  return {
    path: configPath,
    changed: patched.content !== before,
    flagName: patched.flagName,
    codexVersion: patched.codexVersion,
    content: patched.content,
    disabledBefore: beforeState.disabled
  };
}

function diagnoseCodexHooksFeatureConfig(configText, options = {}) {
  const state = getCodexHooksFeatureFlagState(configText, {
    codexVersion: options.codexVersion
  });
  return {
    path: getCodexConfigTomlTarget(options),
    explicit: state.explicit,
    enabled: state.enabled,
    disabled: state.disabled,
    activeFlagName: state.activeFlagName,
    flagName: state.flagName,
    codexVersion: state.codexVersion
  };
}

function installProviderSessionHookConfig(providerRaw, options = {}) {
  const provider = normalizeProvider(providerRaw);
  if (!isProviderSessionHookSupported(provider)) {
    return { ok: false, error: 'unsupported_provider', provider };
  }
  if (provider === 'opencode') {
    return installOpenCodePluginHook(options);
  }
  const fs = options.fs || require('fs-extra');
  const pathImpl = options.path || path;
  const homeDir = normalizeText(options.homeDir) || require('node:os').homedir();
  const targetPath = getProviderHookConfigTarget(provider, { homeDir });
  const before = readJsonFileSafe(fs, targetPath);
  const patch = buildProviderSessionHookConfigPatch(provider, before, {
    ...options,
    homeDir
  });
  if (!patch.ok) return patch;

  if (!options.dryRun) {
    writeJsonFile(fs, pathImpl, targetPath, patch.config);
  }

  const extra = {};
  if (provider === 'codex') {
    extra.codexFeatures = options.dryRun
      ? (() => {
        const featurePatch = buildCodexHooksFeaturePatch(fs, { ...options, homeDir });
        return {
          path: featurePatch.path,
          changed: featurePatch.changed,
          flagName: featurePatch.flagName,
          codexVersion: featurePatch.codexVersion,
          disabledBefore: featurePatch.disabledBefore
        };
      })()
      : enableCodexHooksFeatureInFile(fs, pathImpl, {
        homeDir,
        codexVersion: options.codexVersion
      });
  }

  return {
    ok: true,
    provider,
    targetPath,
    targetKind: patch.targetKind,
    dryRun: Boolean(options.dryRun),
    changed: patch.changed || Boolean(extra.codexFeatures && extra.codexFeatures.changed),
    events: patch.events,
    ...extra
  };
}

module.exports = {
  AGY_MANAGED_HOOK_NAME,
  DEFAULT_EVENTS_BY_PROVIDER,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_RECEIVER_URL,
  DEFAULT_SENDER_SCRIPT_PATH,
  MANAGED_HOOK_MARKER,
  buildProviderHookReceiverUrl,
  buildProviderSessionHookConfigPatch,
  buildProviderSessionHookSenderCommand,
  diagnoseCodexHooksFeatureConfig,
  diagnoseProviderSessionHookConfig,
  enableCodexHooksFeatureInFile,
  getCodexConfigTomlTarget,
  getProviderHookConfigTarget,
  getProviderSessionSyncMode,
  listInstallableProviderIds,
  installProviderSessionHookConfig,
  isProviderSessionHookSupported,
  isManagedCommand,
  quoteWindowsCommandArg,
  quoteShellArg
};
