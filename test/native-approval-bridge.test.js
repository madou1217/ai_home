'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bridge = require('../lib/server/native-approval-bridge');

test('expired approval requests are denied and removed from pending indexes', () => {
  const responses = [];
  const entry = bridge.registerApprovalRequest(
    { runId: `approval-test-${Date.now()}`, toolName: 'test', input: { value: 'x' } },
    (response) => responses.push(response)
  );
  entry.createdAt = Date.now() - bridge.APPROVAL_TTL_MS - 1;

  assert.equal(bridge.pruneExpiredApprovals(), 1);
  assert.equal(bridge.getPendingApproval(entry.approvalId), null);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], {
    behavior: 'deny',
    message: '审批等待已超时，请重新发起操作'
  });
});
