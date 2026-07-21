import type { ControlPlaneProfile } from '@/types';
import { configAPI } from './api';
import {
  initializeNativeControlPlaneProfiles,
  listControlPlaneProfiles,
  saveControlPlaneProfileSecure
} from './control-plane-profiles';
import {
  isNativeDesktopRuntime,
  rotateNativeServerManagementKey
} from './native-server-profile-repository';

export const MIN_MANAGEMENT_KEY_LENGTH = 32;
export const MAX_MANAGEMENT_KEY_LENGTH = 8192;

function createRotationError(code: string, message: string, cause?: unknown) {
  const error = new Error(message) as Error & { code?: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function normalizeReplacementManagementKey(value: unknown) {
  const managementKey = String(value || '').trim();
  if (
    managementKey.length < MIN_MANAGEMENT_KEY_LENGTH
    || managementKey.length > MAX_MANAGEMENT_KEY_LENGTH
    || /[\r\n\0]/.test(managementKey)
  ) {
    throw createRotationError(
      'invalid_management_key',
      `Management Key 必须为 ${MIN_MANAGEMENT_KEY_LENGTH}-${MAX_MANAGEMENT_KEY_LENGTH} 个字符，且不能包含换行。`
    );
  }
  return managementKey;
}

export function normalizeSavedManagementKey(value: unknown) {
  const managementKey = String(value || '').trim();
  if (!managementKey || managementKey.length > MAX_MANAGEMENT_KEY_LENGTH || /[\r\n\0]/.test(managementKey)) {
    throw createRotationError('invalid_management_key', 'Management Key 无效。');
  }
  return managementKey;
}

export function generateManagementKey(cryptoImpl: Crypto = window.crypto) {
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') {
    throw createRotationError('secure_random_unavailable', '当前客户端无法生成安全的 Management Key。');
  }
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function profileWithManagementKey(profile: ControlPlaneProfile, managementKey: string) {
  return {
    name: profile.name,
    endpoint: profile.endpoint,
    connectionMode: profile.connectionMode,
    broker: profile.broker,
    descriptor: profile.descriptor,
    state: profile.state,
    managementKey,
    credentialRef: profile.credentialRef,
    managementKeyConfigured: true,
    nodes: profile.nodes,
    nodeCount: profile.nodeCount,
    accountCount: profile.accountCount,
    activeAccountCount: profile.activeAccountCount,
    schedulableAccountCount: profile.schedulableAccountCount,
    sessionCount: profile.sessionCount,
    lastNodeSyncAt: profile.lastNodeSyncAt,
    lastStatusSyncAt: profile.lastStatusSyncAt,
    lastAccountsSyncAt: profile.lastAccountsSyncAt,
    lastSessionsSyncAt: profile.lastSessionsSyncAt,
    lastError: ''
  };
}

export async function updateSavedManagementKey(
  profile: ControlPlaneProfile,
  value: unknown
) {
  const managementKey = normalizeSavedManagementKey(value);
  return saveControlPlaneProfileSecure(profileWithManagementKey(profile, managementKey));
}

export async function rotateManagementKey(
  profile: ControlPlaneProfile,
  value: unknown
) {
  const managementKey = normalizeReplacementManagementKey(value);
  if (!profile || !profile.id) {
    throw createRotationError('missing_active_server_profile', '请先选择要轮换的 Server。');
  }

  if (isNativeDesktopRuntime()) {
    await rotateNativeServerManagementKey(profile.id, managementKey);
    await initializeNativeControlPlaneProfiles();
    const saved = listControlPlaneProfiles().find((item) => item.id === profile.id) || null;
    if (!saved) {
      throw createRotationError(
        'rotated_profile_refresh_failed',
        'Management Key 已轮换，但当前客户端未能刷新 Server Profile。'
      );
    }
    return saved;
  }

  const previousManagementKey = String(profile.managementKey || '').trim();
  if (!previousManagementKey) {
    throw createRotationError('missing_management_key', '当前客户端没有保存该 Server 的 Management Key。');
  }

  await configAPI.rotateManagementKey(managementKey);
  try {
    return await saveControlPlaneProfileSecure(
      profileWithManagementKey(profile, managementKey)
    );
  } catch (saveError) {
    try {
      await configAPI.rotateManagementKey(previousManagementKey, managementKey);
    } catch (rollbackError) {
      throw createRotationError(
        'management_key_rotation_recovery_required',
        'Server 已使用新 Management Key，但当前客户端保存失败。请保留窗口中的新 Key，并使用“更新本客户端 Key”重试。',
        rollbackError
      );
    }
    throw createRotationError(
      'management_key_client_save_failed',
      '当前客户端保存新 Management Key 失败；Server 已恢复原 Key。',
      saveError
    );
  }
}
