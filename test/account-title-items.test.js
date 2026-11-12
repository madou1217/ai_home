'use strict';

// 账号标题轮播的展示规则：服务端下发 `displayNames: [{ type, value }]`，
// 数组顺序就是轮播顺序；新增身份类型不需要改结构和组件。
// 这里直接导入纯 TS helper（Node 22 的类型剥离），组件文件本身含 JSX 不能直接 require。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAccountTitleItems } = require('../web/src/features/accounts/account-title-items.ts');

test('codebuddycn：按服务端顺序（邮箱/手机号/昵称）轮播，#CLI ID 排在最前', () => {
  const items = buildAccountTitleItems({
    displayId: '2',
    displayNames: [
      { type: 'email', value: 'madou1217@example.com' },
      { type: 'phone', value: '18912341630' },
      { type: 'nickName', value: '码逗' }
    ]
  });
  assert.deepEqual(items, ['#2', 'madou1217@example.com', '18912341630', '码逗']);
});

test('新增身份类型不需要改结构：uin 自动进入轮播', () => {
  const items = buildAccountTitleItems({
    displayNames: [
      { type: 'nickName', value: '码逗' },
      { type: 'uin', value: '330134286413' }
    ]
  });
  assert.deepEqual(items, ['码逗', '330134286413']);
});

test('displayNames 为空数组时只保留 #CLI ID，不偷偷回退到旧字段', () => {
  const items = buildAccountTitleItems({
    displayId: '3',
    displayName: '旧字段',
    email: 'legacy@example.com',
    displayNames: []
  });
  assert.deepEqual(items, ['#3']);
});

test('旧服务端没有 displayNames：回退到 displayName / 合成手机号 / email', () => {
  assert.deepEqual(buildAccountTitleItems({
    displayName: 'Kimi',
    email: '18912341630@phone.local'
  }), ['Kimi', '18912341630']);

  assert.deepEqual(buildAccountTitleItems({
    displayName: '码逗',
    email: 'madou1217@example.com'
  }), ['码逗', 'madou1217@example.com']);
});

test('只有名字时不凭空造帧', () => {
  assert.deepEqual(buildAccountTitleItems({ displayName: '码逗' }), ['码逗']);
  assert.deepEqual(buildAccountTitleItems({}), []);
});
