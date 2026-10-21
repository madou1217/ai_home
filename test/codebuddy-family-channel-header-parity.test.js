'use strict';

// 家族渠道校验头的**跨语言一致性守卫**。
//
// 为什么值得一个守卫：渠道校验（400 code 11128）只认会话三件套，而家族推理有**两条**独立
// 实现——Node 的 upstream-endpoints-transport-general（含 codebuddy-family-inference）
// 与 Go 的 codebuddyfamilyrelay。两侧各写一遍头名，任何一侧改名/漏写都会让那条路径的请求
// 被上游按「非官方客户端」拦下（2026-10-21 实测结论，见
// docs/architecture/codebuddy-family-channel-verification.md）。
//
// 这里钉三件事：
//   1. 两侧声明的头名集合完全一致（改名不会只改一边）；
//   2. 头名就是渠道校验实测必需的那三个（防止有人「顺手」多删一个）；
//   3. 两侧都把这些头真的写进了上游请求（不是只声明常量）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const GO_FAMILY_RELAY = path.join(ROOT, 'internal', 'transport', 'http', 'codebuddyfamilyrelay');

// 渠道校验实测必需的会话 ID 家族（唯一事实源：真上游二分实验的结论）。
// `X-Request-ID` 与 `X-Conversation-Message-ID` 官方同值，所以它也是必需项。
const REQUIRED_CHANNEL_HEADERS = Object.freeze([
  'X-Conversation-ID',
  'X-Conversation-Message-ID',
  'X-Conversation-Request-ID',
  'X-Request-ID'
]);

function readGoFile(name) {
  return fs.readFileSync(path.join(GO_FAMILY_RELAY, name), 'utf8');
}

// 从 Go 常量声明里抽出会话头名：`ConversationIDHeader = "X-Conversation-ID"`。
function goConversationHeaderNames() {
  const source = readGoFile('family_provider.go');
  const names = new Set();
  // 会话 ID 家族的常量名形如 ConversationIDHeader / ConversationRequestIDHeader /
  // RequestIDHeader / RootRequestIDHeader。身份头（Product/Domain/IDE*/Agent*/UserID 等）
  // 不属于这个家族，不纳入比对。
  const pattern = /^\s*(?:Conversation\w*|RootRequestID|RequestID)Header\s*=\s*"([^"]+)"/gm;
  let match = pattern.exec(source);
  while (match) {
    names.add(match[1]);
    match = pattern.exec(source);
  }
  return names;
}

test('Node 与 Go 声明的渠道校验会话头集合完全一致', () => {
  const { buildCodebuddyFamilyConversationHeaders } = require('../lib/account/codebuddy-family-inference');
  // Node 侧的头名是计算出来的：直接问构造函数要，避免测试里再抄一份字面量。
  // 大小写归一后比较：HTTP 头名大小写不敏感，Node 用全小写 key、Go 用驼峰是各自的惯用写法。
  const nodeNames = new Set(
    Object.keys(buildCodebuddyFamilyConversationHeaders('guarded-session')).map((n) => n.toLowerCase())
  );
  const goNames = new Set([...goConversationHeaderNames()].map((n) => n.toLowerCase()));
  assert.ok(nodeNames.size > 0, 'Node 必须声明渠道校验会话头');
  assert.ok(goNames.size > 0, 'Go 必须声明渠道校验会话头');
  assert.deepEqual(
    [...nodeNames].sort(),
    [...goNames].sort(),
    '两侧的会话头集合必须一致：任一侧改名/漏写都会让那条路径被上游按 11128 拦下'
  );
});

test('两侧都至少覆盖渠道校验实测必需的那几个会话头', () => {
  const { buildCodebuddyFamilyConversationHeaders } = require('../lib/account/codebuddy-family-inference');
  const declared = Object.keys(buildCodebuddyFamilyConversationHeaders('guarded-session')).map((n) => n.toLowerCase());
  // 必需项**一个都不能少**。额外多发的会话级头（如 x-root-request-id，官方画像的一部分）
  // 不判失败——多发只是噪音，漏发才会被上游按 11128 拦下。
  for (const required of REQUIRED_CHANNEL_HEADERS) {
    assert.ok(
      declared.includes(required.toLowerCase()),
      `Node 缺少渠道校验必需头 ${required}`
    );
  }
  // Go 侧同样逐个核对，避免只改了 Node 一边。
  const goLower = [...goConversationHeaderNames()].map((n) => n.toLowerCase());
  for (const required of REQUIRED_CHANNEL_HEADERS) {
    assert.ok(goLower.includes(required.toLowerCase()), `Go 缺少渠道校验必需头 ${required}`);
  }
});

test('两侧都真的把会话头写进了上游请求，而不只是声明常量', () => {
  // Node：头构造器把三件套并进上游头。
  const { buildCodebuddyFamilyUpstreamHeaders } = require('../lib/account/codebuddy-family-inference');
  const nodeHeaders = buildCodebuddyFamilyUpstreamHeaders('workbuddy', null, { sessionKey: 'guarded' });
  for (const name of REQUIRED_CHANNEL_HEADERS) {
    assert.ok(
      String(nodeHeaders[name.toLowerCase()] || '').trim(),
      `Node 上游头缺少 ${name}`
    );
  }
  // Go：DecorateUpstream 必须调用 ConversationHeaders（写头的那一步），否则常量声明形同虚设。
  const goProvider = readGoFile('provider.go');
  assert.match(
    goProvider,
    /func \(provider Provider\) DecorateUpstream[\s\S]*ConversationHeaders\(/,
    'Go 的 DecorateUpstream 必须写入 ConversationHeaders，否则该路径的请求会被 11128 拦下'
  );
});

test('两侧的会话头值都是非空且格式一致（毫秒时间戳前缀）', () => {
  const { createCodebuddyFamilyConversationId } = require('../lib/account/codebuddy-family-inference');
  const nowMs = 1_700_000_000_000;
  const stamp = nowMs.toString(16).padStart(12, '0');
  assert.ok(
    createCodebuddyFamilyConversationId(nowMs).replace(/-/g, '').startsWith(stamp),
    'Node 的会话 id 应以毫秒时间戳（12 位十六进制）开头，与官方 UUIDv7 形态一致'
  );
  // Go 侧同形（%012x）——两侧形状一致，上游只要求非空，形状统一便于排查。
  const goProvider = readGoFile('family_provider.go');
  assert.match(goProvider, /%012x/, 'Go 的会话 id 应使用同样的 12 位十六进制时间戳前缀');
  assert.match(goProvider, /-7"|7"\s*\+/, 'Go 的会话 id 应带 UUIDv7 版本位');
});
