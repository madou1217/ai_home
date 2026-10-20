'use strict';

const { preparePiHarness } = require('./pi');
const { prepareDshHarness } = require('./dsh');

// harness 投影适配器注册表：`run.js` 只按描述符里的 adapter id 查表，
// 不写 `if (harness.id === '…')`。新增一个 harness = 描述符加 adapter 字段
// + 这里注册一个 prepare 函数。
const ADAPTERS = Object.freeze({
  pi: preparePiHarness,
  dsh: prepareDshHarness
});

function getHarnessAdapter(id) {
  return ADAPTERS[String(id || '').trim().toLowerCase()] || null;
}

module.exports = {
  ADAPTERS,
  getHarnessAdapter
};
