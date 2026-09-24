import assert from 'node:assert/strict';
import test from 'node:test';

import type { ManagedOpenAIModelItem, WebUiOpenAIModelsJob, WebUiOpenAIModelsResponse } from '@/types';
import {
  buildGlobalModelRows,
  buildManualProviderOptions,
  buildModelAccountOptions,
  countGlobalModelRowsByProvider,
  filterGlobalModelRows,
  getGlobalModelDisplayLabel,
  getManagedModelSource,
  getVisibleModelProbeError,
  pickLatestCatalogJob,
  resolveManualModelAccountForProvider,
  resolveManualModelDefaults
} from './model-catalog';

function managed(overrides: Partial<ManagedOpenAIModelItem>): ManagedOpenAIModelItem {
  return {
    id: 'gpt-5',
    object: 'model',
    created: 0,
    owned_by: 'openai',
    provider: 'codex',
    accountRef: 'acct_a',
    enabled: true,
    manual: false,
    source: 'probe',
    providers: ['codex'],
    description: '',
    updatedAt: 0,
    ...overrides
  };
}

function catalogOf(overrides: Partial<WebUiOpenAIModelsResponse>): WebUiOpenAIModelsResponse {
  return {
    ok: true,
    endpoint: '/v1/models',
    cached: true,
    updatedAt: 0,
    source: 'local',
    sources: 1,
    scannedAccounts: 1,
    firstError: '',
    data: [],
    managedData: [],
    accounts: [],
    byProvider: {},
    byAccountRef: {},
    errorsByAccountRef: {},
    ...overrides
  };
}

const catalog = catalogOf({
  data: [{ id: 'gpt-5', object: 'model', created: 1, owned_by: 'openai' }],
  byProvider: { codex: ['gpt-5'] },
  labels: { codex: { 'gpt-5': 'GPT-5' } },
  accounts: [{ provider: 'codex', accountRef: 'acct_a', displayName: 'Work' }],
  managedData: [
    managed({ id: 'gpt-5', accountRef: 'acct_a' }),
    managed({ id: 'gpt-5', accountRef: 'acct_b', enabled: false }),
    managed({ id: 'claude-x', provider: 'claude', accountRef: 'acct_c', enabled: false, manual: true }),
    managed({ id: 'manual-y', provider: 'claude', accountRef: 'acct_c', manual: true }),
    managed({ id: 'orphan', accountRef: '' })
  ]
});

const source = getManagedModelSource(catalog);
const accounts = buildModelAccountOptions(catalog, source);
const accountByRef = new Map(accounts.map((account) => [account.accountRef, account]));
const rows = buildGlobalModelRows(catalog, source, accountByRef);

test('managed source 丢弃缺账号的探测行；账号选项合并 accounts 与探测行', () => {
  assert.equal(source.length, 4);
  assert.deepEqual(accounts.map((account) => account.accountRef), ['acct_c', 'acct_a', 'acct_b']);
  assert.equal(accountByRef.get('acct_a')?.displayName, 'Work');
});

test('全局聚合：按 id 合并账号，统计启用 / 停用 / 手动并把可见行排前', () => {
  assert.deepEqual(rows.map((row) => row.id), ['gpt-5', 'manual-y', 'claude-x']);
  const gpt = rows[0];
  assert.equal(gpt.visible, true);
  assert.equal(gpt.enabledCount, 1);
  assert.equal(gpt.disabledCount, 1);
  assert.deepEqual(gpt.accounts.map((account) => account.label), ['Work', 'acct_b']);
  assert.equal(getGlobalModelDisplayLabel(catalog, gpt), 'GPT-5');
});

test('状态筛选与 provider 计数口径', () => {
  const base = { provider: 'all' as const, account: 'all', query: '' };
  assert.deepEqual(filterGlobalModelRows(rows, { ...base, status: 'all' }).map((row) => row.id), ['gpt-5', 'manual-y']);
  assert.deepEqual(filterGlobalModelRows(rows, { ...base, status: 'disabled' }).map((row) => row.id), ['claude-x']);
  assert.deepEqual(filterGlobalModelRows(rows, { ...base, status: 'manual' }).map((row) => row.id), ['manual-y']);
  assert.deepEqual(filterGlobalModelRows(rows, { ...base, status: 'all', account: 'acct_b' }).map((row) => row.id), ['gpt-5']);
  assert.deepEqual(filterGlobalModelRows(rows, { ...base, status: 'all', query: 'work' }).map((row) => row.id), ['gpt-5']);
  const counts = countGlobalModelRowsByProvider(rows, { account: 'all', status: 'all', query: '' });
  assert.equal(counts.all, 2);
  assert.equal(counts.codex, 1);
  assert.equal(counts.claude, 1);
});

test('探测错误忽略 abort 类噪音', () => {
  assert.equal(getVisibleModelProbeError(catalogOf({ firstError: 'AbortError: operation was aborted' })), '');
  assert.equal(
    getVisibleModelProbeError(catalogOf({ firstError: '', errorsByAccountRef: { acct_a: 'HTTP 500 boom' } })),
    'HTTP 500 boom'
  );
});

test('watch 快照优先取本作用域进行中的任务', () => {
  const job = (id: string, status: WebUiOpenAIModelsJob['status'], at: number, accountRef = ''): WebUiOpenAIModelsJob => ({
    id,
    status,
    accountScope: accountRef ? { accountRef } : null,
    startedAt: at,
    finishedAt: 0,
    catalog: null,
    error: ''
  });
  const jobs = [job('done', 'succeeded', 30), job('run', 'running', 10), job('acct', 'running', 40, 'acct_a')];
  assert.equal(pickLatestCatalogJob(jobs, 'global')?.id, 'run');
  assert.equal(pickLatestCatalogJob([job('done', 'succeeded', 30)], 'global')?.id, 'done');
  assert.equal(pickLatestCatalogJob(jobs, 'acct_z'), null);
});

test('手动添加模型：默认账号 / Provider 切换改选 / 无账号 Provider 置灰', () => {
  assert.deepEqual(resolveManualModelDefaults(accounts, null, 'codex'), { provider: 'codex', accountRef: 'acct_a', enabled: true });
  assert.deepEqual(resolveManualModelDefaults(accounts, accountByRef.get('acct_b'), 'codex'), { provider: 'codex', accountRef: 'acct_b', enabled: true });
  assert.deepEqual(resolveManualModelAccountForProvider(accounts, accountByRef, 'codex', 'acct_b'), { changed: false, accountRef: 'acct_b' });
  assert.deepEqual(resolveManualModelAccountForProvider(accounts, accountByRef, 'claude', 'acct_b'), { changed: true, accountRef: 'acct_c' });
  const flat = buildManualProviderOptions(accounts).flatMap((option) => ('options' in option ? option.options : [option]));
  assert.equal(flat.find((option) => option.value === 'codex')?.disabled, false);
  assert.equal(flat.find((option) => option.value === 'gemini')?.disabled, true);
});
