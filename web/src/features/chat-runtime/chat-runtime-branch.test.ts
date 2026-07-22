import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@/types';
import {
  renderChatRuntimeBranch,
  resolveChatRuntimeBranch,
} from './chat-runtime-branch';

function session(provider: Session['provider']): Session {
  return {
    id: `${provider}-session`,
    provider,
    title: 'Session',
    updatedAt: 1,
    projectPath: '/repo',
  };
}

test('canonical branch does not construct the legacy runtime', () => {
  let legacyConstructed = false;
  const selected = renderChatRuntimeBranch(session('codex'), {
    empty: () => 'empty',
    canonical: () => 'canonical',
    legacy: () => {
      legacyConstructed = true;
      return 'legacy';
    },
  });

  assert.equal(selected, 'canonical');
  assert.equal(legacyConstructed, false);
});

test('Codex API-key accounts stay on legacy runtime where their model catalog is supported', () => {
  const apiKeyAccount = {
    provider: 'codex' as const,
    accountRef: 'key-1',
    status: 'up' as const,
    displayName: 'Key',
    configured: true,
    apiKeyMode: true,
    remainingPct: null,
    updatedAt: 1,
    planType: 'api-key',
    email: '',
  };
  assert.equal(resolveChatRuntimeBranch(session('codex'), apiKeyAccount), 'legacy');
});

test('legacy and empty branches remain explicit composition choices', () => {
  assert.equal(resolveChatRuntimeBranch(session('claude')), 'legacy');
  assert.equal(resolveChatRuntimeBranch(null), 'empty');
});
