'use strict';

const { normalizeModelUsageCostUsd } = require('./model-usage-precision');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DASHBOARD_SHARDS = 16;
const MODEL_SUM_FIELDS = Object.freeze([
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'costUsd'
]);
const STATS_SUM_FIELDS = Object.freeze([
  'totalCalls',
  'totalPrompts',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'totalCostUsd'
]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createCancelledError() {
  const error = new Error('model_usage_query_cancelled');
  error.code = 'model_usage_query_cancelled';
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) throw createCancelledError();
}

function planDashboardShards(query = {}, options = {}) {
  const fromMs = Math.max(0, Math.round(Number(query.fromMs) || 0));
  const toMs = Math.max(fromMs, Math.round(Number(query.toMs) || fromMs));
  const spanMs = toMs - fromMs + 1;
  const targetShardMs = positiveInteger(options.targetShardMs, DAY_MS);
  const maxShards = positiveInteger(options.maxShards, MAX_DASHBOARD_SHARDS);
  const shardCount = Math.max(1, Math.min(maxShards, Math.ceil(spanMs / targetShardMs)));
  const chronological = Array.from({ length: shardCount }, (_unused, index) => ({
    fromMs: fromMs + Math.floor((spanMs * index) / shardCount),
    toMs: fromMs + Math.floor((spanMs * (index + 1)) / shardCount) - 1
  }));
  return chronological.reverse();
}

function timestampWithinShard(value, shard) {
  const timestampMs = Number(value);
  return Number.isFinite(timestampMs)
    && timestampMs >= shard.fromMs
    && timestampMs <= shard.toMs;
}

function selectProjectionContextForShard(context = {}, shard) {
  const attributions = Array.isArray(context.attributions) ? context.attributions : [];
  return {
    forkDescriptors: Array.isArray(context.forkDescriptors) ? context.forkDescriptors : [],
    recordHighWaterId: context.recordHighWaterId,
    promptHighWaterRowId: context.promptHighWaterRowId,
    attributions: attributions.filter((attribution) => {
      const scannerTimestampMs = Number(attribution && attribution.scannerTimestampMs);
      const proxyTimestampMs = Number(attribution && attribution.proxyTimestampMs);
      if (!Number.isFinite(scannerTimestampMs) || !Number.isFinite(proxyTimestampMs)) {
        return true;
      }
      return timestampWithinShard(scannerTimestampMs, shard)
        || timestampWithinShard(proxyTimestampMs, shard);
    })
  };
}

function emptyDashboardStats() {
  return {
    totalCalls: 0,
    totalSessions: 0,
    totalPrompts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0
  };
}

function compareBinary(left, right) {
  return Buffer.compare(Buffer.from(String(left || ''), 'utf8'), Buffer.from(String(right || ''), 'utf8'));
}

function binaryMax(left, right) {
  const leftValue = String(left || '');
  const rightValue = String(right || '');
  return compareBinary(leftValue, rightValue) >= 0 ? leftValue : rightValue;
}

function minPositive(left, right) {
  const leftValue = Number(left) || 0;
  const rightValue = Number(right) || 0;
  if (!leftValue) return Math.max(0, rightValue);
  if (!rightValue) return Math.max(0, leftValue);
  return Math.min(leftValue, rightValue);
}

function createDashboardAccumulator(query = {}) {
  return {
    limit: Math.max(1, Math.min(500, positiveInteger(query.limit, 50))),
    stats: emptyDashboardStats(),
    models: new Map(),
    modelOptions: new Map(),
    sessions: new Map()
  };
}

function mergeModelRows(target, rows) {
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const provider = String(row && row.provider || '').trim().toLowerCase();
    const model = String(row && row.model || '').trim();
    if (!provider || !model) return;
    const key = `${provider}\0${model}`;
    let merged = target.get(key);
    if (!merged) {
      merged = { provider, model };
      MODEL_SUM_FIELDS.forEach((field) => { merged[field] = 0; });
      target.set(key, merged);
    }
    MODEL_SUM_FIELDS.forEach((field) => {
      merged[field] += Number(row[field]) || 0;
    });
  });
}

function mergeSessionParts(target, parts) {
  (Array.isArray(parts) ? parts : []).forEach((part) => {
    const provider = String(part && part.provider || '').trim().toLowerCase();
    const sessionId = String(part && part.sessionId || '').trim();
    if (!provider || !sessionId) return;
    const key = `${provider}\0${sessionId}`;
    let merged = target.get(key);
    if (!merged) {
      merged = {
        provider,
        sessionId,
        usageProject: '',
        sessionProject: '',
        usageCwd: '',
        sessionCwd: '',
        usageGitBranch: '',
        sessionGitBranch: '',
        usageStartedAtMs: 0,
        sessionStartedAtMs: 0,
        usageUpdatedAtMs: 0,
        sessionUpdatedAtMs: 0,
        promptCount: 0,
        calls: 0,
        totalTokens: 0,
        costUsd: 0
      };
      target.set(key, merged);
    }
    ['usageProject', 'sessionProject', 'usageCwd', 'sessionCwd', 'usageGitBranch', 'sessionGitBranch']
      .forEach((field) => { merged[field] = binaryMax(merged[field], part[field]); });
    merged.usageStartedAtMs = minPositive(merged.usageStartedAtMs, part.usageStartedAtMs);
    merged.sessionStartedAtMs = minPositive(merged.sessionStartedAtMs, part.sessionStartedAtMs);
    merged.usageUpdatedAtMs = Math.max(merged.usageUpdatedAtMs, Number(part.usageUpdatedAtMs) || 0);
    merged.sessionUpdatedAtMs = Math.max(merged.sessionUpdatedAtMs, Number(part.sessionUpdatedAtMs) || 0);
    merged.promptCount += Number(part.promptCount) || 0;
    merged.calls += Number(part.calls) || 0;
    merged.totalTokens += Number(part.totalTokens) || 0;
    merged.costUsd += Number(part.costUsd) || 0;
  });
}

