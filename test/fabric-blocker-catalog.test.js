'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeBlocker,
  explainBlockers,
  normalizeBlockerCode
} = require('../lib/cli/services/fabric/blocker-catalog');

test('blocker catalog strips domain prefixes and maps AWS cloud edge blockers', () => {
  assert.equal(normalizeBlockerCode('turn:turn_default_udp_9527_unreachable'), 'turn_default_udp_9527_unreachable');

  const detail = describeBlocker('turn:turn_default_udp_9527_unreachable', {
    endpoint: 'http://aws.example:9527',
    nodeId: 'aws-current-node'
  });

  assert.equal(detail.domain, 'cloud_edge');
  assert.equal(detail.owner, 'cloud_operator');
  assert.equal(detail.external, true);
  assert.equal(detail.command, 'aih fabric transport cloud-edge --endpoint http://aws.example:9527 --json');
});

test('blocker catalog classifies default UDP probe busy as diagnostic concurrency', () => {
  const detail = describeBlocker('turn:turn_default_udp_probe_busy', {
    endpoint: 'http://aws.example:9527'
  });

  assert.equal(normalizeBlockerCode('turn:turn_default_udp_probe_busy'), 'turn_default_udp_probe_busy');
  assert.equal(detail.domain, 'diagnostic_concurrency');
  assert.equal(detail.owner, 'aih');
  assert.equal(detail.external, false);
  assert.equal(detail.requiresConfirmation, false);
  assert.match(detail.nextAction, /one default UDP transport diagnostic/);
});

test('blocker catalog classifies target-local UDP proof as diagnostic context', () => {
  const detail = describeBlocker('turn:turn_default_udp_target_local_only', {
    endpoint: 'http://aws.example:9527'
  });

  assert.equal(normalizeBlockerCode('turn:turn_default_udp_target_local_only'), 'turn_default_udp_target_local_only');
  assert.equal(detail.domain, 'diagnostic_context');
  assert.equal(detail.owner, 'aih');
  assert.equal(detail.external, false);
  assert.equal(detail.requiresConfirmation, false);
  assert.match(detail.reason, /target node itself/);
  assert.match(detail.nextAction, /client side/);
});

test('blocker catalog classifies provider auth blockers as operator-owned', () => {
  const detail = describeBlocker('claude:auth_invalid:claude_not_logged_in', {
    endpoint: 'http://control.example.com:9527'
  });

  assert.equal(normalizeBlockerCode('provider_account_unavailable:agy'), 'provider_account_unavailable');
  assert.equal(normalizeBlockerCode('claude:auth_invalid:claude_not_logged_in'), 'claude_not_logged_in');
  assert.equal(detail.domain, 'provider_account');
  assert.equal(detail.owner, 'operator');
  assert.equal(detail.requiresConfirmation, true);
  assert.match(detail.command, /--endpoint http:\/\/control\.example\.com:9527/);
  assert.match(detail.command, /--providers claude/);
});

test('blocker catalog orders core blockers before external advanced transport work', () => {
  const details = explainBlockers([
    'webtransport:webtransport_endpoint_not_configured',
    'ready_server_profile_missing',
    'aws_iam_role_missing'
  ]);

  assert.deepEqual(details.map((item) => item.domain), [
    'server_profile',
    'cloud_api',
    'webtransport'
  ]);
});

test('blocker catalog classifies local AWS API readback blockers as cloud API work', () => {
  const detail = describeBlocker('aws_local_credentials_missing', {
    endpoint: 'http://aws.example:9527'
  });

  assert.equal(detail.domain, 'cloud_api');
  assert.equal(detail.owner, 'cloud_operator');
  assert.equal(detail.external, true);
  assert.match(detail.nextAction, /local AWS CLI/);
});
