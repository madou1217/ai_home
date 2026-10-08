import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Account } from '@/types';
import AccountRefreshLogo from './AccountRefreshLogo';

const account = { provider: 'codex', accountRef: 'acct_refresh', displayName: 'Refresh test' } as Account;

test('account logo exposes a named keyboard button for all three refresh branches', () => {
  const html = renderToStaticMarkup(<AccountRefreshLogo account={account} activity={null} refreshing={false} onRefresh={() => {}} />);
  assert.match(html, /<button[^>]*type="button"/);
  assert.match(html, /aria-label="刷新账号 Refresh test 的状态、模型和额度"/);
  assert.match(html, /aria-busy="false"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('refreshing keeps the provider logo visible and prevents repeated activation', () => {
  const html = renderToStaticMarkup(<AccountRefreshLogo account={account} activity={null} refreshing onRefresh={() => {}} />);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /data-account-activity="idle"/);
  assert.match(html, /ChatGPT/);
});
