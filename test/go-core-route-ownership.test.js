'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyRoute,
  compileRouteTable,
  loadRouteOwnershipManifest,
  resolveGoOwnedEntryIds
} = require('../lib/server/go-core-route-ownership');

// 分类测试用真实 manifest（路径模板是稳定契约）；
// **所有权解析测试用合成 fixture** —— 否则每次真实划转都要改测试，
// 而测试要守的是「解析器的规则」，不是「今天划转到哪一条了」。
const manifest = loadRouteOwnershipManifest();
const table = compileRouteTable(manifest);

/**
 * 合成 manifest：全部 node_owned，与真实文件的所有权状态解耦。
 *
 * 两个字段都必须**显式合成**，不能从真实文件推导 ——
 * 2026-10-22 的回归正是这么来的：`4a983517` 按「数据面候选 14 条全部有 Go 实现」
 * 刷新了真实 manifest，而这里用 `entry.go_routes.length` 推导 `go_implementation`，
 * 于是真实文件一划转，合成 fixture 就跟着变，断言（期望 2 条）当场失效。
 *
 * `resolveGoOwnedEntryIds` 判「有没有 Go 实现」看的是 `go_routes`（见该函数），
 * 所以 fixture 必须把 `go_routes` 也归一到合成集合，只改 owner 字段是不够的。
 * 测试要守的是「解析器的规则」，不是「今天划转到哪一条了」。
 */
const FIXTURE_GO_IMPLEMENTED_IDS = new Set([
  'gateway.props',
  'gateway.models.detail',
  // 目录条目本身有 Go 实现，但它只能在**所有**推理路由都迁完之后才跟着迁
  // （见 CATALOG_ENTRY_ID / INFERENCE_ENTRY_IDS 的配对规则）。fixture 里必须有它，
  // 否则那条规则测不到 —— 会先被「该条目没有 Go 实现」拦下。
  'gateway.models.list',
  'gateway.openai.responses',
  'gateway.openai.responses.websocket',
  'gateway.openai.chat_completions',
  'gateway.anthropic.messages',
  'gateway.gemini.generate_content',
  'gateway.gemini.stream_generate_content',
  'gateway.images.generations',
  'gateway.images.edits',
  'gateway.vision.blobs'
]);

function fixtureManifest() {
  return {
    entries: manifest.entries.map((entry) => {
      const implemented = FIXTURE_GO_IMPLEMENTED_IDS.has(entry.id);
      return {
        ...entry,
        production_owner: 'node',
        migration_state: 'node_owned',
        // go_routes 是解析器判定「有 Go 实现」的唯一依据：合成一个稳定的占位路由，
        // 未实现的条目清空，让 fixture 完全不受真实划转状态影响。
        go_routes: implemented ? ['fixture_go_route'] : [],
        go_implementation: implemented ? 'private_canary' : 'out_of_scope',
        blockers: []
      };
    })
  };
}

test('classifyRoute maps every data-plane path to its manifest entry', () => {
  const cases = [
    ['GET', '/v1/models', 'gateway.models.list'],
    ['GET', '/v1/models/claude-sonnet-4', 'gateway.models.detail'],
    ['POST', '/v1/messages', 'gateway.anthropic.messages'],
    ['POST', '/v1/messages/count_tokens', 'gateway.anthropic.count_tokens'],
    ['POST', '/v1/chat/completions', 'gateway.openai.chat_completions'],
    ['POST', '/v1/responses', 'gateway.openai.responses'],
    ['POST', '/v1beta/models/gemini-2.5-pro:generateContent', 'gateway.gemini.generate_content'],
    ['POST', '/v1/models/gemini-2.5-pro:streamGenerateContent', 'gateway.gemini.stream_generate_content'],
    ['GET', '/v1/blobs/abc123', 'gateway.vision.blobs']
  ];
  for (const [method, pathname, expected] of cases) {
    assert.equal(classifyRoute(table, { method, pathname }), expected, `${method} ${pathname}`);
  }
});

