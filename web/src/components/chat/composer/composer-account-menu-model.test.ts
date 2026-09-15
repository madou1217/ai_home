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

test('domestic and international accounts of one product share a single menu group', () => {
  // 同一产品的国内站/国际站是两个独立 Provider（账号体系不互通），但菜单里
  // 必须只有一个条目，站点降为账号行上的标记。
  const groups = buildComposerAccountGroups([
    { id: 'qoder-cn', provider: 'qodercn', label: 'dev@example.cn' },
    { id: 'qoder-global', provider: 'qoder', label: 'dev@example.com' },
    { id: 'codebuddy-cn', provider: 'codebuddycn', label: 'cn@example.cn' },
  ]);

  assert.deepEqual(groups.map((group) => group.family), ['qoder', 'codebuddy']);
  assert.deepEqual(groups.map((group) => group.label), ['Qoder', 'CodeBuddy']);
  // 组内顺序稳定为「国际站在前」。
  assert.deepEqual(groups[0].options.map((option) => option.id), ['qoder-global', 'qoder-cn']);
  assert.deepEqual(groups[0].options.map((option) => option.siteLabel), ['国际站', '国内站']);
  assert.equal(groups[0].siteCount, 2);
  assert.equal(groups[1].siteCount, 1);
});

test('single-site products never gain a site marker', () => {
  const groups = buildComposerAccountGroups([
    { id: 'kimi-oauth', provider: 'kimi', label: 'kimi@example.com' },
  ]);
  assert.equal(groups[0].family, 'kimi');
  assert.equal(groups[0].label, 'Kimi');
  assert.equal(groups[0].options[0].siteLabel, undefined);
  assert.equal(groups[0].siteCount, 1);
});

test('unknown or missing providers keep their own group instead of folding into a product', () => {
  const groups = buildComposerAccountGroups([
    { id: 'legacy-1', provider: 'retired-provider', label: '历史账号' },
    { id: 'orphan-1', label: '无 Provider 账号' },
  ]);
  assert.deepEqual(groups.map((group) => group.family), ['retired-provider', '']);
  assert.deepEqual(groups.map((group) => group.label), ['retired-provider', '其他']);
});
