'use strict';

// WebUI：应用（CLI 工具）启动权限设置。
//
// 路径：
//   GET/PUT /v0/webui/toolkit/apps/:appId/settings
//   GET/PUT /v0/webui/toolkit/apps/:appId/accounts/:accountRef/settings   （账户级，优先级更高）
//
// `applyToHost=true` 时把最大权限写进宿主 CLI 自己的配置文件；写入走 Provider 配置
// 工作台的唯一写入口（校验 + 冲突检测 + 历史备份），失败时设置本身也不落盘。
const {
  ProviderConfigError
} = require('../cli/services/toolkit/provider-config-manager');
const {
  applyHostPermission,
  describeHostPermissionTarget
} = require('../cli/services/toolkit/permission-host-config');
const {
  describeToolPermission
} = require('../cli/services/toolkit/tool-permission-launch');
const {
  describePermissionCatalog,
  validatePermissionArgs
} = require('../providers/permission-flag-catalog');
const {
  getToolPermissionSettings,
  saveToolPermissionSettings
} = require('../cli/services/toolkit/tool-app-settings');
const { isKnownProvider, getProviderMenuLabel } = require('../provider-catalog');
const { isAccountRef } = require('../account/public-account-ref');
const { isProviderSessionHookSupported, installProviderSessionHookConfig } = require('./provider-session-hook-config');
const { buildProviderSessionHookDiagnostic } = require('./webui-provider-hook-routes');

const ROUTE_PREFIX = '/v0/webui/toolkit/apps/';
const ROUTE_SUFFIX = '/settings';

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req, maxBytes = 64 * 1024) {
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
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function buildOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    ...deps,
    ...ctx,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    os: ctx.os || deps.os,
    processObj: ctx.processObj || deps.processObj,
    spawnSync: ctx.spawnSync || deps.spawnSync,
    hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
    env: ctx.env || deps.env
  };
}

/**
 * 解析路径。两种形态：
 *   /v0/webui/toolkit/apps/<provider>/settings                     → provider 级
 *   /v0/webui/toolkit/apps/<provider>/accounts/<ref>/settings      → 账户级
 * 返回 { provider, accountRef }；不合法返回 null。accountRef 为空 = provider 级。
 */
function resolveScope(pathname) {
  const cleanPath = String(pathname || '').split('?')[0].split('#')[0];
  if (!cleanPath.startsWith(ROUTE_PREFIX) || !cleanPath.endsWith(ROUTE_SUFFIX)) return null;
  const inner = cleanPath.slice(ROUTE_PREFIX.length, -ROUTE_SUFFIX.length);
  if (!inner) return null;
  const segments = inner.split('/');
  try {
    if (segments.length === 1) {
      const provider = decodeURIComponent(segments[0]);
      return provider ? { provider, accountRef: '' } : null;
    }
    // accounts/<ref>：账户级设置只作用于一个账号
    if (segments.length === 3 && segments[1] === 'accounts') {
      const provider = decodeURIComponent(segments[0]);
      const accountRef = decodeURIComponent(segments[2]);
      if (!provider || !isAccountRef(accountRef)) return null;
      return { provider, accountRef };
    }
    return null;
  } catch (_error) {
    return null;
  }
}

/** 旧名保留：只关心 provider 的调用方（能力探测等）继续可用。 */
function resolveAppId(pathname) {
  const scope = resolveScope(pathname);
  return scope ? scope.provider : '';
}

