import { configAPI } from '@/services/api';
import { rotateManagementKey } from '@/services/management-key-rotation';
import type { ControlPlaneProfile, ServerConfig } from '@/types';
import { buildServerConfigPatch } from './settings-config';

/**
 * 保存「服务配置」：先写监听 / 端口 / API Key（configAPI.updateServer），
 * 填了 Management Key 时再对当前默认 Server 走密钥轮换。
 * 返回保存后的配置与被轮换的 profile id（未轮换为空串），调用方据此刷新 profile 列表。
 */
export async function saveServerConfig(values: Partial<ServerConfig>, activeProfile: ControlPlaneProfile | null) {
  const { patch, managementKey } = buildServerConfigPatch(values);
  if (managementKey && !activeProfile) throw new Error('请先选择 Server');
  const saved = await configAPI.updateServer(patch);
  if (managementKey) {
    if (!activeProfile) throw new Error('请先选择 Server');
    await rotateManagementKey(activeProfile, managementKey);
    return { saved, rotatedProfileId: activeProfile.id };
  }
  return { saved, rotatedProfileId: '' };
}
