import { describe, expect, test } from 'bun:test';
import {
  describeApplyResult,
  describeEgressError,
  describeRuntimeStatus,
  isRetiredEgressBinding
} from './zcode-egress-presentation';

describe('account egress presentation', () => {
  test('maps apply statuses to concise outcomes', () => {
    expect(describeApplyResult(null)).toBe(null);
    expect(describeApplyResult({ ok: true, applied: true, status: 'applied' })).toEqual({
      color: 'success',
      label: '已应用',
      text: '出口可用：网关请求立即生效；桌面端与 CLI 下次启动生效。'
    });
    expect(describeApplyResult({ ok: true, applied: true, status: 'restarted', restarted: true, pid: 7102 })?.label)
      .toBe('已重启');
    expect(describeApplyResult({ ok: true, applied: true, status: 'cleared' })?.label).toBe('已解除');
  });

  test('reports a failed apply as rolled back instead of losing the prior outlet', () => {
    expect(describeApplyResult({
      ok: false,
      applied: false,
      error: 'proxy_unreachable',
      reason: 'curl_exit_7',
      rolledBack: true
    })).toEqual({
      color: 'warning',
      label: '已回退',
      text: '新出口不可用，已恢复原绑定（代理出口连通性探测失败：curl_exit_7）'
    });
    expect(describeApplyResult({ ok: false, applied: false, error: 'tun_inactive' })?.text)
      .toBe('应用失败：未检测到已激活的外部 TUN');
  });

  test('summarizes what the binding resolves to without probing', () => {
    expect(describeRuntimeStatus(null)).toEqual({ state: 'idle', text: '未绑定出口' });
    expect(describeRuntimeStatus({
      resolved: { ok: true, source: 'system', proxyServer: 'http://127.0.0.1:6152', direct: false },
      desktopRunning: false,
      desktopPid: null
    })).toEqual({ state: 'ready', text: '经系统代理出口' });
    expect(describeRuntimeStatus({
      resolved: { ok: true, source: 'tun', proxyServer: '', direct: true },
      desktopRunning: true,
      desktopPid: 12
    }).text).toBe('外部 TUN 已激活，账号流量由 TUN 接管');
    expect(describeRuntimeStatus({
      resolved: { ok: false, error: 'account_egress_mode_retired' },
      desktopRunning: false,
      desktopPid: null
    })).toEqual({ state: 'error', text: '出口不可用：节点 / 分组出口已下线，请改绑' });
  });

  test('flags retired node/group bindings and keeps unknown codes readable', () => {
    expect(isRetiredEgressBinding({ mode: 'group', retired: true, proxyUrl: '', updatedAt: 1 })).toBe(true);
    expect(isRetiredEgressBinding({ mode: 'url', proxyUrl: '127.0.0.1:6152', updatedAt: 1 })).toBe(false);
    expect(describeEgressError('something_new')).toBe('something_new');
    expect(describeEgressError('')).toBe('未知错误');
  });
});
