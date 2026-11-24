'use strict';

// Harness 原生插件入口：由 Provider / Harness 加载，不在 AIH 宿主内执行。
// 真实插件应按对应 Harness 的插件契约导出/注册；这里只演示包结构。
module.exports = {
  name: 'example-harness-claude',
  setup() {
    // 由 Harness 调用
  }
};
