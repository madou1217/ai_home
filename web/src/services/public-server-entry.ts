import type { ControlPlaneProfile } from '@/types';
import type {
  NativeFrpRouteConfigureResult,
  NativeOutboundRelayConfigureResult
} from './native-server-profile-repository';

export type PublicServerSelection = {
  ok: true;
  message: '';
  localProfile: ControlPlaneProfile;
  publicProfiles: ControlPlaneProfile[];
} | {
  ok: false;
  message: string;
  localProfile: null;
  publicProfiles: ControlPlaneProfile[];
};

export interface PublicServerStatusRow {
  profileId: string;
  name: string;
  endpoint: string;
  statusLabel: string;
  statusColor: string;
  retryLabel: string;
  lastError: string;
  attempts: number;
}

export interface FrpPublicServerStatusRow {
  profileId: string;
  name: string;
  endpoint: string;
  statusLabel: string;
  statusColor: string;
  bindPortLabel: string;
  lastError: string;
}

function publicEndpoint(value: string) {
  try {
    return new URL(value).origin;
  } catch (_error) {
    return value;
  }
}

function safeConnectionError(value: unknown) {
  const error = String(value || '').trim().slice(0, 256);
  return /bearer|authorization|management.?key\s*[:=]|https?:\/\//iu.test(error)
    ? '连接失败'
    : error;
}

function frpConnectionError(value: unknown) {
  const code = String(value || '').trim();
  if (!code) return '';
  if (code === 'frp_descriptor_identity_mismatch') return '连接到了其他 Server';
  if (code === 'frp_descriptor_http_error'
    || code === 'frp_descriptor_invalid'
    || code === 'frp_visitor_identity_verification_failed'
    || code === 'network_error'
    || code === 'request_timeout') {
    return '未连接到同一 FRPS，或目标 Server 暂不可达';
  }
  return '连接验证失败';
}

function validateAuthorizedPeerSelection(
  profiles: ControlPlaneProfile[],
  localProfileId: string,
  publicProfileIds: string[],
  limits: { min: number; max: number; countMessage: string }
): PublicServerSelection {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const localProfile = byId.get(String(localProfileId || '').trim()) || null;
  if (!localProfile) {
    return { ok: false, message: '请选择需要外网访问的 Server', localProfile: null, publicProfiles: [] };
  }
  if (publicProfileIds.length < limits.min || publicProfileIds.length > limits.max) {
    return { ok: false, message: limits.countMessage, localProfile: null, publicProfiles: [] };
  }
  const normalizedIds = publicProfileIds.map((profileId) => String(profileId || '').trim());
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    return { ok: false, message: '公网 Server 不能重复选择', localProfile: null, publicProfiles: [] };
  }
  if (normalizedIds.includes(localProfile.id)) {
    return {
      ok: false,
      message: '需要外网访问的 Server 不能同时作为公网 Server',
      localProfile: null,
      publicProfiles: []
    };
  }
  const publicProfiles = normalizedIds
    .map((profileId) => byId.get(profileId) || null)
    .filter((profile): profile is ControlPlaneProfile => Boolean(profile));
  const allAuthorized = localProfile.managementKeyConfigured
    && localProfile.authorizationState === 'authorized'
    && publicProfiles.length === normalizedIds.length
    && publicProfiles.every((profile) => (
      profile.managementKeyConfigured && profile.authorizationState === 'authorized'
    ));
  if (!allAuthorized) {
    return {
      ok: false,
      message: '所选 Server 均需先配置 Management Key',
      localProfile: null,
      publicProfiles: []
    };
  }
  return { ok: true, message: '', localProfile, publicProfiles };
}

export function validatePublicServerSelection(
  profiles: ControlPlaneProfile[],
  localProfileId: string,
  publicProfileIds: string[]
): PublicServerSelection {
  return validateAuthorizedPeerSelection(profiles, localProfileId, publicProfileIds, {
    min: 1,
    max: 5,
    countMessage: '请选择 1 至 5 个公网 Server'
  });
}

export function validateFrpPublicServerSelection(
  profiles: ControlPlaneProfile[],
  localProfileId: string,
  publicProfileIds: string[]
): PublicServerSelection {
  return validateAuthorizedPeerSelection(profiles, localProfileId, publicProfileIds, {
    min: 1,
    max: 5,
    countMessage: '请选择 1 至 5 个已配置 frpc 的公网 Server'
  });
}

export function buildPublicServerStatusRows(
  profiles: ControlPlaneProfile[],
  result: NativeOutboundRelayConfigureResult | null
): PublicServerStatusRow[] {
  const runtime = result?.runtime && typeof result.runtime === 'object'
    ? result.runtime as { relays?: unknown }
    : {};
  const runtimeRelays = Array.isArray(runtime.relays) ? runtime.relays : [];
  const runtimeByEndpoint = new Map(runtimeRelays.map((value) => {
    const source = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
    return [publicEndpoint(String(source.endpoint || '')), source];
  }));
  const statusView: Record<string, { color: string; label: string }> = {
    online: { color: 'green', label: '已连接' },
    connecting: { color: 'blue', label: '连接中' },
    waiting: { color: 'orange', label: '等待重试' },
    stopped: { color: 'default', label: '已停止' },
    disabled: { color: 'default', label: '未启用' }
  };

  return profiles.map((profile) => {
    const endpoint = publicEndpoint(profile.endpoint);
    const runtimeRelay = runtimeByEndpoint.get(endpoint) || {};
    const status = String(runtimeRelay.status || '');
    const view = statusView[status] || {
      color: result?.ok ? 'green' : 'default',
      label: result?.ok ? '配置已保存' : '待配置'
    };
    const retryDelayMs = Math.max(0, Number(runtimeRelay.retryDelayMs) || 0);
    return {
      profileId: profile.id,
      name: profile.name || endpoint,
      endpoint,
      statusLabel: view.label,
      statusColor: view.color,
      retryLabel: retryDelayMs > 0 ? `${Math.ceil(retryDelayMs / 1000)} 秒后重试` : '',
      lastError: safeConnectionError(runtimeRelay.lastError),
      attempts: Math.max(0, Math.floor(Number(runtimeRelay.attempts) || 0))
    };
  });
}

export function buildFrpPublicServerStatusRows(
  profiles: ControlPlaneProfile[],
  result: NativeFrpRouteConfigureResult | null
): FrpPublicServerStatusRow[] {
  const resultByProfileId = new Map(
    (Array.isArray(result?.visitors) ? result.visitors : [])
      .map((item) => [String(item.profileId || ''), item])
  );
  return profiles.map((profile) => {
    const item = resultByProfileId.get(profile.id) || null;
    const bindPort = Math.max(0, Math.floor(Number(item?.bindPort) || 0));
    const ready = item?.status === 'ready';
    const failed = item?.status === 'failed';
    return {
      profileId: profile.id,
      name: profile.name || profile.endpoint,
      endpoint: publicEndpoint(profile.endpoint),
      statusLabel: ready ? '已连通' : (failed ? '连接失败' : '待配置'),
      statusColor: ready ? 'green' : (failed ? 'red' : 'default'),
      bindPortLabel: bindPort > 0 ? `本机端口 ${bindPort}` : '未返回可用端口',
      lastError: failed ? frpConnectionError(item?.lastError) : ''
    };
  });
}