function sendError(res, error) {
  const code = error instanceof ProviderConfigError
    ? error.code
    : String(error && error.code || '').trim();
  const message = String(error && error.message || error || '启动权限请求失败');
  const statusByCode = {
    provider_config_unknown_file: 404,
    provider_config_not_found: 404,
    provider_config_conflict: 409,
    provider_config_validation_failed: 422,
    provider_config_too_large: 413,
    provider_config_not_writable: 403,
    provider_config_read_failed: 500,
    provider_config_save_failed: 500,
    unsupported_app: 400,
    invalid_permission_payload: 400,
    apply_to_host_requires_max_permission: 400,
    account_scope_cannot_apply_to_host: 400,
    permission_args_requires_max_permission: 400,
    permission_args_invalid: 400,
    // 会话 Hook：不支持 = 客户端选了不该选的；写入失败 = 服务端动作没成。
    unsupported_session_hook: 400,
    session_hook_install_failed: 500,
    tool_permission_settings_write_failed: 500
  };
  const status = statusByCode[code]
    || (message === 'Body too large' ? 413 : error instanceof SyntaxError ? 400 : 500);
  jsonResponse(res, status, {
    ok: false,
    error: code || 'tool_permission_request_failed',
    message,
    ...(error && error.validation ? { validation: error.validation } : {})
  });
}

function describeCapability(provider, options) {
  const described = describeToolPermission({ provider, ...options });
  const profile = described.profile;
  let host = { supported: false, reason: 'host_profile_unsupported' };
  try {
    const target = describeHostPermissionTarget(provider, options);
    host = target.supported
      ? {
        supported: true,
        fileId: target.fileId,
        displayPath: target.displayPath,
        exists: target.exists,
        writable: target.writable,
        requiresElevation: target.requiresElevation
      }
      : { supported: false, reason: target.reason };
  } catch (error) {
    host = {
      supported: false,
      reason: String(error && error.code || 'host_config_unavailable'),
      message: String(error && error.message || '')
    };
  }
  return {
    maxSupported: profile.maxSupported,
    maxArgs: profile.maxArgs,
    maxReason: profile.maxSupported
      ? ''
      : `${getProviderMenuLabel(provider)} 尚未声明免确认参数，启动时保持原生确认`,
    // 全量权限参数目录：旗标 / 取值枚举 / 中文说明 / 用法示例 / 互斥关系。
    // 前端只渲染这份数据、不自己维护 provider 名单。
    permissionCatalog: describePermissionCatalog(provider),
    hostSupported: host.supported,
    hostFileId: host.fileId || '',
    hostDisplayPath: host.displayPath || '',
    hostExists: host.exists === true,
    hostWritable: host.writable === true,
    hostRequiresElevation: host.requiresElevation === true,
    hostReason: host.supported ? '' : (host.reason || 'host_profile_unsupported'),
    ...describeSessionHookCapability(provider, options)
  };
}

/**
 * 会话 Hook（「即时刷新」）这一项的现状。
 *
 * 这里复用 provider-hooks 那条只读诊断——它已经把「支不支持、装没装、缺哪些事件、
 * 目标配置文件在哪」都算好了。设置面板只额外需要知道「这个 provider 有没有 Hook」，
 * 好决定要不要显示这个开关。
 */
function describeSessionHookCapability(provider, options) {
  const supported = isProviderSessionHookSupported(provider);
  if (!supported) {
    return {
      sessionHookSupported: false,
      sessionHookInstalled: false,
      sessionHookTargetPath: '',
      sessionHookReason: 'unsupported_provider'
    };
  }
  try {
    const diagnostic = buildProviderSessionHookDiagnostic(provider, {
      fs: options.fs,
      path: options.path,
      homeDir: options.hostHomeDir || options.homeDir,
      receiverUrl: options.providerHookReceiverUrl,
      senderScriptPath: options.providerHookSenderScriptPath,
      codexClientVersion: options.codexClientVersion
    });
    return {
      sessionHookSupported: diagnostic.supported !== false,
      sessionHookInstalled: diagnostic.installed === true,
      sessionHookTargetPath: diagnostic.targetPath || '',
      sessionHookReason: diagnostic.reason || ''
    };
  } catch (error) {
    // 诊断读不出来不该让整个设置面板打不开：只是这个开关暂时没有现状可显示。
    return {
      sessionHookSupported: true,
      sessionHookInstalled: false,
      sessionHookTargetPath: '',
      sessionHookReason: String(error && error.code || 'session_hook_diagnose_failed')
    };
  }
}

