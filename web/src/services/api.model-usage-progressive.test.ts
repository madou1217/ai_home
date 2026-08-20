import assert from 'node:assert/strict';
import test from 'node:test';

import * as apiModule from './api.ts';

test('dispatchModelUsageDashboardQueryPayload routes job and snapshot frames', () => {
  const dispatch = (apiModule as any).dispatchModelUsageDashboardQueryPayload;
  assert.equal(typeof dispatch, 'function');
  const jobs: any[] = [];
  const snapshots: any[][] = [];
  const handlers = {
    onJob: (job: any) => jobs.push(job),
    onSnapshot: (items: any[]) => snapshots.push(items)
  };
  const job = {
    id: 'usage-dashboard-query-1',
    status: 'running',
    completedShards: 1,
    totalShards: 3
  };

  dispatch({ type: 'usage-dashboard-query-job', job }, handlers);
  dispatch({ type: 'usage-dashboard-query-snapshot', jobs: [job] }, handlers);
  dispatch({ type: 'unrelated' }, handlers);

  assert.deepEqual(jobs, [job]);
  assert.deepEqual(snapshots, [[job]]);
});
