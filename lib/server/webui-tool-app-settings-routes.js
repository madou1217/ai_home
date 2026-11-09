'use strict';

// WebUI：应用（CLI 工具）启动权限设置。
//
// 路径：
//   GET /v0/webui/toolkit/apps/:appId/settings  → 固定代理 Go 只读模型
//   PUT /v0/webui/toolkit/apps/:appId/settings  → 仍由 Node 写
//
// 边界（不要打破）：
//   * GET 的 settings / capability / 权限目录全部来自 Go
//     （GET /v1/management/webui/tool-apps/{appId}/settings）。Node 不再自己算一份，
//     也没有本地回退：Go 不可用就 503。两份读模型并存只会让页面看到的和 Go 执行的分叉。
//   * PUT 留在 Node：`applyToHost=true` 时要把最大权限写进宿主 CLI 自己的配置文件，
//     写入必须走 Provider 配置工作台的唯一写入口（校验 + 冲突检测 + 历史备份），
//     失败时设置本身也不落盘。它的响应仍用下面的本地组装（写路径，不是第二条读路径）。
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
const { saveToolPermissionSettings } = require('../cli/services/toolkit/tool-app-settings');
const { isKnownProvider, getProviderMenuLabel } = require('../provider-catalog');

const ROUTE_PREFIX = '/v0/webui/toolkit/apps/';
const ROUTE_SUFFIX = '/settings';

const GO_TOOL_SETTINGS_UNAVAILABLE = 'go_core_unavailable';

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

function resolveAppId(pathname) {
  const cleanPath = String(pathname || '').split('?')[0].split('#')[0];
  if (!cleanPath.startsWith(ROUTE_PREFIX) || !cleanPath.endsWith(ROUTE_SUFFIX)) return '';
  const encoded = cleanPath.slice(ROUTE_PREFIX.length, -ROUTE_SUFFIX.length);
  if (!encoded || encoded.includes('/')) return '';
  try {
    return decodeURIComponent(encoded);
  } catch (_error) {
    return '';
  }
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
    permission_args_requires_max_permission: 400,
    permission_args_invalid: 400,
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

function textListOf(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item === undefined || item === null ? '' : item)).filter((item) => item.length > 0)
    : [];
}

function mapCatalogFlag(item) {
  const entry = item && typeof item === 'object' ? item : {};
  return {
    flag: String(entry.flag || ''),
    aliases: textListOf(entry.aliases),
    group: String(entry.group || ''),
    groupLabel: String(entry.groupLabel || ''),
    value: String(entry.value || 'none'),
    options: textListOf(entry.options),
    description: String(entry.description || ''),
    descriptionEn: String(entry.descriptionEn || ''),
    example: String(entry.example || ''),
    configEquivalent: String(entry.configEquivalent || ''),
    note: String(entry.note || '')
  };
}

function mapCatalogRule(item) {
  const entry = item && typeof item === 'object' ? item : {};
  return {
    a: String(entry.a || ''),
    b: String(entry.b || ''),
    message: String(entry.message || '')
  };
}

function mapCatalogOverride(item) {
  const entry = item && typeof item === 'object' ? item : {};
  return {
    by: String(entry.by || ''),
    over: String(entry.over || ''),
    message: String(entry.message || '')
  };
}

function mapToolPermissionCatalog(value) {
  const catalog = value && typeof value === 'object' ? value : {};
  return {
    verifiedCliVersion: String(catalog.verifiedCliVersion || 'none'),
    groups: catalog.groups && typeof catalog.groups === 'object' ? catalog.groups : {},
    flags: (Array.isArray(catalog.flags) ? catalog.flags : []).map(mapCatalogFlag),
    conflicts: (Array.isArray(catalog.conflicts) ? catalog.conflicts : []).map(mapCatalogRule),
    overrides: (Array.isArray(catalog.overrides) ? catalog.overrides : []).map(mapCatalogOverride),
    subcommandsWithoutApprovalFlag: textListOf(catalog.subcommandsWithoutApprovalFlag),
    subcommandsBlockingPermissionOverrides: textListOf(catalog.subcommandsBlockingPermissionOverrides)
  };
}

/**
 * Go 只读模型 → /v0/webui/toolkit/apps/:appId/settings 既有响应契约。
 *
 * 字段名两边本来就一致，但仍然逐字段映射：缺失字段要有稳定默认值，null 与数组形状
 * 不能直接漏给页面。映射只做形状收口，不重新推导任何权限事实。
 */
