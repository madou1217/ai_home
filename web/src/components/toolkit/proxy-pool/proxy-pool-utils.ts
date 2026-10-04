import { message } from 'antd';
import type { ProxyCoreStatus } from '@/types';

export const FUNCTIONAL_GROUP_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: 'AI 标签', value: 'ai' },
  { label: '开发标签', value: 'dev' },
  { label: '独立端口', value: 'dedicated' }
];

export function getErrorMessage(error: unknown, fallback: string) {
  const candidate = error as {
    message?: string;
    response?: { data?: { message?: string; error?: string } };
  };
  return candidate?.response?.data?.message
    || candidate?.response?.data?.error
    || candidate?.message
    || fallback;
}

export function isMutationApplied(result: { ok: boolean; applied?: boolean }) {
  return result.ok && result.applied === true;
}

export function getMutationMessage(
  result: { error?: string; message?: string; warnings?: string[] },
  fallback: string
) {
  return result.message || result.error || result.warnings?.join('；') || fallback;
}

export function maskSubscriptionUrl(value: string) {
  try {
    const url = new URL(value);
    const sensitiveKeys = /token|key|secret|password|passwd|auth/i;
    url.searchParams.forEach((_item, key) => {
      if (sensitiveKeys.test(key)) url.searchParams.set(key, 'REDACTED');
    });
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    return url.toString();
  } catch {
    return value.length > 72 ? `${value.slice(0, 44)}…${value.slice(-12)}` : value;
  }
}

export function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function copyText(value: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(value);
    message.success(successMessage);
  } catch {
    message.error('无法访问剪贴板，请手动复制');
  }
}

export function formatLastSynced(timestamp: number | null) {
  if (!timestamp) return '尚未同步';
  return new Date(timestamp).toLocaleString();
}

/** 当前代理内核的展示名（服务端内核插件提供；旧服务端回落 Mihomo）。 */
export function coreDisplayName(core: Pick<ProxyCoreStatus, 'engineName' | 'engine'> | null | undefined) {
  return core?.engineName || (core?.engine === 'sing-box' ? 'sing-box' : 'Mihomo');
}

export function coreStatusPresentation(core: ProxyCoreStatus | null) {
  if (!core) {
    return { type: 'info' as const, title: '正在读取代理核心状态', description: '尚未取得数据面状态。' };
  }
  const name = coreDisplayName(core);
  if (!core.installed) {
    return {
      type: 'error' as const,
      title: `${name} 代理核心未安装`,
      description: `节点仍可管理和导出，但测速、分流和独立端口不会伪装为可用。${core.binaryEnvVar ? `安装后可通过 ${core.binaryEnvVar} 指定二进制。` : ''}`
    };
  }
  if (!core.running) {
    const source = core.binarySource === 'known-app'
      ? `复用已安装的外部 ${name} 二进制`
      : core.binarySource === 'managed'
        ? `使用 AIH 托管的 ${name} 二进制`
        : '';
    return {
      type: 'warning' as const,
      title: `${name} 已检测到，但数据面未启动`,
      description: [source, core.lastError || '启动核心后，真实代理流量、测速和分流才会生效。'].filter(Boolean).join('；')
    };
  }
  if (!core.dataPlaneReady) {
    return {
      type: 'error' as const,
      title: `${name} 进程未通过就绪检查`,
      description: core.lastError || '控制端口尚未就绪，所有数据面操作保持禁用。'
    };
  }
  return {
    type: 'success' as const,
    title: `${name} 数据面已就绪`,
    description: `${core.version || core.binaryName || core.engine}；mixed 端口 127.0.0.1:${core.mixedPort || 10800}；测速、分流与独立 mixed 端口均由真实代理核心执行。`
  };
}
