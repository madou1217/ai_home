import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PlanImplementationRuntimePort,
} from './plan-implementation-workflow';
import {
  PLAN_IMPLEMENTATION_MESSAGE,
  PlanImplementationWorkflow,
} from './plan-implementation-workflow';
import type {
  FreshPlanRuntimePort,
  FreshPlanRuntimeSession,
} from './fresh-plan-implementation-workflow';
import {
  FRESH_PLAN_IMPLEMENTATION_PREFIX,
  FreshPlanImplementationError,
  FreshPlanImplementationWorkflow,
  FreshPlanRuntimeOpenError,
} from './fresh-plan-implementation-workflow';

test('current plan implementation retries an uncertain submit with the same command identity', async () => {
  const calls: unknown[] = [];
  let submitAttempts = 0;
  const port: PlanImplementationRuntimePort = {
    async confirmPolicy(commandId) { calls.push({ policy: commandId }); },
    async submit(commandId, content) {
      calls.push({ submit: commandId, content });
      submitAttempts += 1;
      if (submitAttempts === 1) throw new Error('response lost');
    },
  };
  const workflow = new PlanImplementationWorkflow(port, idSequence(
    'policy-command-1',
    'submit-command-1',
  ));

  await assert.rejects(workflow.execute('plan-turn-1'), /response lost/);
  await workflow.execute('plan-turn-1');

  assert.deepEqual(calls, [
    { policy: 'policy-command-1' },
    { submit: 'submit-command-1', content: PLAN_IMPLEMENTATION_MESSAGE },
    { submit: 'submit-command-1', content: PLAN_IMPLEMENTATION_MESSAGE },
  ]);
});

test('current plan implementation retries policy before it can submit', async () => {
  const calls: unknown[] = [];
  let policyAttempts = 0;
  const workflow = new PlanImplementationWorkflow({
    async confirmPolicy(commandId) {
      calls.push({ policy: commandId });
      policyAttempts += 1;
      if (policyAttempts === 1) throw new Error('policy response lost');
    },
    async submit(commandId, content) { calls.push({ submit: commandId, content }); },
  }, idSequence('policy-command-1', 'submit-command-1'));

  await assert.rejects(workflow.execute('plan-turn-1'), /policy response lost/);
  await workflow.execute('plan-turn-1');

  assert.deepEqual(calls, [
    { policy: 'policy-command-1' },
    { policy: 'policy-command-1' },
    { submit: 'submit-command-1', content: PLAN_IMPLEMENTATION_MESSAGE },
  ]);
});

test('fresh plan implementation opens an unbound Default-mode runtime and returns both identities', async () => {
  const calls: unknown[] = [];
  const session: FreshPlanRuntimeSession = {
    canonicalSessionId: 'canonical-fresh-1',
    async submit(commandId, content) { calls.push({ commandId, content }); },
    async waitForNativeSessionId() { calls.push('wait'); return 'native-fresh-1'; },
    close() { calls.push('close'); },
  };
  const port: FreshPlanRuntimePort = {
    async open(target) { calls.push({ target }); return session; },
  };
  const workflow = new FreshPlanImplementationWorkflow(
    port,
    () => 'fresh-submit-command-1',
  );

  const result = await workflow.execute({
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    nativeSessionId: 'native-old',
    policy: { approvalMode: 'plan' },
  }, 'plan-turn-1', '- Inspect\n- Implement');

  assert.deepEqual(result, {
    canonicalSessionId: 'canonical-fresh-1',
    nativeSessionId: 'native-fresh-1',
  });
  assert.deepEqual(calls, [
    { target: {
      provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
      policy: { approvalMode: 'confirm' },
    } },
    {
      commandId: 'fresh-submit-command-1',
      content: `${FRESH_PLAN_IMPLEMENTATION_PREFIX}\n\n- Inspect\n- Implement`,
    },
    'wait',
    'close',
  ]);
});

