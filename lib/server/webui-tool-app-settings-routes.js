'use strict';

// WebUI：应用（CLI 工具）启动权限设置。
//
// 路径：
//   GET /v0/webui/toolkit/apps/:appId/settings
//   PUT /v0/webui/toolkit/apps/:appId/settings
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
  getToolPermissionSettings,
  saveToolPermissionSettings
} = require('../cli/services/toolkit/tool-app-settings');
const { isKnownProvider, getProviderMenuLabel } = require('../provider-catalog');

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
    if (!isKnownProvider(provider)) {
      throw Object.assign(new Error('未登记该应用'), { code: 'unsupported_app' });
    }
    if (method === 'GET') {
      const settings = getToolPermissionSettings(provider, options.fs, options.aiHomeDir, options);
      jsonResponse(res, 200, {
        ok: true,
        appId: provider,
        provider,
        label: getProviderMenuLabel(provider),
        settings,
        capability: describeCapability(provider, options)
      });
      return true;
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
        applyToHost: body.applyToHost
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
