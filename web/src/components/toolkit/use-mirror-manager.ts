import { useCallback, useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import { toolkitAPI } from '@/services/api';
import type { MirrorGuide, MirrorPreset, MirrorsResponse } from '@/types';
import type { GuidedCommandTask } from './guided-command';

export type MirrorKind = 'npm' | 'pip';

export interface MirrorLatencyResult {
  state: 'idle' | 'loading' | 'success' | 'error';
  latencyMs?: number;
  statusCode?: number | null;
  error?: string;
}

export function buildMirrorTasks(guide: MirrorGuide | undefined, preset: MirrorPreset) {
  return (guide?.commands || []).map<GuidedCommandTask>((command, index) => {
    const generated = command.cmd.replace(/<package>/gi, '{{package}}');
    const needsPackage = generated.includes('{{package}}');
    return {
      id: `${preset.id}-guide-${index}`,
      label: command.label,
      command: generated,
      category: /写入|配置|set\s/i.test(command.label) ? 'configure' : 'use',
      platform: command.platform,
      parameters: needsPackage
        ? [{ key: 'package', label: '包名', placeholder: '例如 typescript 或 requests' }]
        : undefined
    };
  });
}

export function mirrorLatencyLabel(result: MirrorLatencyResult | undefined) {
  if (!result || result.state === 'idle') return '未实测';
  if (result.state === 'loading') return '测试中';
  if (result.state === 'error') return '不可达';
  return `TTFB ${result.latencyMs} ms${result.statusCode ? ` · HTTP ${result.statusCode}` : ''}`;
}

export function mirrorApplicableRegion(preset: MirrorPreset) {
  const label = String(preset.speed || '').trim();
  if (/国内/.test(label)) return '中国大陆';
  if (/全球/.test(label)) return '全球';
  return label || '未标注';
}

/**
 * 软件源与镜像的数据层（桌面面板与移动端共用）：读取 npm / pip 当前配置与预设，
 * 单次 HTTP HEAD 延迟实测，以及把所选镜像写入配置。
 */
export function useMirrorManager() {
  const [data, setData] = useState<MirrorsResponse | null>(null);
  const [kind, setKind] = useState<MirrorKind>('npm');
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settingUrl, setSettingUrl] = useState('');
  const [latencies, setLatencies] = useState<Record<string, MirrorLatencyResult>>({});

  const fetchMirrors = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.getMirrors();
      if (!response.ok) throw new Error('镜像接口未返回可用结果');
      setData(response);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : '读取镜像源失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMirrors();
  }, [fetchMirrors]);

  const mirrorData = data?.[kind];
  const presets = mirrorData?.presets || [];

  useEffect(() => {
    setSelectedId((current) => {
      if (presets.some((preset) => preset.id === current)) return current;
      return presets.find((preset) => preset.active)?.id || presets[0]?.id || '';
    });
  }, [presets]);

  const selectedPreset = presets.find((preset) => preset.id === selectedId) || presets[0];
  const guideTasks = useMemo(
    () => selectedPreset ? buildMirrorTasks(selectedPreset.guides, selectedPreset) : [],
    [selectedPreset]
  );

  const testLatency = async (preset: MirrorPreset) => {
    setLatencies((current) => ({ ...current, [preset.url]: { state: 'loading' } }));
    try {
      const response = await toolkitAPI.pingMirror(preset.url);
      setLatencies((current) => ({
        ...current,
        [preset.url]: response.ok
          ? { state: 'success', latencyMs: response.latencyMs, statusCode: response.statusCode }
          : { state: 'error', statusCode: response.statusCode, error: response.error || '端点未返回 2xx/3xx' }
      }));
    } catch (requestError: unknown) {
      setLatencies((current) => ({
        ...current,
        [preset.url]: {
          state: 'error',
          error: requestError instanceof Error ? requestError.message : '请求失败'
        }
      }));
    }
  };

  const setMirror = async (preset: MirrorPreset) => {
    setSettingUrl(preset.url);
    setError('');
    try {
      const response = await toolkitAPI.setMirror(kind, preset.url);
      if (!response.ok) throw new Error(response.error || '配置写入失败');
      await fetchMirrors();
      message.success(`${preset.name} 已写入 ${kind} 配置`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : '切换镜像源失败');
    } finally {
      setSettingUrl('');
    }
  };

  const currentValue = mirrorData?.current || '未读取到显式配置';
  const selectedLatency = selectedPreset ? latencies[selectedPreset.url] : undefined;

  return {
    data,
    kind,
    setKind,
    selectedId,
    setSelectedId,
    loading,
    error,
    setError,
    settingUrl,
    latencies,
    fetchMirrors,
    mirrorData,
    presets,
    selectedPreset,
    guideTasks,
    testLatency,
    setMirror,
    currentValue,
    selectedLatency
  };
}