function mapToolAppSettings(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};
  const capability = source.capability && typeof source.capability === 'object' ? source.capability : {};
  return {
    ok: true,
    appId: String(source.appId || ''),
    provider: String(source.provider || ''),
    label: String(source.label || ''),
    settings: {
      maxPermission: settings.maxPermission !== false,
      applyToHost: settings.applyToHost === true,
      permissionArgs: textListOf(settings.permissionArgs),
      updatedAt: Number.isFinite(Number(settings.updatedAt)) ? Number(settings.updatedAt) : 0
    },
    capability: {
      maxSupported: capability.maxSupported === true,
      maxArgs: textListOf(capability.maxArgs),
      maxReason: String(capability.maxReason || ''),
      permissionCatalog: mapToolPermissionCatalog(capability.permissionCatalog),
      hostSupported: capability.hostSupported === true,
      hostFileId: String(capability.hostFileId || ''),
      hostDisplayPath: String(capability.hostDisplayPath || ''),
      hostExists: capability.hostExists === true,
      hostWritable: capability.hostWritable === true,
      hostRequiresElevation: capability.hostRequiresElevation === true,
      hostReason: capability.hostSupported === true ? '' : String(capability.hostReason || 'host_profile_unsupported')
    }
  };
}

/**
 * 写 GET 响应：固定读 Go，没有本地回退。
 *
 * 400（例如未登记应用）是 Go 给出的领域结论，原样透传；401/404/5xx 与传输失败都按
 * 「Go 不可用」处理成 503——那说明 Node 与 Go 的接线/密钥出了问题，不是页面参数问题。
 */
async function writeToolAppSettingsFromGo({ res, goHost, appId }) {
  if (!goHost || typeof goHost.getToolAppSettings !== 'function') {
    jsonResponse(res, 503, {
      ok: false,
      error: GO_TOOL_SETTINGS_UNAVAILABLE,
      message: 'Go Core 未就绪，启动权限设置不可读'
    });
    return;
  }
  let response = null;
  try {
    response = await goHost.getToolAppSettings(appId);
  } catch (_error) {
    response = null;
  }
  if (response && response.ok === true && response.data && typeof response.data === 'object') {
    jsonResponse(res, 200, mapToolAppSettings(response.data));
    return;
  }
  const status = Number(response && response.status) || 0;
  const body = response && response.body && typeof response.body === 'object' ? response.body : null;
  const domainCode = body && typeof body.error === 'string' ? body.error : '';
  if (status === 400 && domainCode) {
    jsonResponse(res, 400, {
      ok: false,
      error: domainCode,
      message: String(body.message || domainCode)
    });
    return;
  }
  jsonResponse(res, 503, {
    ok: false,
    error: domainCode || String((response && response.errorCode) || '') || GO_TOOL_SETTINGS_UNAVAILABLE,
    message: 'Go Core 未就绪，启动权限设置不可读'
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
    hostReason: host.supported ? '' : (host.reason || 'host_profile_unsupported')
  };
}

async function handleWebUiToolAppSettingsRoutes(req, res, method, pathname, ctx = {}) {
  const appId = resolveAppId(pathname);
  if (!appId) return false;
  const provider = appId.trim().toLowerCase();
  const options = buildOptions(ctx);
  try {
    // 读路径整条交给 Go：provider 是否存在也由 Go 读 core/providers 判定，
    // Node 不在这里先算一遍（否则就是第二条 GET 路径）。
    if (method === 'GET') {
      await writeToolAppSettingsFromGo({ res, goHost: options.goCoreSync, appId: provider });
      return true;
    }
    if (!isKnownProvider(provider)) {
      throw Object.assign(new Error('未登记该应用'), { code: 'unsupported_app' });
    }
    if (method === 'PUT') {
      const body = await parseJsonBody(req);
      if (typeof body.maxPermission !== 'boolean' || typeof body.applyToHost !== 'boolean') {
        throw Object.assign(new Error('maxPermission 与 applyToHost 必须是布尔值'), {
          code: 'invalid_permission_payload'
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
      let hostApply = null;
      if (body.applyToHost) {
        hostApply = applyHostPermission(provider, options);
        if (!hostApply.supported) {
          throw Object.assign(new Error('该 CLI 尚未登记可写入的宿主权限字段'), {
            code: 'unsupported_app'
          });
        }
      }
      const settings = saveToolPermissionSettings(provider, {
        maxPermission: body.maxPermission,
        applyToHost: body.applyToHost,
        ...(requestedArgs ? { permissionArgs: requestedArgs } : {})
      }, options.fs, options.aiHomeDir, options);
      jsonResponse(res, 200, {
        ok: true,
        appId: provider,
        provider,
        label: getProviderMenuLabel(provider),
        settings,
        capability: describeCapability(provider, options),
        hostApply
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
  resolveAppId
};
