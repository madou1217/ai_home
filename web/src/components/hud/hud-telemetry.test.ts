import assert from 'node:assert/strict';
import test from 'node:test';

import { formatHudCount, formatHudPercent, formatHudUptime } from './hud-format';
import { resolveHudNavCode } from './hud-nav';
import { deriveGatewayState } from './use-hud-telemetry';
import type { ManagementStatus } from '@/types';

function status(patch: Partial<ManagementStatus>): ManagementStatus {
  return {
    ok: true,
    backend: 'codex-adapter',
    host: '127.0.0.1',
    port: 9527,
    apiKeyConfigured: false,
    providerMode: 'auto',
    strategy: 'random',
    totalAccounts: 0,
    activeAccounts: 0,
    cooldownAccounts: 0,
    statusTotals: {},
    providers: {},
    sessionAffinity: {},
    queue: {},
    modelsCached: 0,
    modelsUpdatedAt: 0,
    modelRegistryUpdatedAt: 0,
    successRate: 0,
    timeoutRate: 0,
    totalRequests: 0,
    uptimeSec: 0,
    ...patch,
  };
}

test('网关状态只由真实 ManagementStatus 字段推导', () => {
  assert.equal(deriveGatewayState(null, false), 'connecting');
  assert.equal(deriveGatewayState(null, true), 'offline');
  assert.equal(deriveGatewayState(status({ ok: false }), false), 'offline');
  assert.equal(deriveGatewayState(status({ totalAccounts: 0 }), false), 'empty');
  assert.equal(deriveGatewayState(status({ totalAccounts: 3, activeAccounts: 0 }), false), 'degraded');
  assert.equal(deriveGatewayState(status({ totalAccounts: 3, activeAccounts: 2 }), false), 'online');
  // 请求失败时即使有旧快照也显示离线
  assert.equal(deriveGatewayState(status({ totalAccounts: 3, activeAccounts: 2 }), true), 'offline');
});

test('HUD 数值格式化', () => {
  assert.equal(formatHudUptime(3), '0m 03s');
  assert.equal(formatHudUptime(3725), '1h 02m');
  assert.equal(formatHudUptime(90061), '1d 01h 01m');
  assert.equal(formatHudPercent(0.9721), '97.2%');
  assert.equal(formatHudPercent(Number.NaN), '—');
  assert.equal(formatHudCount(12345), '12,345');
  assert.equal(formatHudCount(undefined), '—');
});

test('导航代号覆盖全部真实菜单路由', () => {
  for (const path of ['/dashboard', '/accounts', '/chat', '/usage', '/models', '/toolkit', '/studio', '/fabric', '/settings']) {
    assert.ok(resolveHudNavCode(path)?.no, `${path} 缺少编号`);
  }
  assert.equal(resolveHudNavCode('/fabric/servers')?.no, undefined);
  assert.equal(resolveHudNavCode('/unknown'), null);
});
