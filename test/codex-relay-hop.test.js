'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CODEX_RELAY_HOP_HEADER,
  MAX_CODEX_RELAY_HOPS,
  readCodexRelayHop,
  exceedsCodexRelayHopLimit,
  nextCodexRelayHop
} = require('../lib/server/codex-relay-hop');

// 回归：跨机中转（本机网关 → 远程 server 网关）必须放行一跳。
// 缺陷形态：把「跳数头存在」直接当成自环并 508，于是本机把远程 server 当上游时，
// 对端一律回 `Gateway proxy loop detected`，WebUI 会话表现为
// `stream disconnected before completion`。要防的是 A→B→A 的无限环���不是一跳中转。
test('codex relay hop allows exactly one cross-machine hop', () => {
  assert.equal(MAX_CODEX_RELAY_HOPS, 1);
  assert.equal(CODEX_RELAY_HOP_HEADER, 'x-aih-codex-relay-hop');

  // 直连本网关：无头 = 0 跳，放行。
  assert.equal(readCodexRelayHop({}), 0);
  assert.equal(exceedsCodexRelayHopLimit({}), false);

  // 一跳中转（本机 → 远程）：放行。
  assert.equal(readCodexRelayHop({ [CODEX_RELAY_HOP_HEADER]: '1' }), 1);
  assert.equal(exceedsCodexRelayHopLimit({ [CODEX_RELAY_HOP_HEADER]: '1' }), false);

  // 两跳：出现环，拒绝。
  assert.equal(exceedsCodexRelayHopLimit({ [CODEX_RELAY_HOP_HEADER]: '2' }), true);
  assert.equal(exceedsCodexRelayHopLimit({ [CODEX_RELAY_HOP_HEADER]: '99' }), true);

  // 头名大小写不敏感；数组形态取首值。
  assert.equal(readCodexRelayHop({ 'X-Aih-Codex-Relay-Hop': '1' }), 1);
  assert.equal(readCodexRelayHop({ [CODEX_RELAY_HOP_HEADER]: ['1'] }), 1);

  // 缺失/非法一律按 0（不把畸形头当成环，也不让它绕过上限）。
  for (const bad of ['', 'abc', '-1', '1.5', null, undefined, {}]) {
    assert.equal(readCodexRelayHop({ [CODEX_RELAY_HOP_HEADER]: bad }), 0, `bad=${String(bad)}`);
  }

  // 出站跳数递增：对端据此判断这条链还能不能再往下转。
  assert.equal(nextCodexRelayHop({}), '1');
  assert.equal(nextCodexRelayHop({ [CODEX_RELAY_HOP_HEADER]: '1' }), '2');
});
