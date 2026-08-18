import assert from 'node:assert/strict';
import test from 'node:test';

import type { Account, WebUiOpenAIModelsJob, WebUiModelsResponse } from '@/types';
import {
  buildAccountModelCatalogFromOpenAI,
  formatModelProbeErrorLabel,
  getAccountModelProbe,
  getAccountRef,
  getModelCatalogAccountScope,
  getModelCatalogJobAccountRef,
  getModelProbeTagColor,
  getModelProbeTagLabel,
  getModelRefreshAccountRef,
  isModelCatalogJobActive
} from './account-model-catalog.ts';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    provider: 'codex',
    accountRef: 'acct_test',
    status: 'up',
    displayName: 'test',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 0,
    planType: 'free',
    email: 'user@example.com',
    ...overrides
  };
}

function makeJob(overrides: Partial<WebUiOpenAIModelsJob> = {}): WebUiOpenAIModelsJob {
  return {
    id: 'job-1',
    status: 'running',
    startedAt: 0,
    finishedAt: 0,
    catalog: null,
    error: '',
    ...overrides
  };
}

test('getAccountRef trims whitespace and falls back to empty', () => {
  assert.equal(getAccountRef({ accountRef: 'acct_1' }), 'acct_1');
  assert.equal(getAccountRef({ accountRef: '  acct_1  ' }), 'acct_1');
  assert.equal(getAccountRef({ accountRef: '' }), '');
  assert.equal(getAccountRef({ accountRef: undefined as unknown as string }), '');
});

test('refresh ref and catalog scope derive from accountRef', () => {
  const record = { accountRef: 'acct_2' };
  assert.equal(getModelRefreshAccountRef(record), 'acct_2');
  assert.deepEqual(getModelCatalogAccountScope(record), { accountRef: 'acct_2' });
});

test('getModelCatalogJobAccountRef reads accountScope only', () => {
  assert.equal(getModelCatalogJobAccountRef(makeJob({ accountScope: { accountRef: 'acct_3' } })), 'acct_3');
  assert.equal(getModelCatalogJobAccountRef(makeJob({ accountScope: undefined })), '');
  assert.equal(getModelCatalogJobAccountRef(makeJob({ accountScope: null as unknown as undefined })), '');
});

test('isModelCatalogJobActive only accepts queued and running', () => {
  assert.equal(isModelCatalogJobActive(makeJob({ status: 'queued' })), true);
  assert.equal(isModelCatalogJobActive(makeJob({ status: 'running' })), true);
  assert.equal(isModelCatalogJobActive(makeJob({ status: 'succeeded' })), false);
  assert.equal(isModelCatalogJobActive(makeJob({ status: 'failed' })), false);
  assert.equal(isModelCatalogJobActive(null), false);
});

test('buildAccountModelCatalogFromOpenAI maps fields and defaults empty maps', () => {
  assert.equal(buildAccountModelCatalogFromOpenAI(null), null);
  const mapped = buildAccountModelCatalogFromOpenAI({
    ok: true,
    endpoint: 'https://x',
    cached: false,
    updatedAt: 123,
    source: 'probe',
    sources: 2,
    scannedAccounts: 3,
    firstError: '',
    data: [],
    byProvider: { codex: ['gpt-5'] },
    byAccountRef: { acct_1: ['gpt-5'] },
    errorsByAccountRef: {}
  });
  assert.deepEqual(mapped, {
    ok: true,
    cached: false,
    updatedAt: 123,
    source: 'probe',
    sources: 2,
    scannedAccounts: 3,
    firstError: '',
    models: { codex: ['gpt-5'] },
    byAccountRef: { acct_1: ['gpt-5'] },
    errorsByAccountRef: {}
  });
});

test('getAccountModelProbe distinguishes models, errors and untouched accounts', () => {
  const catalog: WebUiModelsResponse = {
    ok: true,
    cached: false,
    updatedAt: 0,
    source: '',
    sources: 0,
    scannedAccounts: 0,
    firstError: '',
    models: {},
    byAccountRef: { acct_1: ['gpt-5'] },
    errorsByAccountRef: { acct_2: 'boom' }
  };
  assert.deepEqual(getAccountModelProbe(makeAccount({ accountRef: 'acct_1' }), catalog), {
    probed: true,
    models: ['gpt-5'],
    error: ''
  });
  assert.deepEqual(getAccountModelProbe(makeAccount({ accountRef: 'acct_2' }), catalog), {
    probed: true,
    models: [],
    error: 'boom'
  });
  assert.deepEqual(getAccountModelProbe(makeAccount({ accountRef: 'acct_3' }), catalog), {
    probed: false,
    models: [],
    error: ''
  });
  assert.deepEqual(getAccountModelProbe(makeAccount({ accountRef: 'acct_1' }), null), {
    probed: false,
    models: [],
    error: ''
  });
});

test('formatModelProbeErrorLabel summarizes http, permission and network errors', () => {
  assert.equal(formatModelProbeErrorLabel('HTTP 403 Forbidden'), '403 失败');
  assert.equal(formatModelProbeErrorLabel('PERMISSION_DENIED'), '权限拒绝');
  assert.equal(formatModelProbeErrorLabel('UND_ERR_CONNECT'), '网络失败');
  assert.equal(formatModelProbeErrorLabel(''), '探测失败');
  assert.equal(formatModelProbeErrorLabel('random failure'), '探测失败');
});

test('getModelProbeTagLabel covers models, error, refreshing and idle states', () => {
  const probe = { probed: true, models: ['a'], error: '' };
  assert.equal(getModelProbeTagLabel(probe, false), '模型 1');
  assert.equal(getModelProbeTagLabel({ probed: true, models: [], error: 'HTTP 500' }, false), '500 失败');
  assert.equal(getModelProbeTagLabel({ probed: false, models: [], error: '' }, true), '探测中');
  assert.equal(getModelProbeTagLabel({ probed: true, models: [], error: '' }, false), '未发现模型');
  assert.equal(getModelProbeTagLabel({ probed: false, models: [], error: '' }, false), '待探测');
});

test('getModelProbeTagColor follows label precedence', () => {
  const withModels = { probed: true, models: ['a'], error: '' };
  assert.equal(getModelProbeTagColor(withModels, false), 'success');
  assert.equal(getModelProbeTagColor({ probed: true, models: ['a'], error: 'x' }, false), 'warning');
  assert.equal(getModelProbeTagColor({ probed: true, models: [], error: 'x' }, false), 'error');
  assert.equal(getModelProbeTagColor({ probed: false, models: [], error: '' }, true), 'processing');
  assert.equal(getModelProbeTagColor({ probed: true, models: [], error: '' }, false), 'default');
});