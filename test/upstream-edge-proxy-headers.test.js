'use strict';

// 入站边缘头不得转发给上游的回归守卫。
//
// 事故现场（2026-11-04）：网关部署在 Cloudflare 后面，本地 codex 走
// https://proxy.meadeo.com/v1/responses 时稳定 502，而直连 http://<aws>:9527
// 稳定 200。根因不是 WAF、不是账号、也不是上游抖动：网关把入站请求头原样复制给
// 上游，cf-connecting-ip / cf-visitor / cf-warp-tag-id 一路传到了 chatgpt.com ——
// 它自己也在 Cloudflare 后面，见到这些头就把请求判成代理回环，回 403
// "Unable to load site"，网关再把 403 归类成 upstream_edge_blocked 并回 502。
//
// 实测矩阵（同一 token、同一 body，只加一个头）：
//   baseline / cdn-loop / cf-ray / cf-ipcountry / true-client-ip / x-real-ip /
//   forwarded  → 200
//   cf-connecting-ip / cf-visitor / cf-warp-tag-id → 502（每次必现）
//
// 教训：逐条枚举边缘头必然漏（cf-warp-tag-id 就是补第一版名单时漏掉的），所以规则
// 按 cf- 前缀走。守卫同时锁住"前缀规则生效"和"业务头不被误伤"。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EDGE_PROXY_HEADERS,
  EDGE_PROXY_HEADER_PREFIXES,
  isEdgeProxyHeader
} = require('../lib/server/upstream-endpoints-utils');
const {
  shouldSkipForwardHeader: shouldSkipGeneral
} = require('../lib/server/upstream-endpoints-headers');
const { __private: codexPrivate } = require('../lib/server/codex-adapter');

const IMPLEMENTATIONS = [
  ['upstream-endpoints-headers', shouldSkipGeneral],
  ['codex-adapter', codexPrivate.shouldSkipForwardHeader]
];

// 真实抓包得到的、经 proxy.meadeo.com 进来时 Cloudflare 注入的头。
const OBSERVED_CF_HEADERS = [
  'cf-connecting-ip',
  'cf-visitor',
  'cf-ray',
  'cf-ipcountry',
  'cf-warp-tag-id',
  'cdn-loop',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto'
];

// 事故里被证实会 100% 触发上游 403 的三个。
const PROVEN_BLOCKERS = ['cf-connecting-ip', 'cf-visitor', 'cf-warp-tag-id'];

test('cf- 前缀规则生效，且覆盖实测触发 403 的头', () => {
  assert.ok(EDGE_PROXY_HEADER_PREFIXES.includes('cf-'), 'cf- 前缀规则不能丢');
  for (const header of PROVEN_BLOCKERS) {
    assert.equal(isEdgeProxyHeader(header), true, `isEdgeProxyHeader 漏掉 ${header}`);
  }
  // 未逐一枚举过的新 CF 头也必须被前缀规则兜住。
  assert.equal(isEdgeProxyHeader('cf-some-future-feature'), true);
});

test('抓包得到的边缘头在两个转发实现里都被跳过（大小写无关）', () => {
  assert.ok(EDGE_PROXY_HEADERS.size > 0, '名单不能为空，否则守卫形同虚设');
  for (const [name, shouldSkip] of IMPLEMENTATIONS) {
    for (const header of OBSERVED_CF_HEADERS) {
      assert.equal(shouldSkip(header), true, `${name} 漏掉了 ${header}`);
      assert.equal(
        shouldSkip(header.toUpperCase()),
        true,
        `${name} 对 ${header.toUpperCase()} 不生效（大小写敏感）`
      );
    }
    for (const header of EDGE_PROXY_HEADERS) {
      assert.equal(shouldSkip(header), true, `${name} 漏掉了 ${header}`);
    }
  }
});

test('普通业务头不被误伤', () => {
  const keep = [
    'user-agent',
    'originator',
    'version',
    'session_id',
    'accept',
    'accept-encoding',
    'chatgpt-account-id',
    'x-aih-account-ref',
    'x-aih-account-email',
    'x-provider',
    'x-stainless-lang',
    'conversation_id'
  ];
  for (const [name, shouldSkip] of IMPLEMENTATIONS) {
    for (const header of keep) {
      assert.equal(shouldSkip(header), false, `${name} 误删了 ${header}`);
    }
  }
});

test('既有剥除规则不变', () => {
  const drop = ['host', 'authorization', 'content-length', 'x-account-ref', 'connection', 'transfer-encoding'];
  for (const [name, shouldSkip] of IMPLEMENTATIONS) {
    for (const header of drop) {
      assert.equal(shouldSkip(header), true, `${name} 应跳过 ${header}`);
    }
  }
});
