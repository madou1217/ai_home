'use strict';

// 矩阵守卫：harness 名单必须和 provider 真值源一一对上。
//
// 名单不写死在测试里，而是从 contracts/providers/manifest.json 派生 —— 新增 provider
// 却忘了登记 adapter，这里会红；反过来登记了不存在的 provider，这里也会红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = require('../contracts/providers/manifest.json');
const registry = require('../lib/agent-session/registry');
const facade = require('../lib/agent-session/facade');
const { ADAPTER_TRANSPORTS, INTERACTION_KINDS, SUPPORT_LEVELS } = require('../lib/agent-session/contracts');

// 不在 provider manifest 里、但属于本层的外部 harness（lib/harness/catalog.js）。
const EXTERNAL_TUI_HARNESSES = ['pi', 'dsh-tui'];
// desktop 会话：明确不做，不是「还没写」。
const DESKTOP_PROVIDERS = ['zcode', 'workbuddy', 'workbuddycn'];

const MANIFEST_IDS = manifest.providers.map((entry) => entry.id);

function registeredProviders() {
  return registry.listHarnessAdapterRows().map((row) => row.provider);
}

test('every manifest provider is either registered or explicitly excluded', () => {
  for (const provider of MANIFEST_IDS) {
    const registered = registry.getHarnessAdapter(provider);
    const excluded = registry.isExcludedHarness(provider);
    assert.ok(
      Boolean(registered) !== Boolean(excluded),
      `provider ${provider} must be registered xor excluded (registered=${Boolean(registered)}, excluded=${excluded})`
    );
  }
});

test('the registry never invents providers outside the manifest', () => {
  const known = new Set([...MANIFEST_IDS, ...EXTERNAL_TUI_HARNESSES]);
  for (const provider of registeredProviders()) {
    assert.ok(known.has(provider), `registry declares unknown provider ${provider}`);
  }
});

test('external TUI harnesses are registered', () => {
  for (const provider of EXTERNAL_TUI_HARNESSES) {
    assert.ok(registry.getHarnessAdapter(provider), `missing adapter row for ${provider}`);
  }
});

test('desktop providers are excluded and never registered', () => {
  for (const provider of DESKTOP_PROVIDERS) {
    assert.equal(registry.getHarnessAdapter(provider), null, `${provider} is desktop and must not be registered`);
    assert.ok(registry.isExcludedHarness(provider), `${provider} must be listed as excluded with a reason`);
  }
  for (const row of registry.listExcludedHarnesses()) {
    assert.ok(row.reason && row.reason.trim(), `excluded ${row.provider} needs a reason`);
  }
});

test('every harness has at least one candidate and every candidate has capabilities', () => {
  for (const row of registry.listHarnessAdapterRows()) {
    assert.ok(row.candidates.length > 0, `${row.provider} has no adapter candidate`);
    assert.ok(Number.isInteger(row.phase) && row.phase >= 0, `${row.provider} needs a phase`);
    const resolved = registry.resolveAdapterCandidates(row.provider);
    assert.equal(resolved.length, row.candidates.length);
    for (const candidate of resolved) {
      assert.ok(candidate.capabilities, `${row.provider} -> ${candidate.adapterId} has no capability row`);
    }
  }
});

test('adapter capability rows and implementation slots are the same set', () => {
  const declared = registry.listAdapterCapabilityRows().map((row) => row.adapter).sort();
  const slots = Object.keys(facade.ADAPTER_MODULES).sort();
  assert.deepEqual(slots, declared);
  for (const row of registry.listAdapterCapabilityRows()) {
    assert.ok(ADAPTER_TRANSPORTS.includes(row.transport), `${row.adapter} has an unregistered transport ${row.transport}`);
  }
});

test('capability claims are self-evidencing', () => {
  for (const row of registry.listAdapterCapabilityRows()) {
    for (const kind of INTERACTION_KINDS) {
      const entry = row.interactions[kind];
      assert.ok(entry, `${row.adapter} does not answer ${kind}`);
      assert.ok(SUPPORT_LEVELS.includes(entry.level), `${row.adapter}.${kind} has level ${entry.level}`);
      if (entry.level === 'unsupported') {
        assert.ok(entry.reason, `${row.adapter}.${kind} says unsupported without a reason`);
      } else {
        assert.ok(entry.evidence, `${row.adapter}.${kind} claims ${entry.level} without evidence`);
      }
    }
  }
});

test('no provider-name dispatch outside the registry', () => {
  const root = path.join(__dirname, '..', 'lib', 'agent-session');
  const offenders = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    if (entry.name === 'registry.js') continue;
    // 注释里允许写反例（"不要写 provider === x"），只扫真实代码。
    const source = fs.readFileSync(path.join(root, entry.name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/provider\s*===?\s*['"]/.test(source)) offenders.push(entry.name);
  }
  assert.deepEqual(offenders, [], 'provider 分支只能出现在 registry.js 的数据行里');
});

test('facade resolves by data, not by provider branch', () => {
  for (const row of registry.listHarnessAdapterRows()) {
    const described = facade.describeProvider(row.provider);
    assert.equal(described.provider, row.provider);
    assert.equal(described.candidates.length, row.candidates.length);
    assert.ok(described.candidates.every((candidate) => typeof candidate.implemented === 'boolean'));
  }
  assert.equal(facade.describeProvider('nope'), null);
});

test('excluded and unknown providers fail closed with distinct codes', () => {
  assert.throws(
    () => facade.resolveAdapter('zcode'),
    (error) => error.code === 'agent_session_harness_excluded'
  );
  assert.throws(
    () => facade.resolveAdapter('nope'),
    (error) => error.code === 'agent_session_harness_unknown'
  );
  assert.throws(
    () => facade.resolveAdapter(''),
    (error) => error.code === 'agent_session_provider_required'
  );
});

test('an unimplemented adapter reports what it tried', () => {
  const row = registry.getHarnessAdapter('codex');
  const attempted = row.candidates.every((adapterId) => !facade.isAdapterImplemented(adapterId));
  if (!attempted) return; // 对应 phase 落地后这条断言自然失效
  assert.throws(
    () => facade.resolveAdapter('codex'),
    (error) => error.code === 'agent_session_adapter_unavailable'
      && error.details.attempted.length === row.candidates.length
  );
});
