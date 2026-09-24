import assert from 'node:assert/strict';
import test from 'node:test';

import type { ManagedOpenAIModelItem } from '@/types';
import { providerNames } from '@/providers/catalog';
import {
  compareAccountModelRows,
  countOpenCodeGroups,
  filterAccountModelRows,
  formatScopedAccountTitle,
  parseModelVersion
} from './account-models.ts';

function makeModel(overrides: Partial<ManagedOpenAIModelItem> = {}): ManagedOpenAIModelItem {
  return {
    id: 'gpt-5',
    object: 'model',
    created: 0,
    owned_by: 'openai',
    provider: 'codex',
    accountRef: 'acct_1',
    enabled: true,
    manual: false,
    source: 'probe',
    providers: ['codex'],
    description: '',
    updatedAt: 0,
    ...overrides
  };
}

test('account model rows keep the default model first, then newer versions', () => {
  const rows = [
    makeModel({ id: 'gpt-4.1' }),
    makeModel({ id: 'gpt-5.2' }),
    makeModel({ id: 'gpt-3', defaultModel: true })
  ].sort(compareAccountModelRows);
  assert.deepEqual(rows.map((row) => row.id), ['gpt-3', 'gpt-5.2', 'gpt-4.1']);
  assert.deepEqual(parseModelVersion('gemini-2.5-pro'), [2, 5]);
});

test('filterAccountModelRows scopes to the account and applies status/group/query', () => {
  const models = [
    makeModel({ id: 'opencode-go/a' }),
    makeModel({ id: 'opencode/b-free', enabled: false }),
    makeModel({ id: 'opencode/c', manual: true }),
    makeModel({ id: 'other', accountRef: 'acct_2' })
  ];
  const base = { provider: 'codex' as const, accountRef: 'acct_1', status: 'all' as const, group: 'all' as const, query: '' };
  const label = () => 'Main';
  assert.equal(filterAccountModelRows(models, base, label).length, 3);
  assert.deepEqual(filterAccountModelRows(models, { ...base, status: 'disabled' }, label).map((m) => m.id), ['opencode/b-free']);
  assert.deepEqual(filterAccountModelRows(models, { ...base, status: 'manual' }, label).map((m) => m.id), ['opencode/c']);
  assert.deepEqual(filterAccountModelRows(models, { ...base, group: 'go' }, label).map((m) => m.id), ['opencode-go/a']);
  assert.equal(filterAccountModelRows(models, { ...base, query: 'main' }, label).length, 3);
  assert.deepEqual(countOpenCodeGroups(models.slice(0, 3)), { go: 1, zen: 2, free: 1 });
});

test('formatScopedAccountTitle hides internal acct_ refs', () => {
  assert.equal(formatScopedAccountTitle('me@example.com', 'codex'), 'me@example.com');
  assert.equal(formatScopedAccountTitle('acct_123', 'codex'), `${providerNames.codex} 账号`);
  assert.equal(formatScopedAccountTitle('', null), '当前账号');
});
