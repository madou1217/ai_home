import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { Form } from 'antd';
import type { UpstreamErrorRule } from '@/types';
import { UpstreamErrorRulesEditor } from './UpstreamErrorRulesEditor';
import { createUpstreamErrorMappingGroup, normalizeUpstreamErrorRulesForForm } from './upstream-error-mapping-presets';

const { validateUpstreamErrorRules, matchUpstreamErrorRule } = createRequire(import.meta.url)('../../../../lib/account/upstream-error-rules');

test('New API form preset identifies the captured billing error and rejects another 403 error', () => {
  const group = createUpstreamErrorMappingGroup();
  const rules = validateUpstreamErrorRules(group.rules);
  assert.equal(matchUpstreamErrorRule(rules, 403, { error: { type: 'new_api_error', code: 'insufficient_user_quota' } }).kind, 'billing_blocked');
  // 2026-10-14 4router 事故：New API 部署会把 error.type 改写成自己的名字
  // （4router 实测返回 4router_error），规则必须只按稳定的 error.code 命中，
  // 否则改了 type 的中转欠费永远识别不出。
  assert.equal(matchUpstreamErrorRule(rules, 403, { error: { type: '4router_error', code: 'insufficient_user_quota' } }).kind, 'billing_blocked');
  // jiji 走 one-api 信封：余额不足是顶层 code，没有 error 包裹。
  assert.equal(matchUpstreamErrorRule(rules, 403, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' }).kind, 'billing_blocked');
  assert.equal(matchUpstreamErrorRule(rules, 403, { error: { type: 'new_api_error', code: 'permission_denied' } }), null);
  assert.equal(matchUpstreamErrorRule(rules, 403, { error: { type: '4router_error', code: 'permission_denied' } }), null);
  assert.equal(matchUpstreamErrorRule(rules, 403, { code: 'INSUFFICIENT_BALANCE_OTHER' }), null);
});

test('editing legacy rules preserves top-level and response.error matches and isolates cancelled changes', () => {
  const legacy: UpstreamErrorRule[] = [{ name: 'legacy', enabled: true, statuses: [403], kind: 'billing_blocked',
    matchers: [{ field: 'code', pattern: '^insufficient_user_quota$' }] }];
  const formRules = normalizeUpstreamErrorRulesForForm(legacy);
  const saved = validateUpstreamErrorRules(formRules);
  for (const body of [
    { code: 'insufficient_user_quota' },
    { error: { code: 'insufficient_user_quota' } },
    { response: { error: { code: 'insufficient_user_quota' } } }
  ]) assert.equal(matchUpstreamErrorRule(saved, 403, body).kind, 'billing_blocked');
  formRules[0].matchers[0] = { field: 'code', pattern: 'changed' };
  assert.deepEqual(legacy[0].matchers[0], { field: 'code', pattern: '^insufficient_user_quota$' });
});

test('visual editor renders JSON paths only for JSON conditions and keeps the legacy regex field editable', () => {
  const preset = createUpstreamErrorMappingGroup();
  const html = renderToStaticMarkup(<Form initialValues={preset}><UpstreamErrorRulesEditor listName="rules" includeGroups={false} /></Form>);
  assert.equal((html.match(/aria-label="JSON 路径"/g) || []).length, 2);
  assert.match(html, /upstream-error-matcher/);
  const legacy = [{ ...preset.rules[0], matchers: [{ field: 'code', pattern: '^insufficient_user_quota$' }] }];
  const legacyHtml = renderToStaticMarkup(<Form initialValues={{ rules: legacy }}><UpstreamErrorRulesEditor listName="rules" includeGroups={false} /></Form>);
  assert.match(legacyHtml, /aria-label="匹配正则"/);
  assert.doesNotMatch(legacyHtml, /aria-label="JSON 路径"/);
});
