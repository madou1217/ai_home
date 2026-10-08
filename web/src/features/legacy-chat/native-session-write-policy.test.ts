import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNativeSessionWriteBlock } from './native-session-write-policy';
import type { Session } from '@/types';

function nativeSession(provider: string): Session {
  return {
    id: 'sess_native_1',
    title: 'native',
    provider,
    projectPath: '/repo',
    updatedAt: Date.now(),
  } as unknown as Session;
}

test('draft and empty-provider sessions stay writable', () => {
  assert.equal(resolveNativeSessionWriteBlock(null), null);
  const draft = { ...nativeSession('zcode'), draft: true } as unknown as Session;
  assert.equal(resolveNativeSessionWriteBlock(draft), null, '新建会话走无状态推理，不受续写白名单约束');
  assert.equal(resolveNativeSessionWriteBlock(nativeSession('')), null, 'provider 缺失时不误伤');
});

test('backend OFFICIAL_NATIVE_SESSION_PROVIDERS members stay writable', () => {
  for (const provider of [
    'codex', 'claude', 'gemini', 'agy', 'opencode', 'grok', 'zcode',
    'qoder', 'qodercn', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'
  ]) {
    assert.equal(resolveNativeSessionWriteBlock(nativeSession(provider)), null, provider);
  }
});

test('non-writable native sessions are blocked with dedicated copy', () => {
  for (const provider of ['kimi', 'kiro']) {
    const block = resolveNativeSessionWriteBlock(nativeSession(provider));
    assert.ok(block && block.length > 0, provider);
    assert.match(block as string, /原生客户端/);
    assert.doesNotMatch(block as string, /已归档/, '独立文案，不复用归档提示');
  }
});
