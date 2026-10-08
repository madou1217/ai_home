import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Accounts from '@/pages/Accounts';

test('desktop accounts renders provider navigation and account controls without undefined component references', () => {
  const html = renderToStaticMarkup(<MemoryRouter><Accounts /></MemoryRouter>);
  assert.match(html, /账号列表/);
  assert.match(html, /accounts-provider-tabs/);
  assert.match(html, /ChatGPT/);
  assert.doesNotMatch(html, />刷新<|aria-label="reload"/);
});
