import assert from 'node:assert/strict';
import test from 'node:test';

import type { ManagementRestartEvent } from '@/types';
import {
  buildServerConfigPatch,
  describeRestartState,
  formatRefreshInterval,
  parseRefreshInterval,
  toUsageConfig,
  toUsageFormValues,
  validateWallpaperFile
} from './settings-config';

test('刷新间隔：字符串 ↔ 秒', () => {
  assert.equal(parseRefreshInterval('45s'), 45);
  assert.equal(parseRefreshInterval('5m'), 300);
  assert.equal(parseRefreshInterval('2h'), 7200);
  assert.equal(parseRefreshInterval('bogus'), 60);
  assert.equal(formatRefreshInterval(45), '45s');
  assert.equal(formatRefreshInterval(150), '2m');
  assert.equal(formatRefreshInterval(3600), '1h');
  const values = toUsageFormValues({ threshold_pct: 90, active_refresh_interval: '1m', background_refresh_interval: '1h' });
  assert.deepEqual(values, { threshold_pct: 90, active_refresh_interval: 60, background_refresh_interval: 3600 });
  assert.deepEqual(toUsageConfig(values), { threshold_pct: 90, active_refresh_interval: '1m', background_refresh_interval: '1h' });
});

test('服务配置载荷：开放网络强制 0.0.0.0，空密钥不提交', () => {
  assert.deepEqual(buildServerConfigPatch({ host: '10.0.0.2', port: 8080, openNetwork: true, apiKey: ' ', managementKey: '' }), {
    managementKey: '',
    patch: { host: '0.0.0.0', port: 8080, openNetwork: true }
  });
  assert.deepEqual(buildServerConfigPatch({ host: '', openNetwork: false, apiKey: ' sk-1 ', managementKey: ' mk ' }), {
    managementKey: 'mk',
    patch: { host: '127.0.0.1', port: 9527, openNetwork: false, apiKey: 'sk-1' }
  });
});

test('重启状态文案', () => {
  const event = (status: ManagementRestartEvent['status'], extra: Partial<ManagementRestartEvent> = {}): ManagementRestartEvent => ({
    type: 'restart', jobId: 'j', status, createdAt: 0, updatedAt: 0, ...extra
  });
  assert.equal(describeRestartState(null, false), null);
  assert.deepEqual(describeRestartState(null, true), { type: 'info', message: '服务重启已排队' });
  assert.deepEqual(describeRestartState(event('starting'), true), { type: 'info', message: '服务正在重启' });
  assert.deepEqual(describeRestartState(event('started', { pid: 42 }), false), { type: 'success', message: '服务重启已启动，pid 42' });
  assert.deepEqual(describeRestartState(event('failed'), false), { type: 'error', message: '重启服务失败' });
});

test('壁纸文件校验', () => {
  assert.equal(validateWallpaperFile({ type: 'text/plain', size: 10 }), '请选择图片文件');
  assert.equal(validateWallpaperFile({ type: 'image/png', size: 3 * 1024 * 1024 }), '图片不能超过 2MB');
  assert.equal(validateWallpaperFile({ type: 'image/png', size: 1024 }), '');
});
