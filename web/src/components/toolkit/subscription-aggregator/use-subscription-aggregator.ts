import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { aggregatorErrorText, responseErrorCode } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import { useSourceSync } from './use-source-sync';
import type {
  AggregatorLocalScan,
  AggregatorOverview,
  AggregatorProfile,
  AggregatorProfileInput,
  AggregatorSourceInput
} from './types';

/**
 * 订阅聚合器的页面状态与操作（桌面与移动面板共用）。
 * 每个写操作成功后整体重读概览，节点数与订阅链接以服务端为准；
 * 订阅源的同步是异步任务，状态由 useSourceSync 跟踪（见那里的注释）。
 */
export function useSubscriptionAggregator() {
  const [overview, setOverview] = useState<AggregatorOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await subscriptionAggregatorAPI.overview();
      if (!mounted.current) return;
      setOverview(next);
      setError('');
    } catch (loadError) {
      if (mounted.current) setError(aggregatorErrorText(responseErrorCode(loadError), '读取订阅聚合配置失败'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const sync = useSourceSync(reload);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const run = useCallback(async <T,>(operation: () => Promise<T>, failure: string): Promise<T | null> => {
    try {
      return await operation();
    } catch (operationError) {
      message.error(aggregatorErrorText(responseErrorCode(operationError), failure));
      return null;
    }
  }, []);

  const saveSource = useCallback(async (source: AggregatorSourceInput) => {
    const result = await run(() => subscriptionAggregatorAPI.saveSource(source), '保存订阅源失败');
    if (!result?.ok) return false;
    const action = source.kind === 'local' ? '解析' : '同步';
    // 远程订阅保存后拉取在后台进行：提示「已保存，正在同步」，结果由任务推送。
    if (result.sync?.pending) {
      message.success(`${result.subscription.name} 已保存，正在同步`);
      sync.trackJob(result.job);
    } else if (result.sync && !result.sync.ok) {
      message.warning(`${result.subscription.name} 已保存，但${action}失败：${aggregatorErrorText(result.sync.error, '同步失败')}`);
    } else {
      message.success(`${result.subscription.name} 已保存`);
    }
    await reload();
    return true;
  }, [reload, run, sync]);

  /** 批量添加（多个订阅地址或多个文件）：逐个保存，全部结束后只重读一次。 */
  const saveSources = useCallback(async (sources: AggregatorSourceInput[]) => {
    const failed: string[] = [];
    let saved = 0;
    let pending = 0;
    for (const source of sources) {
      try {
        const result = await subscriptionAggregatorAPI.saveSource(source);
        if (!result.ok) failed.push(`${source.name}：${aggregatorErrorText(result.error, '保存失败')}`);
        else if (result.sync?.pending) { pending += 1; sync.trackJob(result.job); }
        else if (result.sync && !result.sync.ok) failed.push(`${source.name}：已保存，同步失败（${aggregatorErrorText(result.sync.error, '同步失败')}）`);
        if (result.ok) saved += 1;
      } catch (saveError) {
        failed.push(`${source.name}：${aggregatorErrorText(responseErrorCode(saveError), '保存失败')}`);
      }
    }
    if (failed.length) message.warning(`已添加 ${saved}/${sources.length} 个订阅源`);
    else message.success(pending ? `已添加 ${saved} 个订阅源，正在后台同步` : `已添加 ${saved} 个订阅源`);
    await reload();
    return { saved, failed };
  }, [reload, sync]);

  const deleteSource = useCallback(async (subscriptionId: string) => {
    const result = await run(() => subscriptionAggregatorAPI.deleteSource(subscriptionId), '删除订阅源失败');
    if (!result?.ok) return false;
    message.success('订阅源及其节点已删除');
    await reload();
    return true;
  }, [reload, run]);

  /** 启用 / 停用订阅源（节点保留，只是不再参与聚合与出口池）。 */
  const setSourceEnabled = useCallback(async (subscriptionId: string, enabled: boolean) => {
    const result = await run(() => subscriptionAggregatorAPI.setSourceEnabled(subscriptionId, enabled), '切换订阅源状态失败');
    if (!result?.ok) return false;
    message.success(enabled ? '订阅源已启用' : '订阅源已停用（节点保留，不再参与聚合）');
    await reload();
    return true;
  }, [reload, run]);

  /** 扫描本机代理客户端（只读）：返回结果给弹窗展示，不落库。 */
  const scanLocalSources = useCallback(async (): Promise<AggregatorLocalScan | null> => {
    setScanning(true);
    try {
      const result = await subscriptionAggregatorAPI.scanLocalSources();
      if (!result.ok) {
        message.warning(aggregatorErrorText(result.error, '扫描本机客户端失败'));
        return null;
      }
      return result;
    } catch (scanError) {
      message.error(aggregatorErrorText(responseErrorCode(scanError), '扫描本机客户端失败'));
      return null;
    } finally {
      if (mounted.current) setScanning(false);
    }
  }, []);

  /** 导入扫描到的订阅：先落库，节点拉取交给后台任务。 */
  const importLocalSources = useCallback(async (ids: string[]) => {
    const result = await run(() => subscriptionAggregatorAPI.importLocalSources(ids), '导入订阅失败');
    if (!result?.ok) return { saved: 0, failed: [aggregatorErrorText(result?.error, '导入失败')] };
    const failed = result.skipped.map((item) => `${item.name}：${item.reason === 'already_imported' ? '已导入过' : aggregatorErrorText(item.reason, '跳过')}`);
    if (result.imported.length) {
      message.success(`已导入 ${result.imported.length} 个订阅源${failed.length ? `，跳过 ${failed.length} 个` : ''}`);
      sync.trackJob(result.job);
    } else if (failed.length) {
      message.warning(`没有导入任何订阅源：${failed.join('；')}`);
    }
    await reload();
    return { saved: result.imported.length, failed };
  }, [reload, run, sync]);

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
    scanning,
    syncingIds: sync.syncingIds,
    syncingAll: sync.syncingAll,
    lastResultFor: sync.lastResultFor,
    saveSource,
    saveSources,
    deleteSource,
    setSourceEnabled,
    scanLocalSources,
    importLocalSources,
    syncSource: sync.syncSource,
    syncAllSources: sync.syncAllSources,
    saveProfile,
    deleteProfile,
    rotateToken
  };
}

export type SubscriptionAggregatorState = ReturnType<typeof useSubscriptionAggregator>;
