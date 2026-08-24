'use strict';

const {
  listManagedApps,
  refreshManagedAppVersion,
  installAppHooks,
  openManagedDesktopApp
} = require('../cli/services/toolkit/app-manager');
const { readDefaultAccountRef } = require('../account/default-account-store');
const { checkManagedAppUpdate } = require('../cli/services/toolkit/app-update-checker');
const {
  createWebUiAccountAppLauncher,
  resolveAccountAppErrorMessage,
  resolveAccountAppErrorStatus
} = require('./webui-account-routes');
const {
  launchAccountAppWithEgress,
  pickZcodeEgressDependencies
} = require('./zcode-egress-service');
const { startAppInstallJob, getAppInstallJobManager } = require('./webui-app-install-routes');
const {
  getMirrorsStatus,
  setNpmRegistry,
  setPipIndexUrl,
  testEndpointLatency
} = require('../cli/services/toolkit/mirror-manager');
const {
  getProxyStatus,
  setGitProxy,
  setNpmProxy,
  testConnectivity
} = require('../cli/services/toolkit/proxy-manager');
const { detectNetworkLayer } = require('../cli/services/toolkit/system-network-manager');
const {
  ToolkitConfigError,
  readManagedAppConfig,
  saveManagedAppConfig
} = require('../cli/services/toolkit/config-editor');
const {
  listManagedTools,
  readManagedToolConfig,
  saveManagedToolConfig
} = require('../cli/services/toolkit/tool-manager');
const {
  handleWebUiProxyPoolRoutes
} = require('./webui-proxy-pool-routes');
const { handleWebUiManagedToolRoutes } = require('./webui-managed-tool-routes');

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function buildToolkitOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    ...ctx,
    ...deps,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    os: ctx.os || deps.os,
    processObj: ctx.processObj || deps.processObj,
    spawnSync: ctx.spawnSync || deps.spawnSync,
    spawn: ctx.spawn || deps.spawn,
    requestAdapter: ctx.requestAdapter || deps.requestAdapter,
    connectivityTargets: ctx.connectivityTargets || deps.connectivityTargets,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir
  };
}

function resolveToolkitAccountRef(toolkitOptions, provider, requestedAccountRef, options = {}) {
  if (options.unscoped === true) return '';
  const explicitAccountRef = String(requestedAccountRef || '').trim();
  if (explicitAccountRef) return explicitAccountRef;
  return readDefaultAccountRef(toolkitOptions.fs, toolkitOptions.aiHomeDir, provider);
}

function serviceResultStatus(result) {
  if (result && result.ok) return 200;
  const error = String(result && result.error || '');
  if (result && Number.isInteger(result.exitCode) && result.exitCode !== 0) return 502;
  if (error === 'confirmation_required') return 428;
  if (error === 'environment_action_timeout') return 504;
  if (error === 'environment_action_failed' || error === 'proxy_config_failed' || /config_failed$/.test(error)) return 502;
  if (
    error.startsWith('invalid_')
    || error.startsWith('unsupported_')
    || error === 'interactive_shell_action_unsupported'
  ) return 400;
  return 500;
}

function sendToolkitError(res, error) {
  const code = error instanceof ToolkitConfigError
    ? error.code
    : String(error && error.code || '').trim();
  const message = String(error && error.message || error || 'Toolkit 请求失败');
  const statusByCode = {
    config_not_found: 404,
    config_conflict: 409,
    config_target_changed: 409,
    config_target_ambiguous: 409,
    config_target_unresolved: 409,
    config_read_failed: 500,
    config_save_failed: 500,
    config_too_large: 413,
    unsupported_app: 400,
    unsupported_tool: 400,
    tool_config_unsupported: 400,
    config_target_unavailable: 400,
    privilege_unavailable: 403,
    privilege_denied: 403
  };
  const status = statusByCode[code]
    || (message === 'Body too large' ? 413 : error instanceof SyntaxError ? 400 : 500);
  jsonResponse(res, status, {
    ok: false,
    error: code || 'toolkit_request_failed',
    message
  });
}

function resolveConfigAppId(pathname) {
  const prefix = '/v0/webui/toolkit/apps/';
  const suffix = '/config';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return '';
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch (_error) {
    return '';
  }
}

