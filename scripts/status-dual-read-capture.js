'use strict';

// §7-d 双读比对夹具生成器（Node 侧真值）。
//
// 为什么需要它：Go 的 core/accounts/status_transition.go 是 Node state-service 的逐条移植，
// 但「照抄」不等于「等价」。这里用 Node **真实的**纯函数（touchAccountFailureState /
// clearRuntimeBlock / deriveAccountRuntimeStatus）跑一组固定事件，把每一步的结果冻结成
// testdata/status-dual-read.json；Go 侧测试再跑同一组事件逐字段比对。
//
// 纪律：
//   * 时钟必须可控：Date.now 在整段回放期间固定为事件时刻（clearRuntimeBlock 内部有
//     直接读 Date.now 的分支）；
//   * 只覆盖账号级路径，模型级冷却另测；
//   * 夹具是生成物，不要手改——改矩阵后重新生成并提交。

const fs = require('node:fs');
const path = require('node:path');

const { createAccountStateService, RUNTIME_CLEAR_EVIDENCE } = require('../lib/account/state-service');
const {
  normalizeAccountRuntime,
  touchAccountFailureState,
  deriveAccountRuntimeStatus
} = require('../lib/server/account-runtime-state');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const FIXTURE_PATH = path.join(__dirname, '..', 'testdata', 'status-dual-read.json');

// 事件矩阵：每一步都给出确切时刻，便于两端逐字段比对。
function matrix() {
  const base = 1_790_000_000_000;
  return [
    {
      name: 'codex_auth_invalid_then_login_success',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'auth_invalid', reason: '401 unauthorized', cooldownMs: 300_000 } },
        { op: 'clear', atMs: base + 60_000, evidence: 'login_success' }
      ]
    },
    {
      name: 'codex_rate_limited_then_manual_clear',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'rate_limited', reason: '429', cooldownMs: 60_000 } },
        { op: 'clear', atMs: base + 10_000, evidence: 'manual_admin_clear' }
      ]
    },
    {
      name: 'codex_overloaded_then_usage_success',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'overloaded', reason: 'overloaded', cooldownMs: 30_000 } },
        { op: 'clear', atMs: base + 5_000, evidence: 'direct_usage_success' }
      ]
    },
    {
      name: 'codex_network_error_no_clear_before_until',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'network_error', reason: 'ECONNRESET', cooldownMs: 120_000 } },
        { op: 'clear', atMs: base + 1_000, evidence: 'models_probe_success' },
        { op: 'clear', atMs: base + 130_000, evidence: 'models_probe_success' }
      ]
    },
    {
      name: 'codex_quota_exhausted_block_then_manual_clear',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'quota_exhausted', reason: 'quota exhausted', cooldownMs: 0 } },
        { op: 'clear', atMs: base + 60_000, evidence: 'manual_admin_clear' }
      ]
    },
    {
      name: 'codex_permission_denied_block_kept_by_unrelated_evidence',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'permission_denied', reason: '403', cooldownMs: 0 } },
        { op: 'clear', atMs: base + 30_000, evidence: 'credential_update_after_failure' }
      ]
    },
    {
      name: 'codex_runtime_state_replace_and_clear',
      provider: 'codex',
      initial: {
        cooldownUntil: base + 900_000,
        consecutiveFailures: 2,
        successCount: 3,
        failCount: 2,
        lastError: 'boom',
        lastFailureKind: 'rate_limited',
        lastFailureReason: '429',
        lastFailureAt: base - 1_000,
        lastSuccessAt: base - 2_000,
        rateLimitUntil: base + 900_000,
        authInvalidUntil: 0,
        overloadUntil: 0,
        networkUntil: 0,
        serviceUnavailableUntil: 0,
        upstreamErrorUntil: 0,
        routingBlock: null,
        modelCooldowns: {},
        modelFailureStreaks: {}
      },
      steps: [
        { op: 'runtime_state', atMs: base + 1_000, state: null },
        { op: 'runtime_state', atMs: base + 2_000, state: { lastFailureKind: 'auth_invalid', lastFailureReason: '401', authInvalidUntil: base + 600_000, cooldownUntil: base + 600_000 } }
      ]
    },
    {
      name: 'agy_permission_denied_region_block',
      provider: 'agy',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'permission_denied', reason: 'agy_region_not_eligible', cooldownMs: 0 } }
      ]
    },
    {
      name: 'codex_service_unavailable_repeated_extends_until',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'service_unavailable', reason: '503', cooldownMs: 60_000 } },
        { op: 'failure', atMs: base + 10_000, failure: { kind: 'service_unavailable', reason: '503', cooldownMs: 60_000 } }
      ]
    },
    {
      name: 'codex_upstream_error_then_upstream_success',
      provider: 'codex',
      steps: [
        { op: 'failure', atMs: base, failure: { kind: 'upstream_error', reason: 'boom', cooldownMs: 30_000 } },
        { op: 'clear', atMs: base + 40_000, evidence: 'upstream_success' }
      ]
    }
  ];
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

