'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHookNoopOutput,
  buildHookReceiverBody,
  parseSenderArgs,
  runProviderSessionHookSender
} = require('../lib/server/provider-session-hook-sender');
const { MANAGED_HOOK_MARKER } = require('../lib/server/provider-session-hook-config');

test('parseSenderArgs extracts provider event and url', () => {
  const parsed = parseSenderArgs([
    MANAGED_HOOK_MARKER,
    '--provider', 'agy',
    '--event', 'Stop',
    '--url', 'http://127.0.0.1:9527/hook',
    '--timeout-ms', '1500'
  ]);

  assert.deepEqual(parsed, {
    provider: 'agy',
    eventName: 'Stop',
    url: 'http://127.0.0.1:9527/hook',
    timeoutMs: 1500
  });
});

test('buildHookReceiverBody wraps raw JSON without leaking text fields outside payload', () => {
  const body = buildHookReceiverBody(JSON.stringify({
    session_id: 's1',
    prompt: 'secret prompt',
    tool_input: { command: 'secret command' }
  }), {
    provider: 'codex',
    eventName: 'UserPromptSubmit'
  });

  assert.equal(body.provider, 'codex');
  assert.equal(body.eventName, 'UserPromptSubmit');
  assert.equal(body.payload.session_id, 's1');
  assert.equal(body.payload.prompt, 'secret prompt');
  assert.equal(body.prompt, undefined);
  assert.equal(body.tool_input, undefined);
});

test('buildHookNoopOutput returns provider-safe no-op JSON', () => {
  assert.deepEqual(buildHookNoopOutput('codex', 'Stop'), {});
  assert.deepEqual(buildHookNoopOutput('claude', 'Stop'), {});
  assert.deepEqual(buildHookNoopOutput('gemini', 'AfterAgent'), {});
  assert.deepEqual(buildHookNoopOutput('agy', 'Stop'), { decision: '' });
});

test('runProviderSessionHookSender posts event and writes only no-op stdout', async () => {
  const calls = [];
  const result = await runProviderSessionHookSender({
    argv: [
      MANAGED_HOOK_MARKER,
      '--provider', 'gemini',
      '--event', 'AfterAgent',
      '--url', 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook?provider=gemini&event=AfterAgent'
    ],
    stdin: JSON.stringify({
      session_id: 's1',
      prompt_response: 'secret response'
    }),
    postJson: async (url, payload) => {
      calls.push({ url, payload });
      return { ok: true, statusCode: 200 };
    }
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /provider=gemini/);
  assert.equal(calls[0].payload.provider, 'gemini');
  assert.equal(calls[0].payload.eventName, 'AfterAgent');
  assert.equal(calls[0].payload.payload.session_id, 's1');
  assert.equal(result.stdout, '{}');
  assert.equal(result.stderr, '');
});

test('runProviderSessionHookSender does not log sensitive payload on delivery failure', async () => {
  const result = await runProviderSessionHookSender({
    argv: [
      MANAGED_HOOK_MARKER,
      '--provider', 'claude',
      '--event', 'UserPromptSubmit',
      '--url', 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook?provider=claude&event=UserPromptSubmit'
    ],
    stdin: JSON.stringify({
      session_id: 's1',
      prompt: 'very sensitive prompt'
    }),
    postJson: async () => ({ ok: false, error: 'connect ECONNREFUSED' })
  });

  assert.equal(result.stdout, '{}');
  assert.match(result.stderr, /delivery failed provider=claude event=UserPromptSubmit/);
  assert.doesNotMatch(result.stderr, /very sensitive prompt/);
});
