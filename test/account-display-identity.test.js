'use strict';

// 展示名规则：邮箱 → 手机号 → 昵称，且「没有身份价值」的合成昵称一律不展示。
//
// 背景（用户口径）：`Kiro(Google)` 这类「Provider 名字 + 登录方式」既不是昵称也
// 不能区分账号，出现在账号标题上等于没有标识。同理 `OpenCode API (k3j9)` 是密钥
// 指纹，不是人。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAccountDisplayNames,
  isMeaninglessNickname,
  pickOauthDisplayNameFor
} = require('../lib/server/account-display-identity');
const { buildDisplayNameCandidates } = require('../lib/server/account-view-hints');

test('Provider 名字 + 括号补充的合成名判为无意义', () => {
  for (const value of ['Kiro(Google)', 'Kiro (Google)', 'Kiro(AWS Builder ID)', 'kiro（GitHub）']) {
    assert.equal(isMeaninglessNickname(value, 'kiro'), true, value);
  }
  assert.equal(isMeaninglessNickname('OpenCode API (k3j9)', 'opencode'), true);
  assert.equal(isMeaninglessNickname('CodeBuddy CLI (abc)', 'codebuddy'), true);
});

test('只有 Provider 名字本身也判为无意义', () => {
  assert.equal(isMeaninglessNickname('Kiro', 'kiro'), true);
  assert.equal(isMeaninglessNickname('kiro', 'kiro'), true);
});

test('用户自己起的昵称不被误杀', () => {
  assert.equal(isMeaninglessNickname('Deo (工作号)', 'kiro'), false);
  assert.equal(isMeaninglessNickname('旅行者', 'zcode'), false);
  assert.equal(isMeaninglessNickname('madou1217@live.com', 'kiro'), false);
});

test('没有 provider 时退回 kiro 名单，不按结构误杀', () => {
  assert.equal(isMeaninglessNickname('Kiro (Google)'), true);
  assert.equal(isMeaninglessNickname('Deo (工作号)'), false);
});

test('展示名优先级：邮箱 > 手机号 > 昵称', () => {
  const head = buildDisplayNameCandidates('zcode', {
    metadataEmail: 'user@example.com',
    authMetadataEmail: '',
    phone: '185****5206',
    runtimeAccountDisplayName: '旅行者'
  });
  assert.deepEqual(head, ['user@example.com', '', '185****5206', '旅行者']);
  assert.equal(pickOauthDisplayNameFor('zcode', ...head), 'user@example.com');

  const noEmail = buildDisplayNameCandidates('zcode', {
    metadataEmail: '',
    authMetadataEmail: '',
    phone: '185****5206',
    runtimeAccountDisplayName: '旅行者'
  });
  assert.equal(pickOauthDisplayNameFor('zcode', ...noEmail), '185****5206');
});

test('有真身份时合成昵称被跳过；全都没有才拿它兜底', () => {
  const head = buildDisplayNameCandidates('kiro', {
    metadataEmail: '',
    authMetadataEmail: '',
    phone: '',
    runtimeAccountDisplayName: 'Kiro(Google)'
  });
  // 后面还有邮箱候选项：邮箱胜出，合成名不出现。
  assert.equal(pickOauthDisplayNameFor('kiro', ...head, 'kiro@example.com'), 'kiro@example.com');
  // 全都没有：保留兜底，不能把标题变成空白。
  assert.equal(pickOauthDisplayNameFor('kiro', ...head), 'Kiro(Google)');
});

test('displayNames 轮播项里不再出现无意义昵称', () => {
  const names = buildAccountDisplayNames({
    provider: 'kiro',
    displayName: 'Kiro(Google)',
    nickname: 'Kiro(Google)',
    email: 'user@example.com'
  });
  assert.deepEqual(names, [{ type: 'email', value: 'user@example.com' }]);
});

test('zcode：有手机号时展示名给手机号而不是「旅行者」', () => {
  const names = buildAccountDisplayNames({
    provider: 'zcode',
    displayName: '旅行者',
    phone: '185****5206'
  });
  assert.deepEqual(names, [
    { type: 'phone', value: '185****5206' },
    { type: 'nickName', value: '旅行者' }
  ]);
});

test('全无身份时 displayNames 也保留兜底项，不产出空标题', () => {
  const names = buildAccountDisplayNames({
    provider: 'kiro',
    displayName: 'Kiro(Google)',
    nickname: 'Kiro(Google)'
  });
  assert.deepEqual(names, [{ type: 'nickName', value: 'Kiro(Google)' }]);
});
