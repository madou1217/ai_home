'use strict';

// WebUI：应用（CLI 工具）启动权限设置。
//
// 路径：
//   GET /v0/webui/toolkit/apps/:appId/settings  → Go 只读模型
//   PUT /v0/webui/toolkit/apps/:appId/settings  → Go 写入口（含 applyToHost 宿主配置写入）
//
// 边界（不要打破）：
//   * 设置记录、capability、权限目录、参数校验与宿主配置写入全部在 Go：
//     GET/PUT /v1/management/webui/tool-apps/{appId}/settings。
//   * Node 只做管理密钥门后的转发与字段形状收口，不再本地读 app-state.db、
//     也不再本地写宿主配置文件。Go 不可用就 503，没有本地回退。
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

function mapToolPermissionCatalog(value) {
  const catalog = value && typeof value === 'object' ? value : {};
  return {
    verifiedCliVersion: String(catalog.verifiedCliVersion || 'none'),
    groups: catalog.groups && typeof catalog.groups === 'object' ? catalog.groups : {},
    flags: (Array.isArray(catalog.flags) ? catalog.flags : []).map(mapCatalogFlag),
    conflicts: (Array.isArray(catalog.conflicts) ? catalog.conflicts : []).map((item) => ({
      a: String((item && item.a) || ''),
      b: String((item && item.b) || ''),
      message: String((item && item.message) || '')
    })),
    overrides: (Array.isArray(catalog.overrides) ? catalog.overrides : []).map((item) => ({
      by: String((item && item.by) || ''),
      over: String((item && item.over) || ''),
      message: String((item && item.message) || '')
    })),
    subcommandsWithoutApprovalFlag: textListOf(catalog.subcommandsWithoutApprovalFlag),
    subcommandsBlockingPermissionOverrides: textListOf(catalog.subcommandsBlockingPermissionOverrides)
  };
}

/**
 * Go 设置模型 → /v0/webui/toolkit/apps/:appId/settings 既有响应契约。
 * 只做形状收口（缺失字段给稳定默认值），不重新推导任何权限事实。
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
    },
    ...(source.hostApply ? { hostApply: source.hostApply } : {})
  };
}

function writeGoResponse(res, response, transform) {
  if (response && response.ok === true && response.data && typeof response.data === 'object') {
    jsonResponse(res, 200, typeof transform === 'function' ? transform(response.data) : response.data);
    return;
  }
  const status = Number(response && response.status) || 0;
  const body = response && response.body && typeof response.body === 'object' ? response.body : null;
  const domainCode = body && typeof body.error === 'string' ? body.error : '';
  if ([400, 403, 409, 413, 422].includes(status) && domainCode) {
    jsonResponse(res, status, {
      ok: false,
      error: domainCode,
      message: String(body.message || domainCode),
      ...(body.validation ? { validation: body.validation } : {})
    });
    return;
  }
  jsonResponse(res, 503, {
    ok: false,
    error: domainCode || String((response && response.errorCode) || '') || GO_TOOL_SETTINGS_UNAVAILABLE,
    message: 'Go Core 未就绪，启动权限设置不可用'
  });
}

async function handleWebUiToolAppSettingsRoutes(req, res, method, pathname, ctx = {}) {
  const appId = resolveAppId(pathname);
  if (!appId) return false;
  const provider = appId.trim().toLowerCase();
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost) {
    jsonResponse(res, 503, {
      ok: false,
      error: GO_TOOL_SETTINGS_UNAVAILABLE,
      message: 'Go Core 未就绪，启动权限设置不可用'
    });
    return true;
  }
  if (method === 'GET') {
    if (typeof goHost.getToolAppSettings !== 'function') {
      jsonResponse(res, 503, {
        ok: false,
        error: GO_TOOL_SETTINGS_UNAVAILABLE,
        message: 'Go Core 未就绪，启动权限设置不可读'
      });
      return true;
    }
    const response = await goHost.getToolAppSettings(provider).catch(() => null);
    writeGoResponse(res, response, mapToolAppSettings);
    return true;
  }
  if (method === 'PUT') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (error) {
      jsonResponse(res, error && error.message === 'Body too large' ? 413 : 400, {
        ok: false,
        error: 'invalid_permission_payload',
        message: String(error && error.message || '启动权限请求失败')
      });
      return true;
    }
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(body, 'maxPermission')) payload.maxPermission = body.maxPermission;
    if (Object.prototype.hasOwnProperty.call(body, 'applyToHost')) payload.applyToHost = body.applyToHost;
    if (Object.prototype.hasOwnProperty.call(body, 'permissionArgs')) payload.permissionArgs = body.permissionArgs;
    if (typeof goHost.putToolAppSettings !== 'function') {
      jsonResponse(res, 503, {
        ok: false,
        error: GO_TOOL_SETTINGS_UNAVAILABLE,
        message: 'Go Core 未就绪，启动权限设置不可写'
      });
      return true;
    }
    const response = await goHost.putToolAppSettings(provider, payload).catch(() => null);
    writeGoResponse(res, response, mapToolAppSettings);
    return true;
  }
  jsonResponse(res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET / PUT' });
  return true;
}

module.exports = {
  ROUTE_PREFIX,
  ROUTE_SUFFIX,
  handleWebUiToolAppSettingsRoutes,
  resolveAppId
};
