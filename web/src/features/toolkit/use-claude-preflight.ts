import { useCallback, useEffect, useState } from 'react';
import { claudePreflightAPI } from '@/services/api';
import type { ClaudePreflightConfig, ClaudePreflightMode } from '@/types';

/**
 * Claude Code 首屏检查策略的数据层：面板只负责渲染，保存与探测都在这里复用。
 *
 * 探测会真实请求 api.anthropic.com / platform.claude.com，点"重新检测"或切换到
 * 开启/自动后执行一次；读接口本身不做网络探测，避免拖慢面板打开。
 */
export function useClaudePreflight(options: { probeOnLoad?: boolean } = {}) {
  const [config, setConfig] = useState<ClaudePreflightConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await claudePreflightAPI.get();
      setConfig(next);
      setError('');
      return next;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载首屏检查配置失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateMode = useCallback(async (mode: ClaudePreflightMode) => {
    setSaving(true);
    try {
      const next = await claudePreflightAPI.update(mode);
      setConfig(next);
      setError('');
      return next;
    } finally {
      setSaving(false);
    }
  }, []);

  const probe = useCallback(async () => {
    setProbing(true);
    try {
      const next = await claudePreflightAPI.probe();
      setConfig(next);
      setError('');
      return next;
    } catch (probeError) {
      // 探测失败（网络错误 / 旧服务端没有该接口）只影响本次结论，保留已有策略。
      setError(probeError instanceof Error ? probeError.message : '探测首屏端点失败');
      return null;
    } finally {
      setProbing(false);
    }
  }, []);

  // 首次打开且尚未检测过时补一次探测，让"自动"能展示真实环境结论。
  useEffect(() => {
    if (!options.probeOnLoad) return;
    if (loading || !config || config.reachable !== null) return;
    void probe().catch(() => undefined);
  }, [options.probeOnLoad, loading, config, probe]);

  return { config, loading, saving, probing, error, load, updateMode, probe };
}

/** 首屏检查的模式说明，桌面与移动端工具箱共用。 */
export function describeClaudePreflightMode(mode: ClaudePreflightMode): string {
  switch (mode) {
    case 'on':
      return '保留官方首屏检查；环境不可达时会提示开启后的后果';
    case 'off':
      return '跳过官方首屏检查，直接进入会话';
    default:
      return '首次按当前网络/代理探测结果自动决定（默认关闭）';
  }
}

/** 最近一次探测结论的一句话摘要。 */
export function describeClaudePreflightStatus(config: ClaudePreflightConfig | null): string {
  if (!config || config.reachable === null) return '尚未检测当前环境';
  const time = config.checked_at > 0
    ? new Date(config.checked_at).toLocaleString('zh-CN', { hour12: false })
    : '';
  const conclusion = config.reachable ? '可达' : '不可达';
  return time ? `${conclusion} · 检测于 ${time}` : conclusion;
}