// replay 用真实 state-service 在内存索引上回放一组事件。
function replay(entry) {
  const state = {
    accountRef: ACCOUNT_REF,
    provider: entry.provider,
    status: 'up',
    runtimeState: clone(entry.initial) || null,
    updatedAt: 0
  };
  const index = {
    getAccountState: () => (state.runtimeState || state.updatedAt
      ? { accountRef: ACCOUNT_REF, provider: entry.provider, status: state.status, runtimeState: state.runtimeState, updatedAt: state.updatedAt }
      : { accountRef: ACCOUNT_REF, provider: entry.provider, status: state.status, runtimeState: null, updatedAt: 0 }),
    upsertRuntimeState: (_ref, _provider, runtimeState) => {
      state.runtimeState = clone(runtimeState) || null;
      state.updatedAt = Date.now();
      return true;
    },
    upsertAccountState: () => true,
    clearRuntimeState: () => { state.runtimeState = null; return true; }
  };
  const service = createAccountStateService({ accountStateIndex: index });
  const afterEach = [];
  const originalNow = Date.now;
  try {
    for (const step of entry.steps) {
      Date.now = () => step.atMs;
      if (step.op === 'failure') {
        const current = clone(state.runtimeState) || {};
        const next = touchAccountFailureState(current, {
          kind: step.failure.kind,
          failureReason: step.failure.reason,
          cooldownMs: step.failure.cooldownMs,
          routingBlockRecheck: step.failure.routingBlockRecheck
        }, step.atMs);
        service.recordRuntimeFailure(ACCOUNT_REF, entry.provider, normalizeAccountRuntime(next, step.atMs));
      } else if (step.op === 'clear') {
        if (!RUNTIME_CLEAR_EVIDENCE.has(step.evidence)) throw new Error('证据未登记: ' + step.evidence);
        service.clearRuntimeBlock(ACCOUNT_REF, entry.provider, { evidence: step.evidence });
      } else if (step.op === 'runtime_state') {
        service.recordRuntimeState(ACCOUNT_REF, entry.provider, clone(step.state));
      } else {
        throw new Error('未知步骤: ' + step.op);
      }
      const snapshot = state.runtimeState
        ? normalizeAccountRuntime(clone(state.runtimeState), step.atMs)
        : null;
      afterEach.push({
        atMs: step.atMs,
        runtimeState: snapshot,
        status: deriveAccountRuntimeStatus(snapshot, step.atMs).status
      });
    }
  } finally {
    Date.now = originalNow;
  }
  return afterEach;
}

function build() {
  return {
    version: 1,
    generatedBy: 'scripts/status-dual-read-capture.js',
    accountRef: ACCOUNT_REF,
    cases: matrix().map((entry) => ({
      name: entry.name,
      provider: entry.provider,
      initial: clone(entry.initial) || null,
      steps: entry.steps,
      expected: { afterEach: replay(entry) }
    }))
  };
}

function serialize(document) {
  return JSON.stringify(document, null, 2) + '\n';
}

function main() {
  const document = build();
  const serialized = serialize(document);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';
    if (current !== serialized) {
      console.error('[status-dual-read] 夹具与 Node 行为不一致，请重新生成：node scripts/status-dual-read-capture.js');
      process.exit(1);
    }
    console.log('[status-dual-read] 夹具与 Node 行为一致');
    return;
  }
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, serialized);
  console.log('[status-dual-read] wrote ' + FIXTURE_PATH + ' cases=' + document.cases.length);
}

if (require.main === module) main();

module.exports = { build, serialize, matrix, replay, FIXTURE_PATH };
