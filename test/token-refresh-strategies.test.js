'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { TOKEN_REFRESH_STRATEGIES } = require('../lib/server/token-refresh-strategies');

test('令牌刷新策略：派发顺序与成员保持现状，特例写成策略字段', () => {
  assert.deepEqual(TOKEN_REFRESH_STRATEGIES.map((strategy) => strategy.id), ['codex', 'gemini', 'claude', 'agy', 'grok', 'kimi', 'cline']);
  for (const strategy of TOKEN_REFRESH_STRATEGIES) assert.equal(typeof strategy.refresh, 'function');
  const kimi = TOKEN_REFRESH_STRATEGIES.find((strategy) => strategy.id === 'kimi');
  assert.equal(kimi.handlesInvalidSuppression, true);
  assert.deepEqual(Object.keys(kimi.extraDeps({ hostHomeDir: '/h' })).sort(), ['hostHomeDir', 'reconcileHostCredentials', 'shouldSkipRefresh']);
  const grok = TOKEN_REFRESH_STRATEGIES.find((strategy) => strategy.id === 'grok');
  assert.equal(grok.forceRefresh({ apiKeyMode: true, runtimeStatus: 'auth_invalid' }), false, 'API 密钥账号不强制刷新');
  assert.equal(TOKEN_REFRESH_STRATEGIES.filter((strategy) => strategy.forceRefresh).length, 1);
  // cline 的 access token 只有 1 小时有效期，且 CLI 在沙箱里也会续期：必须由实现自己
  // 先对账再刷新，守护进程不能按「已判失效」预先拦截。
  const cline = TOKEN_REFRESH_STRATEGIES.find((strategy) => strategy.id === 'cline');
  assert.equal(cline.handlesInvalidSuppression, true);
  assert.equal(cline.extraDeps, undefined);
});
