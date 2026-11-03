'use strict';

const { authorizeManagementKey } = require('./management-key-auth');

const MIN_MANAGEMENT_KEY_LENGTH = 32;
const MAX_MANAGEMENT_KEY_LENGTH = 8192;

function createRotationError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeReplacementManagementKey(value) {
  const managementKey = String(value || '').trim();
  if (
    managementKey.length < MIN_MANAGEMENT_KEY_LENGTH
    || managementKey.length > MAX_MANAGEMENT_KEY_LENGTH
    || /[\r\n\0]/.test(managementKey)
  ) {
    throw createRotationError(
      'invalid_management_key',
      `Management Key 必须为 ${MIN_MANAGEMENT_KEY_LENGTH}-${MAX_MANAGEMENT_KEY_LENGTH} 个字符，且不能包含换行。`,
      400
    );
  }
  return managementKey;
}

function createManagementKeyRotationService(options = {}) {
  let requiredManagementKey = String(options.initialManagementKey || '').trim();
  const managementKeySource = String(options.managementKeySource || '').trim();
  const writeServerConfig = options.writeServerConfig;

  if (typeof writeServerConfig !== 'function') {
    throw new Error('management_key_rotation_writer_required');
  }

  function getRequiredManagementKey() {
    return requiredManagementKey;
  }

  function rotate({ req, managementKey } = {}) {
    // Rotation is stronger than the general loopback WebUI gate: the current
    // credential is always required so a third-party page cannot change the
    // localhost Server key with a simple CSRF POST.
    const authorization = authorizeManagementKey({
      req,
      requiredManagementKey
    });
    if (!authorization.ok) {
      throw createRotationError(
        'webui_unauthorized',
        '当前 Management Key 无效。',
        authorization.statusCode || 401
      );
    }

    if (managementKeySource && managementKeySource !== 'server-config') {
      throw createRotationError(
        'management_key_external_source',
        '当前 Server 的 Management Key 由启动参数或环境变量管理，不能由客户端轮换。',
        409
      );
    }

    const replacement = normalizeReplacementManagementKey(managementKey);
    if (replacement === requiredManagementKey) {
      throw createRotationError(
        'management_key_unchanged',
        '新 Management Key 不能与当前 Key 相同。',
        409
      );
    }

    let saved;
    try {
      saved = writeServerConfig({ managementKey: replacement });
    } catch (_error) {
      throw createRotationError(
        'management_key_rotation_persist_failed',
        'Server 无法保存新的 Management Key。',
        500
      );
    }
    if (String(saved && saved.managementKey || '').trim() !== replacement) {
      throw createRotationError(
        'management_key_rotation_persist_failed',
        'Server 未能确认新的 Management Key。',
        500
      );
    }

    requiredManagementKey = replacement;
    return {
      managementKeyConfigured: true,
      rotatedAt: Date.now()
    };
  }

  return {
    getRequiredManagementKey,
    rotate
  };
}

module.exports = {
  MIN_MANAGEMENT_KEY_LENGTH,
  MAX_MANAGEMENT_KEY_LENGTH,
  normalizeReplacementManagementKey,
  createManagementKeyRotationService
};