function mergeDashboardShard(accumulator, shard = {}) {
  STATS_SUM_FIELDS.forEach((field) => {
    accumulator.stats[field] += Number(shard.stats && shard.stats[field]) || 0;
  });
  mergeModelRows(accumulator.models, shard.models);
  mergeModelRows(accumulator.modelOptions, shard.modelOptions);
  mergeSessionParts(accumulator.sessions, shard.sessionParts);
  accumulator.stats.totalSessions = accumulator.sessions.size;
  return accumulator;
}

function compareModelRows(left, right) {
  return (right.costUsd - left.costUsd)
    || (right.totalTokens - left.totalTokens)
    || (right.calls - left.calls)
    || compareBinary(left.model, right.model)
    || compareBinary(left.provider, right.provider);
}

function materializeSession(part) {
  return {
    provider: part.provider,
    sessionId: part.sessionId,
    project: part.usageProject || part.sessionProject || '',
    cwd: part.usageCwd || part.sessionCwd || '',
    gitBranch: part.usageGitBranch || part.sessionGitBranch || '',
    startedAtMs: part.sessionStartedAtMs || part.usageStartedAtMs || 0,
    updatedAtMs: part.sessionUpdatedAtMs || part.usageUpdatedAtMs || 0,
    promptCount: part.promptCount,
    calls: part.calls,
    totalTokens: part.totalTokens,
    costUsd: normalizeModelUsageCostUsd(part.costUsd)
  };
}

function compareSessions(left, right) {
  return (right.updatedAtMs - left.updatedAtMs)
    || compareBinary(left.provider, right.provider)
    || compareBinary(left.sessionId, right.sessionId);
}

function snapshotDashboardAccumulator(accumulator) {
  return {
    stats: {
      ...accumulator.stats,
      totalSessions: accumulator.sessions.size,
      totalCostUsd: normalizeModelUsageCostUsd(accumulator.stats.totalCostUsd)
    },
    models: Array.from(accumulator.models.values())
      .map((row) => ({ ...row, costUsd: normalizeModelUsageCostUsd(row.costUsd) }))
      .sort(compareModelRows),
    sessions: Array.from(accumulator.sessions.values())
      .map(materializeSession)
      .sort(compareSessions)
      .slice(0, accumulator.limit),
    modelOptions: Array.from(accumulator.modelOptions.values())
      .map((row) => ({ ...row, costUsd: normalizeModelUsageCostUsd(row.costUsd) }))
      .sort(compareModelRows)
  };
}

async function runProgressiveDashboardQuery(options = {}) {
  const { executor, query = {}, signal, onProgress } = options;
  if (!executor || typeof executor.execute !== 'function') {
    const error = new Error('model_usage_query_executor_unavailable');
    error.code = 'model_usage_query_executor_unavailable';
    throw error;
  }
  throwIfCancelled(signal);
  const projectionContext = await executor.execute('prepareDashboardQuery', query);
  throwIfCancelled(signal);
  const shards = planDashboardShards(query, options);
  const accumulator = createDashboardAccumulator(query);
  const executorState = typeof executor.getState === 'function' ? executor.getState() : {};
  const concurrency = Math.min(
    shards.length,
    positiveInteger(options.concurrency, positiveInteger(executorState && executorState.concurrency, 4))
  );
  let nextShardIndex = 0;
  let completedShards = 0;
  let failure = null;

  async function runNextShards() {
    while (!failure && !(signal && signal.aborted)) {
      const shardIndex = nextShardIndex;
      if (shardIndex >= shards.length) return;
      nextShardIndex += 1;
      const shard = shards[shardIndex];
      let result;
      try {
        result = await executor.execute('getDashboardShard', {
          ...query,
          ...shard,
          projectionContext: selectProjectionContextForShard(projectionContext, shard)
        });
      } catch (error) {
        failure = failure || error;
        return;
      }
      if (failure || (signal && signal.aborted)) return;
      mergeDashboardShard(accumulator, result);
      completedShards += 1;
      if (typeof onProgress === 'function') {
        onProgress({
          completedShards,
          totalShards: shards.length,
          dashboard: snapshotDashboardAccumulator(accumulator)
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runNextShards));
  if (failure) throw failure;
  throwIfCancelled(signal);
  return snapshotDashboardAccumulator(accumulator);
}

module.exports = {
  DAY_MS,
  MAX_DASHBOARD_SHARDS,
  createDashboardAccumulator,
  mergeDashboardShard,
  planDashboardShards,
  runProgressiveDashboardQuery,
  selectProjectionContextForShard,
  snapshotDashboardAccumulator
};