function resolveConfigToolId(pathname) {
  const prefix = '/v0/webui/toolkit/tools/';
  const suffix = '/config';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return '';
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch (_error) {
    return '';
  }
}

/**
 * Routes handler for /v0/webui/toolkit/*
 */
async function handleWebUiToolkitRoutes(req, res, method, pathname, ctx = {}) {
  // Proxy pool sub-routes: /v0/webui/toolkit/proxy-pool/*
  if (pathname.startsWith('/v0/webui/toolkit/proxy-pool')) {
    const handled = await handleWebUiProxyPoolRoutes(req, res, method, pathname, ctx);
    if (handled) return true;
  }

  if (pathname === '/v0/webui/toolkit/tools' || pathname.startsWith('/v0/webui/toolkit/tools/')) {
    const handled = await handleWebUiManagedToolRoutes(req, res, method, pathname, ctx);
    if (handled) return true;
  }

  const configAppId = resolveConfigAppId(pathname);
  if (configAppId && method === 'GET') {
    try {
      const data = readManagedAppConfig(configAppId, buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  if (configAppId && method === 'PUT') {
    try {
      const body = await parseJsonBody(req, 3 * 1024 * 1024);
      if (!body || typeof body.content !== 'string') {
        jsonResponse(res, 400, {
          ok: false,
          error: 'content_required',
          message: '必须提供配置文本内容'
        });
        return true;
      }
      const data = saveManagedAppConfig(configAppId, body.content, {
        ...buildToolkitOptions(ctx),
        expectedRevision: body.revision
      });
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  const configToolId = resolveConfigToolId(pathname);
  if (configToolId && method === 'GET') {
    try {
      const data = readManagedToolConfig(configToolId, buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  if (configToolId && method === 'PUT') {
    try {
      const body = await parseJsonBody(req, 3 * 1024 * 1024);
      if (!body || typeof body.content !== 'string') {
        jsonResponse(res, 400, {
          ok: false,
          error: 'content_required',
          message: '必须提供配置文本内容'
        });
        return true;
      }
      const data = saveManagedToolConfig(configToolId, body.content, {
        ...buildToolkitOptions(ctx),
        expectedRevision: body.revision,
        expectedTargetRevision: body.targetRevision
      });
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/tools') {
    try {
      const data = listManagedTools(buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (error) {
      sendToolkitError(res, error);
    }
    return true;
  }

  // 1. GET /v0/webui/toolkit/apps - list all apps/CLIs
  if (method === 'GET' && pathname === '/v0/webui/toolkit/apps') {
    try {
      const data = await listManagedApps(buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // POST /v0/webui/toolkit/apps/:appId/check-update - manual remote version check
  const checkUpdateMatch = pathname.match(/^\/v0\/webui\/toolkit\/apps\/([^/]+)\/check-update$/);
  if (method === 'POST' && checkUpdateMatch) {
    let appId = '';
    try {
      appId = decodeURIComponent(checkUpdateMatch[1]);
    } catch (_error) {
      jsonResponse(res, 400, { ok: false, error: 'invalid_app_path' });
      return true;
    }
    try {
      const toolkitOptions = buildToolkitOptions(ctx);
      const refreshed = await refreshManagedAppVersion(appId, toolkitOptions);
      if (!refreshed.ok) {
        jsonResponse(res, 404, { ok: false, error: 'app_not_found', appId });
        return true;
      }
      const result = await checkManagedAppUpdate(refreshed.app, toolkitOptions);
      jsonResponse(res, 200, result);
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  // POST /v0/webui/toolkit/apps/:appId/open - open a CLI/Desktop app with an
  // optional accountRef. Without an explicit account, use the Provider default
  // account when one exists; otherwise retain the unscoped host-level launch.
  const openAppMatch = pathname.match(/^\/v0\/webui\/toolkit\/apps\/([^/]+)\/open$/);
  if (method === 'POST' && openAppMatch) {
    let appId = '';
    try {
      appId = decodeURIComponent(openAppMatch[1]);
    } catch (_error) {
      jsonResponse(res, 400, { ok: false, error: 'invalid_app_path' });
      return true;
    }
    try {
      const body = await parseJsonBody(req);
      const kind = String(body.kind || (appId.endsWith('-desktop') ? 'desktop' : 'cli')).trim().toLowerCase();
      const action = String(body.action || 'open').trim().toLowerCase();
      const accountRef = String(body.accountRef || '').trim();
      const unscoped = body.unscoped === true;
      const provider = kind === 'desktop' && appId.endsWith('-desktop')
        ? appId.slice(0, -'-desktop'.length)
        : String(body.provider || appId).trim().toLowerCase();
      const toolkitOptions = buildToolkitOptions(ctx);
      const selectedAccountRef = resolveToolkitAccountRef(toolkitOptions, provider, accountRef, { unscoped });
      let egressWarning = '';
      let result;
      if (selectedAccountRef || kind === 'cli') {
        const launcher = createWebUiAccountAppLauncher(
          toolkitOptions,
          provider,
          selectedAccountRef,
          action
        );
        const launch = await launchAccountAppWithEgress({
          launcher,
          launchInput: {
            provider,
            accountRef: selectedAccountRef,
            kind,
            action,
            terminalId: body.terminalId
          },
          egressInput: {
            fs: toolkitOptions.fs,
            aiHomeDir: toolkitOptions.aiHomeDir,
            processObj: toolkitOptions.processObj || process,
            deps: pickZcodeEgressDependencies(toolkitOptions)
          }
        });
        result = launch.result;
        egressWarning = String(launch.egressWarning || '');
        if (egressWarning) {
          console.warn(`\x1b[33m[aih:webui]\x1b[0m ${provider}/${selectedAccountRef} ${egressWarning}`);
        }
      } else {
        result = openManagedDesktopApp(appId, toolkitOptions);
      }
      if (result.ok) {
        jsonResponse(res, 200, {
          ...result,
          provider,
          accountRef: selectedAccountRef,
          kind,
          ...(egressWarning ? { egressWarning } : {})
        });
        return true;
      }
      if (result.error === 'desktop_not_installed' || result.error === 'cli_not_installed') {
        const manager = getAppInstallJobManager(ctx);
        const installTarget = {
          appId: kind === 'desktop' ? (appId.endsWith('-desktop') ? appId : `${provider}-desktop`) : provider,
          provider,
          kind,
          action: 'install'
        };
        const installAvailable = Boolean(manager && typeof manager.canInstall === 'function'
          && manager.canInstall(installTarget));
        jsonResponse(res, 428, {
          ...result,
          installRequired: true,
          installTarget,
          installAvailable,
          message: installAvailable
            ? (kind === 'desktop' ? '未检测到 Desktop 应用，请确认后开始安装。' : '未检测到原生 CLI，请确认后开始安装。')
            : (kind === 'desktop' ? '当前平台没有可用的自动安装器，请手动安装官方 Desktop 应用后重试。' : '当前 Provider 没有可用的自动安装器，请手动安装原生 CLI 后重试。')
        });
        return true;
      }
      const isBadRequest = result.error === 'unsupported_app'
        || result.error === 'unsupported_kind'
        || result.error === 'unsupported_provider';
      const status = resolveAccountAppErrorStatus(result, isBadRequest ? 400 : 409);
      jsonResponse(res, status, {
        ...result,
        message: resolveAccountAppErrorMessage(result),
        ...(egressWarning ? { egressWarning } : {})
      });
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  // 2. POST /v0/webui/toolkit/apps/install - create a unified async install job
  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/install') {
    try {
      const body = await parseJsonBody(req);
      const appId = body.appId || body.provider || body.providerId;
      if (!appId) {
        jsonResponse(res, 400, { ok: false, error: 'app_required' });
        return true;
      }
      const installInput = {
        appId,
        provider: body.provider || body.providerId,
        kind: body.kind
      };
      if (Object.prototype.hasOwnProperty.call(body, 'action')) {
        installInput.action = body.action;
      }
      const started = startAppInstallJob(ctx, installInput);
      if (!started.ok) {
        jsonResponse(res, 400, { ok: false, error: started.error || 'app_install_unavailable' });
        return true;
      }
      jsonResponse(res, 202, {
        ok: true,
        accepted: true,
        alreadyRunning: Boolean(started.alreadyRunning),
        job: started.job
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 2b. POST /v0/webui/toolkit/apps/plan - preview a lifecycle command
  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/plan') {
    try {
      const body = await parseJsonBody(req);
      const appId = body.appId || body.provider || body.providerId;
      if (!appId) {
        jsonResponse(res, 400, { ok: false, error: 'app_required' });
        return true;
      }
      const manager = getAppInstallJobManager(ctx);
      const action = Object.prototype.hasOwnProperty.call(body, 'action')
        ? body.action
        : 'install';
      const result = manager && typeof manager.plan === 'function'
        ? manager.plan({
          appId,
          provider: body.provider || body.providerId,
          kind: body.kind,
          action
        })
        : { ok: false, error: 'app_install_unavailable' };
      jsonResponse(res, result.ok ? 200 : 400, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 3. POST /v0/webui/toolkit/apps/hooks - install official hooks
  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/hooks') {
    try {
      const body = await parseJsonBody(req);
      const providers = body.providers || (body.provider ? [body.provider] : []);
      if (!providers.length) {
        jsonResponse(res, 400, { ok: false, error: 'providers_required' });
        return true;
      }
      const result = await installAppHooks(providers, buildToolkitOptions(ctx));
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 5. GET /v0/webui/toolkit/mirrors - get npm / pip mirror registries
  if (method === 'GET' && pathname === '/v0/webui/toolkit/mirrors') {
    try {
      const data = await getMirrorsStatus(buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 6. POST /v0/webui/toolkit/mirrors/set - set npm or pip registry
  if (method === 'POST' && pathname === '/v0/webui/toolkit/mirrors/set') {
    try {
      const body = await parseJsonBody(req);
      const { type, url } = body;
      if (type === 'npm') {
        const result = setNpmRegistry(url, buildToolkitOptions(ctx));
        jsonResponse(res, serviceResultStatus(result), result);
        return true;
      }
      if (type === 'pip') {
        const result = setPipIndexUrl(url, buildToolkitOptions(ctx));
        jsonResponse(res, serviceResultStatus(result), result);
        return true;
      }
      jsonResponse(res, 400, { ok: false, error: 'invalid_type_expected_npm_or_pip' });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 7. POST /v0/webui/toolkit/mirrors/ping - ping a mirror URL
  if (method === 'POST' && pathname === '/v0/webui/toolkit/mirrors/ping') {
    try {
      const body = await parseJsonBody(req);
      const url = body.url;
      if (!url) {
        jsonResponse(res, 400, { ok: false, error: 'url_required' });
        return true;
      }
      const ping = await testEndpointLatency(url, buildToolkitOptions(ctx));
      jsonResponse(res, ping.error === 'invalid_url' ? 400 : 200, ping);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 8. GET /v0/webui/toolkit/proxy - get proxy status
  if (method === 'GET' && pathname === '/v0/webui/toolkit/proxy') {
    try {
      const data = getProxyStatus(buildToolkitOptions(ctx));
      jsonResponse(res, 200, data);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 9. POST /v0/webui/toolkit/proxy/set - set git / npm proxy
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy/set') {
    try {
      const body = await parseJsonBody(req);
      const { target, proxyUrl } = body;
      if (target === 'git') {
        const result = setGitProxy(proxyUrl, buildToolkitOptions(ctx));
        jsonResponse(res, serviceResultStatus(result), result);
        return true;
      }
      if (target === 'npm') {
        const result = setNpmProxy(proxyUrl, buildToolkitOptions(ctx));
        jsonResponse(res, serviceResultStatus(result), result);
        return true;
      }
      jsonResponse(res, 400, { ok: false, error: 'invalid_target_expected_git_or_npm' });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 10. GET /v0/webui/toolkit/connectivity - test upstream AI connectivity
  if (method === 'GET' && pathname === '/v0/webui/toolkit/connectivity') {
    try {
      const requestUrl = new URL(req.url || pathname, 'http://localhost');
      const toolkitOptions = buildToolkitOptions(ctx);
      const data = await testConnectivity({
        route: requestUrl.searchParams.get('route') || 'direct',
        proxyUrl: requestUrl.searchParams.get('proxyUrl') || ''
      }, toolkitOptions);
      jsonResponse(res, serviceResultStatus(data), {
        ...data,
        networkLayer: detectNetworkLayer(toolkitOptions)
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = {
  handleWebUiToolkitRoutes
};
