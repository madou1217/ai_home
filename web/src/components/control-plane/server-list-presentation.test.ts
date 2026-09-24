import assert from 'node:assert/strict';
import test from 'node:test';

import { getControlPlaneProfileStatus, summarizeControlPlaneServerMetrics } from './server-list-presentation';
import type { ControlPlaneProfile } from '@/types';

function profile(patch: Partial<ControlPlaneProfile>): ControlPlaneProfile {
  return {
    state: 'ready',
    lastError: '',
    accountCount: 5,
    activeAccountCount: 3,
    schedulableAccountCount: 2,
    sessionCount: 7,
    lastStatusSyncAt: 0,
    lastAccountsSyncAt: 0,
    lastSessionsSyncAt: 0,
    ...patch
  } as ControlPlaneProfile;
}

test('server metrics only expose counts that were actually synced', () => {
  assert.deepEqual(summarizeControlPlaneServerMetrics(profile({})), {
    unavailable: false,
    cachedSummary: '',
    accounts: null,
    sessions: null
  });
  const synced = summarizeControlPlaneServerMetrics(profile({ lastStatusSyncAt: 1, lastAccountsSyncAt: 1, lastSessionsSyncAt: 1 }));
  assert.deepEqual(synced.accounts, { active: 3, total: 5, schedulable: 2 });
  assert.equal(synced.sessions, 7);
  assert.equal(summarizeControlPlaneServerMetrics(profile({ lastStatusSyncAt: 1 })).accounts?.schedulable, 0);
});

test('degraded or erroring servers report cached data as unavailable', () => {
  const degraded = summarizeControlPlaneServerMetrics(profile({ state: 'degraded', lastStatusSyncAt: 1, lastSessionsSyncAt: 1 }));
  assert.equal(degraded.unavailable, true);
  assert.equal(degraded.cachedSummary, '账号 5 · 会话 7');
  assert.equal(summarizeControlPlaneServerMetrics(profile({ lastError: 'boom' })).unavailable, true);
  assert.equal(getControlPlaneProfileStatus('degraded').label, '连接异常');
  assert.equal(getControlPlaneProfileStatus('offline').tone, 'offline');
});