/**
 * 把「让 aih 接管会话 Hook」这个选择落到实处。
 *
 * 语义刻意不是「开 = 装、关 = 卸」：
 *   - **打开**：现在就装一次（用户点开关的当下就该生效），之后升级时 Hook 掉了
 *     会装回去（hook-survival.js 读同一份设置）。
 *   - **关闭**：只停掉 aih 的接管与后续恢复**行为**，不主动删除配置里已有的 Hook。
 *     删除会改写用户的全局 CLI 配置，而用户关掉这个开关的意图通常只是「别再动我的
 *     东西」，不是「把已经装好的拆掉」。真要拆，用户可以去 CLI 自己的配置里删。
 */
function applySessionHookSetting(provider, enabled, options) {
  if (!enabled) {
    return { ok: true, changed: false, enabled: false, action: 'kept_existing_hook' };
  }
  if (!isProviderSessionHookSupported(provider)) {
    throw Object.assign(new Error('该应用没有可用的官方会话 Hook'), {
      code: 'unsupported_session_hook'
    });
  }
  const homeDir = options.hostHomeDir || options.homeDir;
  const result = installProviderSessionHookConfig(provider, {
    fs: options.fs,
    path: options.path,
    homeDir,
    receiverUrl: options.providerHookReceiverUrl,
    senderScriptPath: options.providerHookSenderScriptPath,
    codexVersion: options.codexClientVersion
  });
  if (!result || !result.ok) {
    throw Object.assign(new Error('写入会话 Hook 配置失败'), {
      code: 'session_hook_install_failed',
      detail: (result && (result.error || result.reason)) || ''
    });
  }
  return {
    ok: true,
    changed: result.changed === true,
    enabled: true,
    action: 'installed'
  };
}

