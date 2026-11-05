'use strict';

// 服务端账号记录的 displayNames 组装规则：数组顺序 = 轮播顺序，类型只是身份类别。
// 新增身份类型只需要在这里多 push 一项，轮播组件不需要改。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAccountDisplayNames } = require('../lib/server/account-display-identity');

test('codebuddycn：按邮箱 → 手机号 → 昵称的优先级各一项', () => {
  const names = buildAccountDisplayNames({
    displayName: '码逗',
    phone: '18912341630',
    email: 'madou1217@example.com'
  });
  assert.deepEqual(names, [
    { type: 'email', value: 'madou1217@example.com' },
    { type: 'phone', value: '18912341630' },
    { type: 'nickName', value: '码逗' }
  ]);
});

test('合成手机号邮箱只产出 phone 项，不把 @phone.local 当邮箱', () => {
  assert.deepEqual(buildAccountDisplayNames({
    displayName: 'Kimi',
    email: '18912341630@phone.local'
  }), [
    { type: 'phone', value: '18912341630' },
    { type: 'nickName', value: 'Kimi' }
  ]);
});

test('真实 phone 与合成邮箱同时存在：去重后只留一项手机号', () => {
  assert.deepEqual(buildAccountDisplayNames({
    displayName: '码逗',
    phone: '18912341630',
    email: '18912341630@phone.local'
  }), [
    { type: 'phone', value: '18912341630' },
    { type: 'nickName', value: '码逗' }
  ]);
});

test('上游已打码的手机号原样保留 4 个星号，不拼成 7 位数字', () => {
  assert.deepEqual(buildAccountDisplayNames({
    displayName: '码逗',
    phone: '185****5206'
  }), [
    { type: 'phone', value: '185****5206' },
    { type: 'nickName', value: '码逗' }
  ]);
});

test('API Key 账号用 name 表达显示名；有邮箱照常保留', () => {
  assert.deepEqual(buildAccountDisplayNames({
    displayName: 'api.example.com',
    email: 'ops@example.com',
    apiKeyMode: true
  }), [
    { type: 'email', value: 'ops@example.com' },
    { type: 'name', value: 'api.example.com' }
  ]);
});

test('displayName 本身就是邮箱时，类型标成 email 而不是 nickName', () => {
  assert.deepEqual(buildAccountDisplayNames({
    displayName: 'user@example.com',
    email: 'user@example.com'
  }), [{ type: 'email', value: 'user@example.com' }]);
});

test('displayName 是邮箱但 nickname 单独给出时，两项都要保留', () => {
  assert.deepEqual(buildAccountDisplayNames({
    displayName: 'user@example.com',
    nickname: 'Deo',
    email: 'user@example.com'
  }), [
    { type: 'email', value: 'user@example.com' },
    { type: 'nickName', value: 'Deo' }
  ]);
});

test('同名同值只保留一项；空值不产出空帧', () => {
  assert.deepEqual(buildAccountDisplayNames({
    displayName: '码逗',
    email: '码逗'
  }), [{ type: 'nickName', value: '码逗' }]);

  assert.deepEqual(buildAccountDisplayNames({}), []);
});
