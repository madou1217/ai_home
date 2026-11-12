'use strict';

// `aih agent` 的展示层：只验路由/退出码/JSON 形状。
// 真值仍在 lib/agent-session/registry，这里不重复断言能力内容。

const test = require('node:test');
const assert = require('node:assert/strict');

const { runAgentCommand, parseArgs } = require('../lib/cli/commands/agent-router');
const registry = require('../lib/agent-session/registry');

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    out: () => out.join(''),
    err: () => err.join('')
  };
}

test('parseArgs separates action, provider and flags', () => {
  assert.deepEqual(parseArgs(['capabilities', 'codex', '--json']), {
    action: 'capabilities', provider: 'codex', json: true, help: false
  });
  assert.deepEqual(parseArgs([]), { action: '', provider: '', json: false, help: false });
});

test('adapters lists every registered harness', async () => {
  const sink = capture();
  const code = await runAgentCommand(['adapters'], sink);
  assert.equal(code, 0);
  const text = sink.out();
  for (const row of registry.listHarnessAdapterRows()) {
    assert.ok(text.includes(row.provider), `missing ${row.provider}`);
  }
});

test('adapters --json is machine readable and keeps the exclusion list', async () => {
  const sink = capture();
  const code = await runAgentCommand(['adapters', '--json'], sink);
  assert.equal(code, 0);
  const payload = JSON.parse(sink.out());
  assert.equal(payload.ok, true);
  assert.equal(payload.adapters.length, registry.listHarnessAdapterRows().length);
  assert.deepEqual(
    payload.excluded.map((row) => row.provider),
    registry.listExcludedHarnesses().map((row) => row.provider)
  );
});

test('capabilities requires a known provider', async () => {
  const missing = capture();
  assert.equal(await runAgentCommand(['capabilities'], missing), 1);
  assert.match(missing.err(), /capabilities <provider>/);

  const unknown = capture();
  assert.equal(await runAgentCommand(['capabilities', 'nope'], unknown), 1);
  assert.match(unknown.err(), /未登记/);

  const ok = capture();
  assert.equal(await runAgentCommand(['capabilities', 'gemini'], ok), 0);
  assert.match(ok.out(), /acp-stdio/);
  assert.match(ok.out(), /审批/);
});

test('probe reports what it tried when nothing is implemented', async () => {
  const sink = capture();
  const code = await runAgentCommand(['probe', 'codex', '--json'], sink);
  const payload = JSON.parse(sink.out());
  if (code === 0) {
    assert.equal(payload.ok, true);
    return;
  }
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'agent_session_adapter_unavailable');
  assert.deepEqual(
    payload.attempted.map((entry) => entry.adapterId),
    registry.getHarnessAdapter('codex').candidates
  );
});

test('unknown subcommands fail with a usage hint', async () => {
  const sink = capture();
  assert.equal(await runAgentCommand(['nope'], sink), 1);
  assert.match(sink.err(), /未知子命令/);
});
