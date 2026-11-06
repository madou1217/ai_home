'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GO_DELETION_PROVIDERS,
  GO_DELETION_REQUIRED_PROVIDERS,
  resolveGoDeletionMode
} = require('../lib/server/webui-account-routes');
const { PROVIDER_STORAGE_POLICIES } = require('../lib/runtime/provider-storage-policy');

const enabledGoHost = {
  isEnabled: () => true,
  deleteAccount: async () => ({ ok: true, status: 204 })
};
const disabledGoHost = {
  isEnabled: () => false,
  deleteAccount: async () => ({ ok: true, status: 204 })
};

test('codex/claude 未启用 Go Core 时 fail-closed', () => {
  for (const provider of ['codex', 'claude']) {
    assert.equal(resolveGoDeletionMode(provider, null), 'required_unavailable');
    assert.equal(resolveGoDeletionMode(provider, disabledGoHost), 'required_unavailable');
  }
});

test('gemini/grok 未启用 Go Core 时回落本地删除', () => {
  for (const provider of ['gemini', 'grok']) {
    assert.equal(resolveGoDeletionMode(provider, null), 'local_fallback');
    assert.equal(resolveGoDeletionMode(provider, disabledGoHost), 'local_fallback');
  }
});

test('Go Core 启用时已切换的四家都走 Go', () => {
  for (const provider of ['codex', 'claude', 'gemini', 'grok']) {
    assert.equal(resolveGoDeletionMode(provider, enabledGoHost), 'go');
  }
});

test('未接入 Go 的 Provider 继续走本地删除', () => {
  for (const provider of ['agy', 'opencode', 'kimi', 'kiro', 'zcode', 'cline']) {
    assert.equal(resolveGoDeletionMode(provider, enabledGoHost), 'local');
  }
});

test('Go 删除清单只包含存储策略表里存在的 Provider', () => {
  for (const provider of GO_DELETION_PROVIDERS) {
    assert.ok(PROVIDER_STORAGE_POLICIES[provider], `${provider} 不在 PROVIDER_STORAGE_POLICIES`);
  }
  for (const provider of GO_DELETION_REQUIRED_PROVIDERS) {
    assert.ok(GO_DELETION_PROVIDERS.includes(provider), `${provider} 必须在 Go 删除清单里`);
  }
});
