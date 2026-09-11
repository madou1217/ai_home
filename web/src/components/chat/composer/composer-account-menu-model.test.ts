import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildComposerAccountGroups,
} from './composer-account-menu-model';

test('account menu groups credentials by provider in catalog order', () => {
  const groups = buildComposerAccountGroups([
    { id: 'kimi-oauth', provider: 'kimi', label: 'kimi@example.com', badge: 'OAuth' },
    { id: 'codex-key', provider: 'codex', label: 'api.openai.com', badge: 'API Key' },
    { id: 'kimi-key', provider: 'kimi', label: 'api.moonshot.cn', badge: 'API Key' },
  ]);
  assert.deepEqual(groups.map(({ provider, label, options }) => ({
    provider, label, ids: options.map((option) => option.id),
  })), [
    { provider: 'codex', label: 'ChatGPT · Codex', ids: ['codex-key'] },
    { provider: 'kimi', label: 'Kimi', ids: ['kimi-oauth', 'kimi-key'] },
  ]);
});
