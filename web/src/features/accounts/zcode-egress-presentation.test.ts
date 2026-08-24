import { describe, expect, test } from 'bun:test';
import {
  describeApplyResult,
  describeProxyGroupKind,
  describeRuntimeStatus,
  formatProxyGroupLabel
} from './zcode-egress-presentation';

describe('zcode egress presentation', () => {
  test('distinguishes automatic and manual groups', () => {
    expect(describeProxyGroupKind({ id: 'group-a', name: 'A', count: 2, kind: 'manual' })).toBe('手动组');
    expect(describeProxyGroupKind({ id: 'US', name: 'US', count: 3, kind: 'country' })).toBe('国家自动组');
    expect(formatProxyGroupLabel({ id: 'US', name: '美国', count: 3, icon: '🇺🇸' })).toBe('🇺🇸 美国 · 3 个节点');
  });

  test('reports a failed rotation as rolled back instead of losing the prior outlet', () => {
    expect(describeApplyResult({
      ok: false,
      applied: false,
      error: 'zcode_egress_rotate_no_healthy_candidate',
      reason: 'all offline',
      rolledBack: true
    })).toEqual({
      color: 'warning',
      text: '切换失败，已恢复原节点：all offline'
    });
  });

  test('reports first takeover as a precise ZCode restart instead of a sidecar reload', () => {
    expect(describeApplyResult({
      ok: true,
      applied: true,
      status: 'restarted',
      restarted: true,
      pid: 7102,
      previousPids: [7101]
    })).toEqual({
      color: 'success',
      text: '已接管并重启当前 ZCode 实例；ZCode 使用的账号固定本地端口保持不变。'
    });
  });

  test('summarizes runtime readiness without exposing implementation details', () => {
    expect(describeRuntimeStatus(null)).toBe('ZCode 账号出口尚未运行');
    expect(describeRuntimeStatus({
      running: true,
      dataPlaneReady: true,
      proxyServer: '127.0.0.1:23100',
      source: 'group',
      selectedNodeId: 'node-b',
      groupId: 'group-a',
      zcodePid: 12,
      canRotate: true,
      sidecar: {
        engine: 'sing-box',
        installed: true,
        running: true,
        dataPlaneReady: true,
        pid: 34,
        lastError: null
      },
      health: { monitoring: true }
    })).toBe('账号出口正在通过分组节点运行');
  });
});
