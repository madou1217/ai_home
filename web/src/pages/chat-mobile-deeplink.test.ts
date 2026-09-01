import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldMobileDeepLinkEnterChat } from './chat-mobile-deeplink.ts';

const restoredSession = {
  id: 's-1',
  title: '会话',
  updatedAt: 100,
  provider: 'claude',
  projectPath: '/repo/alpha',
} as any;

test('深链带 sessionId 且恢复命中会话时进入详情屏', () => {
  assert.equal(
    shouldMobileDeepLinkEnterChat({ sessionId: 's-1', provider: 'claude' }, restoredSession),
    true,
  );
});

test('初始选择没有 sessionId 时不进入（正常打开停列表屏）', () => {
  assert.equal(shouldMobileDeepLinkEnterChat({}, restoredSession), false);
  assert.equal(shouldMobileDeepLinkEnterChat({ projectPath: '/repo/alpha' }, restoredSession), false);
});

test('恢复尚未命中/草稿会话时不进入', () => {
  assert.equal(shouldMobileDeepLinkEnterChat({ sessionId: 's-1' }, null), false);
  assert.equal(
    shouldMobileDeepLinkEnterChat({ sessionId: 's-1' }, { ...restoredSession, draft: true }),
    false,
  );
});