async function handleWebUiToolAppSettingsRoutes(req, res, method, pathname, ctx = {}) {
  const scope = resolveScope(pathname);
  if (!scope) return false;
  const provider = scope.provider.trim().toLowerCase();
  // 账户级作用域：只作用于这一个账号，优先级高于 provider 级（见 tool-app-settings）。
  const accountRef = scope.accountRef || '';
  const options = buildOptions(ctx);
  const scopeOptions = accountRef ? { ...options, accountRef } : options;
  try {
    if (!isKnownProvider(provider)) {
      throw Object.assign(new Error('未登记该应用'), { code: 'unsupported_app' });
    }
    if (method === 'GET') {
      const settings = getToolPermissionSettings(provider, options.fs, options.aiHomeDir, scopeOptions);
      jsonResponse(res, 200, {
        ok: true,
        appId: provider,
        provider,
        accountRef,
        label: getProviderMenuLabel(provider),
        settings,
        capability: describeCapability(provider, options)
      });
      return true;
    }
    if (method === 'PUT') {
      const body = await parseJsonBody(req);
      if (typeof body.maxPermission !== 'boolean') {
        throw Object.assign(new Error('maxPermission 必须是布尔值'), {
          code: 'invalid_permission_payload'
        });
      }
      // applyToHost 只属 provider 级（宿主配置是全局的）。账户级请求不带它，
      // 带了也按 false 处理（下面显式拒绝 true）。
      if (!accountRef && typeof body.applyToHost !== 'boolean') {
        throw Object.assign(new Error('provider 级设置必须给出 applyToHost 布尔值'), {
          code: 'invalid_permission_payload'
        });
      }
      // 账户级不允许写宿主配置：宿主配置是全局的，按账号写会互相覆盖（applyToHost 只属于 provider 级）。
      if (accountRef && body.applyToHost) {
        throw Object.assign(new Error('账户级设置不能写入宿主配置，请改用 provider 级'), {
          code: 'account_scope_cannot_apply_to_host'
        });
      }
      if (body.applyToHost && !body.maxPermission) {
        throw Object.assign(new Error('关闭最大权限时不能写入宿主配置'), {
          code: 'apply_to_host_requires_max_permission'
        });
      }
      const requestedArgs = body.permissionArgs === undefined ? null : body.permissionArgs;
      if (requestedArgs !== null && !Array.isArray(requestedArgs)) {
        throw Object.assign(new Error('permissionArgs 必须是字符串数组'), {
          code: 'invalid_permission_payload'
        });
      }
      if (requestedArgs && requestedArgs.length && !body.maxPermission) {
        throw Object.assign(new Error('选择具体权限参数时请保持「最大权限」开启'), {
          code: 'permission_args_requires_max_permission'
        });
      }
      const argsValidation = requestedArgs
        ? validatePermissionArgs(provider, requestedArgs)
        : { ok: true, unknown: [], conflicts: [] };
      if (!argsValidation.ok) {
        const detail = [
          ...argsValidation.conflicts.map((item) => item.message),
          ...argsValidation.unknown.map((item) => `未登记或取值非法的参数：${item}`)
        ].join('；');
        throw Object.assign(new Error(detail || '启动权限参数不合法'), {
          code: 'permission_args_invalid',
          validation: argsValidation
        });
      }
      const wantsHostApply = !accountRef && body.applyToHost === true;
      let hostApply = null;
      if (wantsHostApply) {
        hostApply = applyHostPermission(provider, options);
        if (!hostApply.supported) {
          throw Object.assign(new Error('该 CLI 尚未登记可写入的宿主权限字段'), {
            code: 'unsupported_app'
          });
        }
      }
      // 会话 Hook 与启动权限是两件事，可以分开设置；这里只在请求显式带了 sessionHook
      // 时才动它，免得改启动权限顺手改了 Hook 的接管状态。
      const wantsSessionHook = body.sessionHook === undefined ? null : body.sessionHook === true;
      let sessionHookApply = null;
      if (wantsSessionHook !== null) {
        sessionHookApply = applySessionHookSetting(provider, wantsSessionHook, options);
      }
      // 账户级作用域只记「用户在这个账号上显式设过什么」：把 applyToHost 这类没出现的
      // 字段也按 false 写进去，会让账户级永久压过 provider 级，之后改 provider 级对
      // 这个账号不再生效（见 normalizeAccountOverride 的注释）。provider 级则照旧写全。
      const patch = accountRef
        ? {
          ...(body.maxPermission !== undefined ? { maxPermission: body.maxPermission } : {}),
          ...(body.applyToHost !== undefined ? { applyToHost: body.applyToHost } : {}),
          ...(requestedArgs ? { permissionArgs: requestedArgs } : {}),
          ...(wantsSessionHook === null ? {} : { sessionHook: wantsSessionHook })
        }
        : {
          maxPermission: body.maxPermission,
          applyToHost: body.applyToHost,
          ...(requestedArgs ? { permissionArgs: requestedArgs } : {}),
          ...(wantsSessionHook === null ? {} : { sessionHook: wantsSessionHook })
        };
      const settings = saveToolPermissionSettings(provider, patch, options.fs, options.aiHomeDir, scopeOptions);
      jsonResponse(res, 200, {
        ok: true,
        appId: provider,
        provider,
        accountRef,
        label: getProviderMenuLabel(provider),
        settings,
        capability: describeCapability(provider, options),
        hostApply,
        sessionHookApply
      });
      return true;
    }
    jsonResponse(res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET / PUT' });
    return true;
  } catch (error) {
    sendError(res, error);
    return true;
  }
}

module.exports = {
  ROUTE_PREFIX,
  ROUTE_SUFFIX,
  handleWebUiToolAppSettingsRoutes,
  resolveScope,
  resolveAppId
};