test('classifyRoute prefers the most specific template and applies Node path normalization', () => {
  // `/v1/models/{id}` 不得吞掉 Gemini 的 `:generateContent`。
  assert.equal(
    classifyRoute(table, { method: 'POST', pathname: '/v1/models/x:generateContent' }),
    'gateway.gemini.generate_content'
  );
  assert.equal(classifyRoute(table, { method: 'POST', pathname: '/v1/v1/messages' }), 'gateway.anthropic.messages');
  assert.equal(classifyRoute(table, { transport: 'websocket', pathname: '/v1/responses' }), 'gateway.openai.responses.websocket');
  assert.equal(classifyRoute(table, { method: 'DELETE', pathname: '/v1/messages' }), '');
  assert.equal(classifyRoute(table, { method: 'GET', pathname: '/v1/unknown' }), '');
});

test('with nothing promoted and no canary, the default forwards nothing', () => {
  const resolved = resolveGoOwnedEntryIds(fixtureManifest(), []);
  assert.equal(resolved.entryIds.size, 0);
  assert.deepEqual(resolved.errors, []);
});

test('operator canary accepts data-plane entries that have a Go implementation', () => {
  const resolved = resolveGoOwnedEntryIds(fixtureManifest(), 'gateway.models.detail, gateway.anthropic.messages');
  assert.deepEqual([...resolved.entryIds].sort(), ['gateway.anthropic.messages', 'gateway.models.detail']);
  assert.deepEqual(resolved.canaryIds, ['gateway.models.detail', 'gateway.anthropic.messages']);
  assert.deepEqual(resolved.errors, []);
});

test('an invalid canary is rejected as a whole instead of partially applied', () => {
  for (const [requested, message] of [
    [['gateway.models.list', 'gateway.nope'], /unknown route entry: gateway\.nope/],
    [['gateway.readiness'], /owned by the Node host/],
    [['node.fabric_surface'], /owned by the Node host/],
    [['gateway.openai.responses'], /must move together/]
  ]) {
    const resolved = resolveGoOwnedEntryIds(fixtureManifest(), requested);
    assert.equal(resolved.entryIds.size, 0, String(requested));
    assert.match(resolved.errors.join('\n'), message);
  }
  const paired = resolveGoOwnedEntryIds(fixtureManifest(), ['gateway.openai.responses', 'gateway.openai.responses.websocket']);
  assert.deepEqual(paired.errors, []);
  assert.equal(paired.entryIds.size, 2);
});

test('entries formally marked go_owned are forwarded without an operator canary', () => {
  const promoted = {
    entries: fixtureManifest().entries.map((entry) => (entry.id === 'gateway.props'
      ? { ...entry, production_owner: 'go', migration_state: 'go_owned' }
      : entry))
  };
  assert.deepEqual([...resolveGoOwnedEntryIds(promoted, []).entryIds], ['gateway.props']);
});

test('the model catalog moves to Go only after every inference route', () => {
  const { CATALOG_ENTRY_ID, INFERENCE_ENTRY_IDS } = require('../lib/server/go-core-route-ownership');
  const manifest = fixtureManifest();
  const alone = resolveGoOwnedEntryIds(manifest, [CATALOG_ENTRY_ID]);
  assert.equal(alone.entryIds.size, 0);
  assert.match(alone.errors[0], /moves only after every inference route/);

  const partial = resolveGoOwnedEntryIds(manifest, [CATALOG_ENTRY_ID, 'gateway.anthropic.messages']);
  assert.equal(partial.errors.length, 1);

  const complete = resolveGoOwnedEntryIds(manifest, [CATALOG_ENTRY_ID, ...INFERENCE_ENTRY_IDS, 'gateway.vision.blobs']);
  assert.deepEqual(complete.errors, []);
  assert.equal(complete.entryIds.has(CATALOG_ENTRY_ID), true);

  // 目录无关的只读条目可以独立划转。
  assert.deepEqual(resolveGoOwnedEntryIds(manifest, ['gateway.props', 'gateway.models.detail']).errors, []);
});

test('image entry points and blob retrieval move to Go together', () => {
  const manifest = fixtureManifest();
  const partial = resolveGoOwnedEntryIds(manifest, ['gateway.images.generations', 'gateway.images.edits']);
  assert.match(partial.errors.join('\n'), /must move together/);
  const complete = resolveGoOwnedEntryIds(manifest, ['gateway.images.generations', 'gateway.images.edits', 'gateway.vision.blobs']);
  assert.deepEqual(complete.errors, []);
});
