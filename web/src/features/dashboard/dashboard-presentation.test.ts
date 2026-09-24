import assert from 'node:assert/strict';
import test from 'node:test';

import type { ManagementMetrics, ManagementStatus } from '@/types';
import {
  buildChatJumpPath,
  buildProviderRows,
  buildRouteRows,
  buildRuntimeParams,
  describeErrorPipeline,
  extractProjectBasename,
  formatSessionShortId,
  formatUptime,
  getOverallHealth,
  getOverallHealthMeta,
  getSuccessTone,
  normalizeQueueCount,
  resolveFriendlyAccountDisplay,
  sumRunningQueue
} from './dashboard-presentation.ts';

const status = {
  backend: 'node',
  host: '127.0.0.1',
  port: 9527,
  apiKeyConfigured: true,
  providerMode: 'auto',
  strategy: 'round_robin',
  providers: { codex: { total: 3, active: 2, statuses: { healthy: 2, rate_limited: 1 } } },
  queue: {
    codex: { name: 'codex', running: 4, queued: 1, maxConcurrency: 8, queueLimit: 0, totalScheduled: 0, totalRejected: 0 },
    claude: { name: 'claude', running: 2.7, queued: 0, maxConcurrency: 1, queueLimit: 0, totalScheduled: 0, totalRejected: 0 }
  },
  sessionAffinity: { total: 5 },
  modelsCached: 12
} as unknown as ManagementStatus;

const metrics = {
  providerCounts: { codex: 10 },
  providerSuccess: { codex: 9 },
  providerFailures: { codex: 1 },
  routeCounts: { '/v1/responses': 3, '/v1/messages': 9, '/v1/chat/completions': 1 }
} as unknown as ManagementMetrics;

test('success tone follows the desktop thresholds and ignores empty traffic', () => {
  assert.equal(getSuccessTone(0, 0.2), 'neutral');
  assert.equal(getSuccessTone(10, 0.95), 'healthy');
  assert.equal(getSuccessTone(10, 0.8), 'warning');
  assert.equal(getSuccessTone(10, 0.79), 'error');
});

test('overall health uses persisted accounts as the denominator', () => {
  assert.equal(getOverallHealth({ statusLoaded: false, accountsLoaded: true, total: 2, healthy: 2 }), 'loading');
  assert.equal(getOverallHealth({ statusLoaded: true, accountsLoaded: true, total: 2, healthy: 2 }), 'healthy');
  assert.equal(getOverallHealth({ statusLoaded: true, accountsLoaded: true, total: 3, healthy: 1 }), 'degraded');
  assert.equal(getOverallHealth({ statusLoaded: true, accountsLoaded: true, total: 0, healthy: 0 }), 'critical');
  assert.deepEqual(getOverallHealthMeta('degraded', 2), { label: '2 个账号降级', dot: 'warn' });
});

test('provider and route rows are derived from status + metrics only', () => {
  const rows = buildProviderRows(status, metrics);
  const codex = rows.find((row) => row.provider === 'codex');
  assert.deepEqual(
    codex && { total: codex.total, active: codex.active, requests: codex.requests, success: codex.success, failures: codex.failures },
    { total: 3, active: 2, requests: 10, success: 9, failures: 1 }
  );
  assert.equal(rows.find((row) => row.provider === 'gemini')?.total, 0);
  assert.deepEqual(buildRouteRows(metrics, 2).map((row) => row.route), ['/v1/messages', '/v1/responses']);
  assert.equal(sumRunningQueue(status), 6);
  assert.equal(normalizeQueueCount('x', 1), 1);
});

test('runtime params and uptime formatting match the desktop panel', () => {
  assert.equal(formatUptime(3725), '1h 2m');
  assert.equal(formatUptime(65), '1m 5s');
  assert.equal(formatUptime(null), '-');
  const params = new Map(buildRuntimeParams(status, 42));
  assert.equal(params.get('监听地址'), '127.0.0.1:9527');
  assert.equal(params.get('Sticky Session'), 5);
  assert.equal(params.get('运行时长'), '42s');
});

test('recent error helpers resolve account, pipeline and chat jump target', () => {
  assert.equal(resolveFriendlyAccountDisplay({ accountLabel: 'Work' }), 'Work');
  assert.equal(resolveFriendlyAccountDisplay({ provider: 'codex', attemptedCount: 3 }), '尝试了 3 个账号');
  const pipeline = describeErrorPipeline({
    familyProvider: 'claude',
    effectiveProvider: 'codex',
    clientProtocol: 'anthropic_messages',
    requestedModel: 'sonnet',
    effectiveModel: 'gpt-5'
  });
  assert.equal(pipeline.isCrossRoute, true);
  assert.equal(pipeline.isAlias, true);
  assert.equal(pipeline.sourceProtocolLabel, 'Claude (Messages)');
  assert.equal(extractProjectBasename('/home/me/proj/'), 'proj');
  assert.equal(formatSessionShortId('0123456789abcdefXYZ'), '0123456…efXYZ');
  assert.equal(buildChatJumpPath({}), '/chat');
  assert.equal(buildChatJumpPath({ projectPath: '/a b', sessionId: 's1' }), '/chat?projectPath=%2Fa+b&sessionId=s1');
});
