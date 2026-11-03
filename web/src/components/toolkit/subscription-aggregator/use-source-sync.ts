import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { aggregatorErrorText, responseErrorCode } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorSyncItemState, AggregatorSyncJob } from './types';

const ACTIVE_STATES = new Set<AggregatorSyncItemState>(['queued', 'running']);

/** 一个任务结束时的一句话汇总（成功几个、失败的是谁、为什么）。 */
export function describeFinishedJob(job: AggregatorSyncJob) {
  const failed = job.items.filter((item) => item.state === 'failed');
  if (!failed.length) {
    const nodes = job.items.reduce((sum, item) => sum + item.count, 0);
    return { tone: 'success' as const, text: job.items.length === 1 ? `${job.items[0].name} 同步完成：${nodes} 个节点` : `${job.items.length} 个订阅源已同步，共 ${nodes} 个节点` };
  }
  const reasons = failed.slice(0, 3).map((item) => `${item.name}（${aggregatorErrorText(item.error, '同步失败')}${item.message ? ` · ${item.message}` : ''}）`);
  const more = failed.length > 3 ? ` 等 ${failed.length} 个` : '';
  const prefix = job.items.length === 1 ? '同步失败' : `${job.items.length - failed.length}/${job.items.length} 个订阅源同步成功；失败`;
  return { tone: failed.length === job.items.length ? 'error' as const : 'warning' as const, text: `${prefix}：${reasons.join('、')}${more}` };
}

/** 某个任务里还没结束的源。 */
function activeSourceIds(job: AggregatorSyncJob) {
  return job.items.filter((item) => ACTIVE_STATES.has(item.state)).map((item) => item.sourceId);
}

/**
 * 订阅源异步同步（桌面与移动面板共用）。
 * 按钮的「同步中」完全来自服务端任务（SSE 推送），页面刷新 / 多个标签页看到的都一样；
 * 点击后到第一帧推送之间用本地乐观状态盖住，防止连点。
 * 任务结束只通知一次，并触发一次概览重读（节点数、流量、上次同步时间以服务端为准）。
 */
export function useSourceSync(onJobFinished: () => void) {
  const [jobs, setJobs] = useState<Map<string, AggregatorSyncJob>>(new Map());
  // 点击后、服务端还没回任务前的乐观状态（只为禁用按钮，不作为结果）。
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [startingAll, setStartingAll] = useState(false);
  const notified = useRef<Set<string>>(new Set());
  const finishedRef = useRef(onJobFinished);
  finishedRef.current = onJobFinished;
  const mounted = useRef(true);

  const applyJob = useCallback((job: AggregatorSyncJob, { announce = true } = {}) => {
    if (!mounted.current || !job?.id) return;
    setJobs((current) => {
      const next = new Map(current);
      next.set(job.id, job);
      return next;
    });
    setPendingIds((current) => {
      if (!current.size) return current;
      const next = new Set(current);
      job.items.forEach((item) => next.delete(item.sourceId));
      return next;
    });
    if (!job.finishedAt || notified.current.has(job.id)) return;
    notified.current.add(job.id);
    // 页面打开前就结束的任务（snapshot 带来的）不再弹通知，只更新状态。
    if (!announce) return;
    const summary = describeFinishedJob(job);
    if (summary.tone === 'success') message.success(summary.text);
    else if (summary.tone === 'warning') message.warning(summary.text, 6);
    else message.error(summary.text, 6);
    finishedRef.current();
  }, []);

  useEffect(() => {
    mounted.current = true;
    const stream = subscriptionAggregatorAPI.watchSourceSync();
    stream.onmessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'));
        if (payload.type === 'snapshot' && Array.isArray(payload.jobs)) {
          (payload.jobs as AggregatorSyncJob[]).forEach((job) => applyJob(job, { announce: false }));
        } else if (payload.type === 'job' && payload.job) {
          applyJob(payload.job as AggregatorSyncJob);
        }
      } catch (_error) {
        // 心跳 / 畸形帧忽略；断线重连后服务端会先发一帧 snapshot 补状态。
      }
    };
    return () => {
      mounted.current = false;
      stream.close();
    };
  }, [applyJob]);

  /** 当前在排队 / 同步中的订阅源（来自所有未结束任务 + 乐观状态）。 */
  const syncingIds = new Set<string>(pendingIds);
  for (const job of jobs.values()) {
    if (!job.finishedAt) activeSourceIds(job).forEach((id) => syncingIds.add(id));
  }

  const markPending = (ids: string[], active: boolean) => setPendingIds((current) => {
    const next = new Set(current);
    ids.forEach((id) => (active ? next.add(id) : next.delete(id)));
    return next;
  });

  const handleStart = useCallback((result: Awaited<ReturnType<typeof subscriptionAggregatorAPI.syncSource>> | null, ids: string[]) => {
    if (!result?.ok || !result.job) {
      markPending(ids, false);
      message.warning(aggregatorErrorText(result?.error, '同步没有开始'));
      return false;
    }
    applyJob(result.job);
    return true;
  }, [applyJob]);

  const syncSource = useCallback(async (subscriptionId: string) => {
    if (syncingIds.has(subscriptionId)) return;
    markPending([subscriptionId], true);
    try {
      handleStart(await subscriptionAggregatorAPI.syncSource(subscriptionId), [subscriptionId]);
    } catch (error) {
      markPending([subscriptionId], false);
      message.error(aggregatorErrorText(responseErrorCode(error), '同步订阅源失败'));
    }
    // syncingIds 每次渲染重算，这里按需读取即可。
  }, [handleStart, jobs, pendingIds]);

  /** 全部同步：只同步已启用的源（停用的源服务端也会拒绝拉取）。 */
  const syncAllSources = useCallback(async (enabledIds: string[]) => {
    const targets = enabledIds.filter((id) => !syncingIds.has(id));
    if (!targets.length) return;
    setStartingAll(true);
    markPending(targets, true);
    try {
      handleStart(await subscriptionAggregatorAPI.syncSources(targets), targets);
    } catch (error) {
      markPending(targets, false);
      message.error(aggregatorErrorText(responseErrorCode(error), '同步订阅源失败'));
    } finally {
      if (mounted.current) setStartingAll(false);
    }
  }, [handleStart, jobs, pendingIds]);

  /** 保存 / 导入后服务端顺带起的任务，交给同一套状态追踪。 */
  const trackJob = useCallback((job: AggregatorSyncJob | null | undefined) => {
    if (job) applyJob(job);
  }, [applyJob]);

  /** 某个源最近一次同步的结果（列表行内展示失败原因用）。 */
  const lastResultFor = useCallback((subscriptionId: string) => {
    let latest: AggregatorSyncJob['items'][number] | null = null;
    for (const job of jobs.values()) {
      const item = job.items.find((candidate) => candidate.sourceId === subscriptionId);
      if (item && item.finishedAt && (!latest || (item.finishedAt || 0) > (latest.finishedAt || 0))) latest = item;
    }
    return latest;
  }, [jobs]);

  return {
    syncingIds,
    syncingAll: startingAll || [...jobs.values()].some((job) => !job.finishedAt && job.items.length > 1),
    syncSource,
    syncAllSources,
    trackJob,
    lastResultFor
  };
}