test('fresh binding retry stays attached to the known canonical session', async () => {
  const calls: unknown[] = [];
  let waitAttempts = 0;
  const session: FreshPlanRuntimeSession = {
    canonicalSessionId: 'canonical-fresh-1',
    async submit(commandId) { calls.push({ submit: commandId }); },
    async waitForNativeSessionId() {
      calls.push('wait');
      waitAttempts += 1;
      if (waitAttempts === 1) throw new Error('chat_fresh_native_session_pending');
      return 'native-fresh-1';
    },
    close() { calls.push('close'); },
  };
  const port: FreshPlanRuntimePort = {
    async open() { calls.push('open'); return session; },
  };
  const workflow = new FreshPlanImplementationWorkflow(
    port,
    () => 'fresh-submit-command-1',
  );
  const target = {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
    policy: { approvalMode: 'plan' as const },
  };

  await assert.rejects(
    workflow.execute(target, 'plan-turn-1', 'Plan'),
    (error: unknown) => {
      assert.ok(error instanceof FreshPlanImplementationError);
      assert.equal(error.message, 'chat_fresh_native_session_pending');
      assert.equal(error.canonicalSessionId, 'canonical-fresh-1');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.deepEqual(await workflow.execute(target, 'plan-turn-1', 'Plan'), {
    canonicalSessionId: 'canonical-fresh-1',
    nativeSessionId: 'native-fresh-1',
  });
  assert.deepEqual(calls, [
    'open',
    { submit: 'fresh-submit-command-1' },
    'wait',
    'wait',
    'close',
  ]);
});

test('fresh submit retry reuses the canonical session and command identity', async () => {
  const calls: unknown[] = [];
  let submitAttempts = 0;
  const session: FreshPlanRuntimeSession = {
    canonicalSessionId: 'canonical-fresh-1',
    async submit(commandId) {
      calls.push({ submit: commandId });
      submitAttempts += 1;
      if (submitAttempts === 1) throw new Error('response lost');
    },
    async waitForNativeSessionId() { calls.push('wait'); return 'native-fresh-1'; },
    close() { calls.push('close'); },
  };
  const workflow = new FreshPlanImplementationWorkflow({
    async open() { calls.push('open'); return session; },
  }, () => 'fresh-submit-command-1');
  const target = {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
    policy: { approvalMode: 'plan' as const },
  };

  await assert.rejects(
    workflow.execute(target, 'plan-turn-1', 'Plan'),
    (error: unknown) => {
      assert.ok(error instanceof FreshPlanImplementationError);
      assert.equal(error.message, 'chat_fresh_plan_submission_pending');
      assert.equal(error.canonicalSessionId, 'canonical-fresh-1');
      return true;
    },
  );
  await workflow.execute(target, 'plan-turn-1', 'Plan');

  assert.deepEqual(calls, [
    'open',
    { submit: 'fresh-submit-command-1' },
    { submit: 'fresh-submit-command-1' },
    'wait',
    'close',
  ]);
});

test('fresh initialization retry resumes the canonical session returned by create', async () => {
  const calls: unknown[] = [];
  const session: FreshPlanRuntimeSession = {
    canonicalSessionId: 'canonical-fresh-1',
    async submit(commandId) { calls.push({ submit: commandId }); },
    async waitForNativeSessionId() { calls.push('wait'); return 'native-fresh-1'; },
    close() { calls.push('close'); },
  };
  const workflow = new FreshPlanImplementationWorkflow({
    async open() {
      calls.push('open');
      throw new FreshPlanRuntimeOpenError(
        'canonical-fresh-1',
        new Error('snapshot unavailable'),
      );
    },
    async resume(canonicalSessionId) {
      calls.push({ resume: canonicalSessionId });
      return session;
    },
  }, () => 'fresh-submit-command-1');
  const target = {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
    policy: { approvalMode: 'plan' as const },
  };

  await assert.rejects(
    workflow.execute(target, 'plan-turn-1', 'Plan'),
    (error: unknown) => {
      assert.ok(error instanceof FreshPlanImplementationError);
      assert.equal(error.message, 'chat_fresh_session_initialization_pending');
      assert.equal(error.canonicalSessionId, 'canonical-fresh-1');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.deepEqual(await workflow.execute(target, 'plan-turn-1', 'Plan'), {
    canonicalSessionId: 'canonical-fresh-1',
    nativeSessionId: 'native-fresh-1',
  });
  assert.deepEqual(calls, [
    'open',
    { resume: 'canonical-fresh-1' },
    { submit: 'fresh-submit-command-1' },
    'wait',
    'close',
  ]);
});

test('indeterminate fresh session creation fails closed on retry', async () => {
  let opens = 0;
  const workflow = new FreshPlanImplementationWorkflow({
    async open() {
      opens += 1;
      throw new Error('connection reset');
    },
  }, () => 'fresh-submit-command-1');
  const target = {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
    policy: { approvalMode: 'plan' as const },
  };

  await assert.rejects(
    async () => workflow.execute(target, 'plan-turn-1', 'Plan'),
    /chat_fresh_session_creation_indeterminate/,
  );
  await assert.rejects(
    async () => workflow.execute(target, 'plan-turn-1', 'Plan'),
    /chat_fresh_session_creation_indeterminate/,
  );
  assert.equal(opens, 1);
});

function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('test_command_id_exhausted');
    return id;
  };
}
