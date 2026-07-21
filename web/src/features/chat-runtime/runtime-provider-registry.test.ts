import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account } from '@/types';
import {
  RuntimeProviderRegistry,
  type RuntimeProviderDescriptor,
} from './runtime-provider-registry';

test('registry extends provider composition without changing surface policy', () => {
  const descriptor: RuntimeProviderDescriptor = {
    provider: 'claude',
    acceptsAccount: (account): account is Account => (
      account.provider === 'claude' && !account.apiKeyMode
    ),
  };
  const registry = new RuntimeProviderRegistry([descriptor]);
  assert.equal(registry.resolve('claude'), descriptor);
  assert.equal(registry.resolve('codex'), undefined);
});

test('registry enumerates registered providers for canonical directory discovery', () => {
  const codex: RuntimeProviderDescriptor = {
    provider: 'codex',
    acceptsAccount: (account): account is Account => account.provider === 'codex',
  };
  const claude: RuntimeProviderDescriptor = {
    provider: 'claude',
    acceptsAccount: (account): account is Account => account.provider === 'claude',
  };

  assert.deepEqual(new RuntimeProviderRegistry([codex, claude]).providers(), [
    'codex',
    'claude',
  ]);
});
