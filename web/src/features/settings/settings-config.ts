import type { Rule } from 'antd/es/form';
import type { ManagementRestartEvent, ServerConfig, UsageConfig } from '@/types';

/**
 * 设置页（/settings 基础设置）的纯数据层：表单默认值、校验规则、刷新间隔换算、
 * 服务配置提交载荷、重启状态文案、壁纸文件校验。桌面 Settings.tsx 与移动端 MobileSettings 共用。
 */

export interface UsageFormValues {
  threshold_pct: number;
  /** 秒 */
  active_refresh_interval: number;
  /** 秒 */
  background_refresh_interval: number;
}

export const USAGE_FORM_DEFAULTS: UsageFormValues = {
  threshold_pct: 95,
  active_refresh_interval: 60,
  background_refresh_interval: 3600
};

export const SERVER_FORM_DEFAULTS: ServerConfig = {
  host: '127.0.0.1',
  port: 9527,
  apiKey: '',
  managementKey: '',
  openNetwork: false
};

export const USAGE_FIELD_RULES: Record<keyof UsageFormValues, Rule[]> = {
  threshold_pct: [
    { required: true, message: '请输入阈值' },
    { type: 'number', min: 0, max: 100, message: '阈值必须在 0-100 之间' }
  ],
  active_refresh_interval: [
    { required: true, message: '请输入刷新间隔' },
    { type: 'number', min: 10, message: '间隔不能小于 10 秒' }
  ],
  background_refresh_interval: [
    { required: true, message: '请输入刷新间隔' },
    { type: 'number', min: 60, message: '间隔不能小于 60 秒' }
  ]
};

export const SERVER_PORT_RULES: Rule[] = [
  { required: true, message: '请输入端口' },
  { type: 'number', min: 1, max: 65535, message: '端口必须在 1-65535 之间' }
];

/** "90s" / "5m" / "1h" → 秒；无法识别时回落 60。 */
export function parseRefreshInterval(interval: string): number {
  const match = String(interval || '').match(/^(\d+)([smh])$/);
  if (!match) return 60;
  const [, value, unit] = match;
  const num = parseInt(value, 10);
  switch (unit) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    default: return num;
  }
}

/** 秒 → "Ns" / "Nm" / "Nh"（向下取整到最大单位）。 */
export function formatRefreshInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function toUsageFormValues(config: UsageConfig): UsageFormValues {
  return {
    threshold_pct: config.threshold_pct,
    active_refresh_interval: parseRefreshInterval(config.active_refresh_interval),
    background_refresh_interval: parseRefreshInterval(config.background_refresh_interval)
  };
}

export function toUsageConfig(values: UsageFormValues): UsageConfig {
  return {
    threshold_pct: values.threshold_pct,
    active_refresh_interval: formatRefreshInterval(values.active_refresh_interval),
    background_refresh_interval: formatRefreshInterval(values.background_refresh_interval)
  };
}

/**
 * 服务配置提交载荷：开放网络强制 0.0.0.0；API Key 留空不提交（保留当前配置）；
 * Management Key 单独返回，由调用方走密钥轮换流程。
 */
export function buildServerConfigPatch(values: Partial<ServerConfig>): { patch: Partial<ServerConfig>; managementKey: string } {
  const apiKey = String(values.apiKey || '').trim();
  const managementKey = String(values.managementKey || '').trim();
  return {
    managementKey,
    patch: {
      host: values.openNetwork ? '0.0.0.0' : (values.host || '127.0.0.1'),
      port: Number(values.port || 9527),
      openNetwork: Boolean(values.openNetwork),
      ...(apiKey ? { apiKey } : {})
    }
  };
}

export interface RestartStateNote {
  type: 'error' | 'success' | 'info';
  message: string;
}

/** 重启任务状态 → 行内提示；既无事件也未在重启时返回 null。 */
export function describeRestartState(event: ManagementRestartEvent | null, restarting: boolean): RestartStateNote | null {
  if (!event && !restarting) return null;
  const status = event?.status || 'queued';
  if (status === 'failed') {
    return { type: 'error', message: event?.message || '重启服务失败' };
  }
  if (status === 'started') {
    return {
      type: 'success',
      message: event?.pid ? `服务重启已启动，pid ${event.pid}` : '服务重启已启动'
    };
  }
  return {
    type: 'info',
    message: status === 'starting' ? '服务正在重启' : '服务重启已排队'
  };
}

/** dataUrl 持久化在 localStorage，限制原图体积避免撑爆配额。 */
export const WALLPAPER_MAX_BYTES = 2 * 1024 * 1024;

/** 返回校验失败的提示文案；通过时返回空串。 */
export function validateWallpaperFile(file: Pick<File, 'type' | 'size'>): string {
  if (!String(file.type || '').startsWith('image/')) return '请选择图片文件';
  if (file.size > WALLPAPER_MAX_BYTES) return '图片不能超过 2MB';
  return '';
}
