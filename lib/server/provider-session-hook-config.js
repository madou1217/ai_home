'use strict';

const path = require('node:path');
const { listProviderDefinitions } = require('../provider-catalog');
const { getProviderCapability } = require('../providers');
const {
  enableCodexHooksFeatureFlag,
  getCodexHooksFeatureFlagState
} = require('../cli/config/codex-feature-flags');
const {
  diagnoseOpenCodePluginHook,
  buildOpenCodePluginPatch,
  installOpenCodePluginHook,
  uninstallOpenCodePluginHook,
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

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeProvider(value) {
  return normalizeText(value).toLowerCase();
}

// Hook 档案（ViewModel）：把「谁支持 hook」交给 Go 合同（sessionSync），把「这种格式怎么落地」
// 交给描述符（capabilities.hooks）—— 这里只做合并，不认识任何 provider 名。
function resolveProviderHookProfile(providerRaw) {
  const provider = normalizeProvider(providerRaw);
  const sync = PROVIDER_SESSION_SYNC_BY_ID[provider] || null;
  const supported = Boolean(sync && sync.mode === 'hook' && sync.adapter);
  const adapterId = supported ? normalizeText(sync.adapter) : '';
  const capability = getProviderCapability(provider, 'hooks');
  // 描述符必须与合同声明同一个 adapter；不一致时以合同为准并只取默认档案
  // （漂移由 test/design-pattern-guard.test.js 的合同一致性用例拦住，不在运行时静默猜）。
  const matches = Boolean(capability && capability.supported === true && capability.adapter === adapterId);
  return Object.freeze({
    provider,
    supported,
    adapterId,
    targetKind: (sync && sync.targetKind) || '',
    target: matches ? capability.target : Object.freeze([]),
    timeoutUnit: matches ? capability.timeoutUnit : 'seconds',
    eventMatchers: matches ? capability.eventMatchers : Object.freeze({}),
    featureFlag: matches ? capability.featureFlag : false,
    capabilityMatches: matches
  });
}

function joinHookTargetPath(profile, homeDir) {
  if (!profile.target || profile.target.length === 0) return '';
  return path.join(homeDir, ...profile.target);
}

// Hook 格式适配器（Strategy Table）：按合同声明的 adapter id 派发，派发处没有 provider 名。
// 每个适配器只回答「这种格式写在哪 / 怎么写 / 怎么诊断 / 怎么安装」，provider 差异来自档案。
const HOOK_ADAPTERS = Object.freeze({
  json_hooks: {
    targetPath: ({ profile, homeDir }) => joinHookTargetPath(profile, homeDir),
    buildPatch: ({ provider, existingConfig, options }) => buildEventHooksConfig(provider, existingConfig, options),
    // 只摘掉带 MANAGED_HOOK_MARKER 的 handler；用户自己的 hook 组原样保留。
    remove: ({ provider, config, options }) => {
      const next = cloneJson(config);
      const cleaned = removeManagedHandlersFromHooksObject(next.hooks, provider);
      if (!cleaned.changed) return { provider, config: next, changed: false, targetKind: 'hooks.json' };
      if (Object.keys(cleaned.hooks).length > 0) next.hooks = cleaned.hooks;
      else delete next.hooks;
      return { provider, config: next, changed: true, targetKind: 'hooks.json' };
    },
    diagnose: ({ profile, provider, config, options }) => {
      const events = normalizeEvents(provider, options.events);
      const missingEvents = events.filter((eventName) =>
        !eventHookHasManagedHandler(asObject(asObject(config).hooks)[eventName], provider));
      const codexFeatures = profile.featureFlag
        ? diagnoseCodexHooksFeatureConfig(options.codexConfigText, options)
        : null;
      const disabled = Boolean(codexFeatures && codexFeatures.disabled);
      return {
        supported: true,
        provider,
        targetPath: getProviderHookConfigTarget(provider, options),
        targetKind: profile.targetKind,
        syncMode: 'hook',
        installed: missingEvents.length === 0 && !disabled,
        disabled,
        missingEvents,
        events,
        ...(codexFeatures ? { codexFeatures } : {})
      };
    }
  },
  agy_named_hooks: {
    targetPath: ({ profile, homeDir }) => joinHookTargetPath(profile, homeDir),
    buildPatch: ({ provider, existingConfig, options }) => buildAgyHooksConfig(existingConfig, { ...options, provider }),
    // 命名 hook 是整块删除：只移除 AIH 那一个具名对象，其它 hook 名称原样保留。
    remove: ({ provider, config, options }) => {
      const hookName = normalizeText(options.hookName) || AGY_MANAGED_HOOK_NAME;
      const next = cloneJson(config);
      const changed = Object.prototype.hasOwnProperty.call(next, hookName);
      if (changed) delete next[hookName];
      return { provider, config: next, changed, targetKind: 'hooks.json' };
    },
    diagnose: ({ provider, config, options }) => {
      const events = normalizeEvents(provider, options.events);
      const hookName = normalizeText(options.hookName) || AGY_MANAGED_HOOK_NAME;
      const hookDefinition = asObject(asObject(config)[hookName]);
      const disabled = hookDefinition.enabled === false;
      const missingEvents = events.filter((eventName) => !agyEventHasManagedHandler(hookDefinition[eventName], provider));
      return {
        supported: true,
        provider,
        targetPath: getProviderHookConfigTarget(provider, options),
        targetKind: 'hooks.json',
        hookName,
        syncMode: 'hook',
        installed: !disabled && missingEvents.length === 0,
        disabled,
        missingEvents,
        events
      };
    }
  },
  opencode_plugin: {
    targetPath: ({ homeDir }) => getOpenCodePluginPath({ homeDir }),
    // 插件桥的补丁结果自成形状（不是 hooks.json），因此不套通用包装。
    patchIsRaw: true,
    buildPatch: ({ options }) => buildOpenCodePluginPatch(options),
    diagnose: ({ options }) => ({ ...diagnoseOpenCodePluginHook(options), syncMode: 'hook' }),
    install: ({ options }) => installOpenCodePluginHook(options),
    uninstall: ({ options }) => uninstallOpenCodePluginHook(options)
  }
});

function getHookAdapter(adapterId) {
  const id = normalizeText(adapterId);
  return Object.prototype.hasOwnProperty.call(HOOK_ADAPTERS, id) ? HOOK_ADAPTERS[id] : null;
}

function isProviderSessionHookSupported(providerRaw) {
  return resolveProviderHookProfile(providerRaw).supported;
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
  // 超时单位由描述符档案声明（毫秒 / 秒），不是按 provider 名判断。
  const timeout = resolveProviderHookProfile(provider).timeoutUnit === 'ms'
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
  const matcher = resolveProviderHookProfile(provider).eventMatchers[eventName];
  if (matcher) group.matcher = matcher;
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
  const provider = normalizeProvider(options.provider) || 'agy';
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

// 目标路径由适配器 + 描述符档案（homeDir 相对路径段）解析；档案缺失时返回 ''（fail closed，
// 绝不写到猜出来的位置）。
function getProviderHookConfigTarget(providerRaw, options = {}) {
  const profile = resolveProviderHookProfile(providerRaw);
  const homeDir = normalizeText(options.homeDir) || '~';
  const adapter = getHookAdapter(profile.adapterId);
  if (!adapter) return '';
  return adapter.targetPath({ profile, homeDir, options });
}

function getCodexConfigTomlTarget(options = {}) {
  const homeDir = normalizeText(options.homeDir) || '~';
  return path.join(homeDir, '.codex', 'config.toml');
}

function buildProviderSessionHookConfigPatch(providerRaw, existingConfig = {}, options = {}) {
  const profile = resolveProviderHookProfile(providerRaw);
  if (!profile.supported) {
    return { ok: false, error: 'unsupported_provider', provider: profile.provider };
  }
  const adapter = getHookAdapter(profile.adapterId);
  if (!adapter) {
    return { ok: false, error: 'unsupported_hook_adapter', provider: profile.provider, adapter: profile.adapterId };
  }
  const built = adapter.buildPatch({ profile, provider: profile.provider, existingConfig, options });
  if (adapter.patchIsRaw) return built;
  const changed = JSON.stringify(asObject(existingConfig)) !== JSON.stringify(built.config);
  return {
    ok: true,
    provider: profile.provider,
    targetPath: getProviderHookConfigTarget(profile.provider, options),
    targetKind: profile.targetKind,
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
  const profile = resolveProviderHookProfile(providerRaw);
  if (!profile.supported) {
    return {
      supported: false,
      provider: profile.provider,
      reason: 'unsupported_provider',
      syncMode: getProviderSessionSyncMode(profile.provider),
      installed: false,
      missingEvents: [],
      events: []
    };
  }
  const adapter = getHookAdapter(profile.adapterId);
  if (!adapter) {
    return {
      supported: false,
      provider: profile.provider,
      reason: 'unsupported_hook_adapter',
      adapter: profile.adapterId,
      syncMode: getProviderSessionSyncMode(profile.provider),
      installed: false,
      missingEvents: [],
      events: []
    };
  }
  return adapter.diagnose({ profile, provider: profile.provider, config, options });
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
  const profile = resolveProviderHookProfile(provider);
  const adapter = getHookAdapter(profile.adapterId);
  if (!adapter) {
    return { ok: false, error: 'unsupported_hook_adapter', provider, adapter: profile.adapterId };
  }
  if (adapter.install) return adapter.install({ profile, provider, options });
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
  if (profile.featureFlag) {
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

// 卸载与安装对称：只撤销 AIH 托管的部分，用户自建 hook / 其它配置键保持不变。
function uninstallProviderSessionHookConfig(providerRaw, options = {}) {
  const provider = normalizeProvider(providerRaw);
  if (!isProviderSessionHookSupported(provider)) {
    return { ok: false, error: 'unsupported_provider', provider };
  }
  const profile = resolveProviderHookProfile(provider);
  const adapter = getHookAdapter(profile.adapterId);
  if (!adapter) {
    return { ok: false, error: 'unsupported_hook_adapter', provider, adapter: profile.adapterId };
  }
  if (typeof adapter.uninstall === 'function') {
    return adapter.uninstall({ profile, provider, options });
  }
  if (typeof adapter.remove !== 'function') {
    return { ok: false, error: 'hook_uninstall_unsupported', provider, adapter: profile.adapterId };
  }
  const fs = options.fs || require('fs-extra');
  const pathImpl = options.path || path;
  const homeDir = normalizeText(options.homeDir) || require('node:os').homedir();
  const targetPath = getProviderHookConfigTarget(provider, { homeDir });
  if (!targetPath) return { ok: false, error: 'hook_target_missing', provider };
  const removed = adapter.remove({
    profile,
    provider,
    config: readJsonFileSafe(fs, targetPath),
    options
  });
  if (removed.changed && !options.dryRun) {
    writeJsonFile(fs, pathImpl, targetPath, removed.config);
  }
  return {
    ok: true,
    provider,
    targetPath,
    targetKind: removed.targetKind,
    changed: removed.changed,
    dryRun: Boolean(options.dryRun)
  };
}

module.exports = {
  AGY_MANAGED_HOOK_NAME,
  resolveProviderHookProfile,
  getHookAdapter,
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
  uninstallProviderSessionHookConfig,
  isProviderSessionHookSupported,
  isManagedCommand,
  quoteWindowsCommandArg,
  quoteShellArg
};
