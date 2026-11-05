'use strict';

// 维度标签是纯展示：固定档位用习惯叫法，其余按分钟数推导。
// 这里只锁「不同窗口长度都能得到可读标签」，不涉及归维（归维在 routes 测试里）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatWindowLabel } = require('../lib/account/quota-window-stats');

test('常见档位用习惯叫法', () => {
  assert.equal(formatWindowLabel(300), '5h');
  assert.equal(formatWindowLabel(10080), '7天');
  assert.equal(formatWindowLabel(43200), '30天');
});

test('非标准窗口按天/小时/分钟推导，不出现裸分钟数', () => {
  assert.equal(formatWindowLabel(720), '12h');
  assert.equal(formatWindowLabel(724), '12h4m');
  assert.equal(formatWindowLabel(1440), '1天');
  assert.equal(formatWindowLabel(1500), '1天1h');
  assert.equal(formatWindowLabel(45), '45分钟');
  assert.equal(formatWindowLabel(0), '当前额度');
});
