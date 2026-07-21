'use strict';

const { getRealHome } = require('../sessions/session-reader');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  buildProviderSessionHookConfigPatch,
  diagnoseProviderSessionHookConfig,
  getCodexConfigTomlTarget,
  getProviderHookConfigTarget,
  installProviderSessionHookConfig
} = require('./provider-session-hook-config');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function readJsonFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return {};
  }
}

function fileExists(fs, filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch (_error) {
    return false;
  }
}

function isWritableTarget(fs, pathImpl, targetPath) {
  try {
    if (!targetPath) return false;
    if (fs.existsSync(targetPath)) {
      fs.accessSync(targetPath, fs.constants ? fs.constants.W_OK : 2);
      return true;
    }
    const dir = pathImpl.dirname(targetPath);
    if (!fs.existsSync(dir)) return false;
    fs.accessSync(dir, fs.constants ? fs.constants.W_OK : 2);
    return true;
  } catch (_error) {
    return false;
  }
}

function buildSyncFlow(direction, status, mechanism, note) {
  return Object.freeze({
    direction,
    status,
    mechanism,
    note
  });
}

const PROVIDER_SESSION_SYNC_CAPABILITIES = Object.freeze({
  codex: Object.freeze({
    sourceHook: Object.freeze({
      available: true,
      kind: 'official-hook',
      configTarget: 'hooks.json',
      defaultEvents: Object.freeze(['SessionStart', 'UserPromptSubmit', 'Stop'])
    }),
    sink: Object.freeze({
      available: true,
      kind: 'app-server-proxy',
      scope: 'live-thread-status-refresh',
      note: 'Codex App/VSCode app-server clients refresh by receiving thread/status/changed and reading the real thread.'
    }),
    flows: Object.freeze([
      buildSyncFlow(
        'cli-to-web',
        'available',
        'official-hook -> session-event-bus -> web-sse -> transcript-read',
        'CLI updates notify Web when provider hooks are installed; Web still reads the real session transcript.'
      ),
      buildSyncFlow(
        'web-to-native',
        'conditional',
        'native-session-chat -> session-event-bus -> codex-session-queue -> app-server-proxy',
        'Refreshes Codex App/VSCode only for the same live thread that is already open; it does not open hidden threads.'
      ),
      buildSyncFlow(
        'native-to-web',
        'available',
        'app-server-proxy lifecycle -> provider-hook-receiver -> session-event-bus -> web-sse',
        'Codex App/VSCode lifecycle notifications dirty the Web view, which then reads the real thread.'
      )
    ])
  }),
  claude: Object.freeze({
    sourceHook: Object.freeze({
      available: true,
      kind: 'official-hook',
      configTarget: 'settings.json',
      defaultEvents: Object.freeze(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'])
    }),
    sink: Object.freeze({
      available: false,
      kind: '',
      fallback: 'session-event-bus-watch-reader',
      note: 'No confirmed local Claude Code client refresh sink equivalent to Codex app-server notifications.'
    }),
    flows: Object.freeze([
      buildSyncFlow(
        'cli-to-web',
        'available',
        'official-hook -> session-event-bus -> web-sse -> transcript-read',
        'CLI updates notify Web when Claude hooks are installed; Web still reads the real transcript.'
      ),
      buildSyncFlow(
        'web-to-native',
        'fallback',
        'session-event-bus/watch-reader',
        'No confirmed Claude local App/VSCode refresh sink is used; native clients refresh only by their own transcript/session behavior.'
      ),
      buildSyncFlow(
        'native-to-web',
        'available',
        'official-hook -> session-event-bus -> web-sse -> transcript-read',
        'Native Claude CLI/IDE sessions can dirty Web through official hooks once installed.'
      )
    ])
  }),
  gemini: Object.freeze({
    sourceHook: Object.freeze({
      available: true,
      kind: 'official-hook',
      configTarget: 'settings.json',
      defaultEvents: Object.freeze(['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd'])
    }),
    sink: Object.freeze({
      available: false,
      kind: '',
      fallback: 'session-event-bus-watch-reader',
      note: 'No confirmed Gemini CLI/App refresh sink equivalent to Codex app-server notifications.'
    }),
    flows: Object.freeze([
      buildSyncFlow(
        'cli-to-web',
        'available',
        'official-hook -> session-event-bus -> web-sse -> session-read',
        'CLI updates notify Web when Gemini hooks are installed; Web still reads provider session data.'
      ),
      buildSyncFlow(
        'web-to-native',
        'fallback',
        'session-event-bus/watch-reader',
        'No confirmed Gemini native refresh sink is used.'
      ),
      buildSyncFlow(
        'native-to-web',
        'available',
        'official-hook -> session-event-bus -> web-sse -> session-read',
        'Native Gemini CLI sessions can dirty Web through official hooks once installed.'
      )
    ])
  }),
  agy: Object.freeze({
    sourceHook: Object.freeze({
      available: true,
      kind: 'official-hook',
      configTarget: 'hooks.json',
      defaultEvents: Object.freeze(['PreInvocation', 'PostInvocation', 'Stop'])
    }),
    sink: Object.freeze({
      available: false,
      kind: '',
      fallback: 'session-event-bus-watch-reader',
      note: 'Antigravity hooks are confirmed as event source; no confirmed IDE refresh sink is used.'
    }),
    flows: Object.freeze([
      buildSyncFlow(
        'cli-to-web',
        'available',
        'official-hooks.json -> session-event-bus -> web-sse -> transcript-read',
        'Agy CLI/Antigravity updates notify Web when hooks are installed; Web still reads the real transcript.'
      ),
      buildSyncFlow(
        'web-to-native',
        'fallback',
        'session-event-bus/watch-reader',
        'No confirmed Antigravity IDE refresh sink is used.'
      ),
      buildSyncFlow(
        'native-to-web',
        'available',
        'official-hooks.json -> session-event-bus -> web-sse -> transcript-read',
        'Antigravity sessions can dirty Web through official hooks once installed.'
      )
    ])
  })
});

function getProviderSessionSyncCapabilities(provider) {
  return PROVIDER_SESSION_SYNC_CAPABILITIES[normalizeText(provider).toLowerCase()] || {
    sourceHook: { available: false },
    sink: { available: false }
  };
}

function buildProviderSessionHookDiagnostic(provider, deps = {}) {
  const fs = deps.fs || require('fs-extra');
  const pathImpl = deps.path || require('node:path');
  const homeDir = normalizeText(deps.homeDir) || getRealHome();
  const targetPath = getProviderHookConfigTarget(provider, { homeDir });
  const config = readJsonFileSafe(fs, targetPath);
  const codexConfigText = provider === 'codex'
    ? (() => {
      const configPath = getCodexConfigTomlTarget({ homeDir });
      try {
        if (!fs.existsSync(configPath)) return '';
        return fs.readFileSync(configPath, 'utf8');
      } catch (_error) {
        return '';
      }
    })()
    : '';
  const diagnostic = diagnoseProviderSessionHookConfig(provider, config, {
    homeDir,
    codexConfigText,
    codexVersion: normalizeText(deps.codexClientVersion)
  });
  const patch = buildProviderSessionHookConfigPatch(provider, config, {
    homeDir,
    serverUrl: normalizeText(deps.receiverUrl) || undefined,
    senderScriptPath: normalizeText(deps.senderScriptPath) || undefined
  });
  return {
    ...diagnostic,
    sessionSync: getProviderSessionSyncCapabilities(provider),
    configExists: fileExists(fs, targetPath),
    writable: isWritableTarget(fs, pathImpl, targetPath),
    changedIfInstalled: Boolean(patch && patch.ok && patch.changed)
  };
}

async function handleGetProviderHooksRequest(ctx) {
  const { writeJson, deps } = ctx;
  const providers = SUPPORTED_SERVER_PROVIDERS.map((provider) =>
    buildProviderSessionHookDiagnostic(provider, {
      fs: ctx.fs,
      path: deps.path,
      homeDir: deps.hostHomeDir,
      receiverUrl: deps.providerHookReceiverUrl,
      senderScriptPath: deps.providerHookSenderScriptPath,
      codexClientVersion: deps.codexClientVersion
    })
  );
  writeJson(ctx.res, 200, {
    ok: true,
    providers
  });
  return true;
}

async function readJsonPayload(ctx, maxBytes) {
  return ctx.readRequestBody(ctx.req, { maxBytes })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
}

async function handleInstallProviderHooksRequest(ctx) {
  const { writeJson, deps } = ctx;
  const payload = await readJsonPayload(ctx, 64 * 1024);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const dryRun = payload.dryRun === true;
  const confirmed = payload.confirm === true || payload.confirm === 'install-provider-session-hooks';
  if (!dryRun && !confirmed) {
    writeJson(ctx.res, 400, { ok: false, error: 'confirm_required' });
    return true;
  }
  const requestedProviders = Array.isArray(payload.providers)
    ? payload.providers
    : normalizeText(payload.provider)
      ? [payload.provider]
      : [];
  const providers = requestedProviders.map(normalizeText).filter(Boolean);
  if (providers.length === 0) {
    writeJson(ctx.res, 400, { ok: false, error: 'provider_required' });
    return true;
  }
  const homeDir = normalizeText(deps.hostHomeDir) || getRealHome();
  const results = providers.map((provider) =>
    installProviderSessionHookConfig(provider, {
      fs: ctx.fs,
      path: deps.path,
      homeDir,
      receiverUrl: normalizeText(deps.providerHookReceiverUrl),
      senderScriptPath: normalizeText(deps.providerHookSenderScriptPath),
      codexVersion: normalizeText(deps.codexClientVersion),
      dryRun
    })
  );
  const failed = results.filter((result) => !result.ok);
  writeJson(ctx.res, failed.length > 0 ? 400 : 200, {
    ok: failed.length === 0,
    results
  });
  return true;
}

module.exports = {
  buildProviderSessionHookDiagnostic,
  getProviderSessionSyncCapabilities,
  handleGetProviderHooksRequest,
  handleInstallProviderHooksRequest
};
