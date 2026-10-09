import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { aggregatorErrorText } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorOverview, AggregatorProfile, AggregatorProfileInput, AggregatorSyncResult } from './types';

function errorCode(error: unknown) {
  const candidate = error as { response?: { data?: { error?: string } }; message?: string };
  return candidate?.response?.data?.error || candidate?.message;
}

function syncSummary(result: AggregatorSyncResult) {
  return result.ok ? `${result.count ?? 0} 个节点` : aggregatorErrorText(result.error, '同步失败');
}

/**
 * 订阅聚合器的页面状态与操作（桌面与移动面板共用）。
 * 每个写操作成功后整体重读概览，节点数与订阅链接以服务端为准。
 */
export function useSubscriptionAggregator() {
  const [overview, setOverview] = useState<AggregatorOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [syncingAll, setSyncingAll] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await subscriptionAggregatorAPI.overview();
      if (!mounted.current) return;
      setOverview(next);
      setError('');
    } catch (loadError) {
      if (mounted.current) setError(aggregatorErrorText(errorCode(loadError), '读取订阅聚合配置失败'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const markSyncing = (id: string, active: boolean) => setSyncingIds((current) => {
    const next = new Set(current);
    if (active) next.add(id);
    else next.delete(id);
    return next;
  });

  const run = useCallback(async <T,>(operation: () => Promise<T>, failure: string): Promise<T | null> => {
    try {
      return await operation();
    } catch (operationError) {
      message.error(aggregatorErrorText(errorCode(operationError), failure));
      return null;
    }
  }, []);

  const saveSource = useCallback(async (source: { id?: string; name: string; url: string }) => {
    const result = await run(() => subscriptionAggregatorAPI.saveSource(source), '保存订阅源失败');
    if (!result?.ok) return false;
    if (result.sync && !result.sync.ok) message.warning(`${source.name} 已保存，但首次同步失败：${syncSummary(result.sync)}`);
    else message.success(result.sync ? `${source.name} 已添加：${syncSummary(result.sync)}` : `${source.name} 已保存`);
    await reload();
    return true;
  }, [reload, run]);

  /** 批量添加：逐个保存（每个都会首次同步），全部结束后只重读一次。 */
  const saveSources = useCallback(async (sources: Array<{ name: string; url: string }>) => {
    const failed: string[] = [];
    let saved = 0;
    for (const source of sources) {
      try {
        const result = await subscriptionAggregatorAPI.saveSource(source);
        if (!result.ok) failed.push(`${source.name}：${aggregatorErrorText(result.error, '保存失败')}`);
        else if (result.sync && !result.sync.ok) failed.push(`${source.name}：已保存，同步失败（${syncSummary(result.sync)}）`);
        if (result.ok) saved += 1;
      } catch (saveError) {
        failed.push(`${source.name}：${aggregatorErrorText(errorCode(saveError), '保存失败')}`);
      }
    }
    if (failed.length) message.warning(`已添加 ${saved}/${sources.length} 个订阅源`);
    else message.success(`已添加 ${saved} 个订阅源`);
    await reload();
    return { saved, failed };
  }, [reload]);

  const deleteSource = useCallback(async (subscriptionId: string) => {
    const result = await run(() => subscriptionAggregatorAPI.deleteSource(subscriptionId), '删除订阅源失败');
    if (!result?.ok) return false;
    message.success('订阅源及其节点已删除');
    await reload();
    return true;
  }, [reload, run]);

  const syncSource = useCallback(async (subscriptionId: string) => {
    markSyncing(subscriptionId, true);
    const result = await run(() => subscriptionAggregatorAPI.syncSource(subscriptionId), '同步订阅源失败');
    markSyncing(subscriptionId, false);
    if (!result) return;
    if (result.ok) message.success(`同步完成：${syncSummary(result)}`);
    else message.warning(`同步未完成：${syncSummary(result)}`);
    await reload();
  }, [reload, run]);

  const syncAllSources = useCallback(async () => {
    setSyncingAll(true);
    const result = await run(() => subscriptionAggregatorAPI.syncAllSources(), '同步订阅源失败');
    setSyncingAll(false);
    if (!result) return;
    const failed = Object.values(result.results).filter((item) => !item.ok).length;
    const total = Object.keys(result.results).length;
    if (failed) message.warning(`${total - failed}/${total} 个订阅源同步成功`);
    else message.success(`${total} 个订阅源已全部同步`);
    await reload();
  }, [reload, run]);

  const saveProfile = useCallback(async (profile: AggregatorProfileInput): Promise<AggregatorProfile | null> => {
    const result = await run(() => subscriptionAggregatorAPI.saveProfile(profile), '保存聚合订阅失败');
    if (!result?.ok) return null;
    message.success(`${result.profile.name} 已保存`);
    await reload();
    return result.profile;
  }, [reload, run]);

  const deleteProfile = useCallback(async (profileId: string) => {
    const result = await run(() => subscriptionAggregatorAPI.deleteProfile(profileId), '删除聚合订阅失败');
    if (!result?.ok) return;
    message.success('聚合订阅已删除，原链接立即失效');
    await reload();
  }, [reload, run]);

  const rotateToken = useCallback(async (profileId: string) => {
    const result = await run(() => subscriptionAggregatorAPI.rotateToken(profileId), '重置订阅链接失败');
    if (!result?.ok) return;
    message.success('已生成新链接，旧链接立即失效');
    await reload();
  }, [reload, run]);

  return {
    overview,
    loading,
    error,
    setError,
    reload,
    syncingIds,
    syncingAll,
    saveSource,
    saveSources,
    deleteSource,
    syncSource,
    syncAllSources,
    saveProfile,
    deleteProfile,
    rotateToken
  };
}

export type SubscriptionAggregatorState = ReturnType<typeof useSubscriptionAggregator>;
