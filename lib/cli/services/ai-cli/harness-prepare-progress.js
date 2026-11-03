'use strict';

// 外部 harness 的启动前准备可以长时间不出声：dsh-tui 首次启动要把 profile
// bundle 装进账号投影（实测 12–24s），期间界面完全没有反馈，和「卡住了」无法
// 区分。适配器只上报阶段（phase），怎么呈现由这里决定 —— 一行 stderr 动画，
// 成功 / 失败各收尾一行。
//
// 输出纪律与 headless 运行一致：全部走 stderr，stdout 留给 harness 自己。

const { createHeadlessProgress } = require('../pty/headless-progress');

function normalizeLabel(value) {
  return String(value || '').trim() || '准备运行环境';
}

function createHarnessPrepareProgress(input = {}) {
  const processObj = input.processObj || process;
  let active = null;

  return function report(event) {
    if (!event || !event.phase) return;
    if (event.phase === 'install:start') {
      // 同一时刻只保留一行：重复的 start（适配器重试）先收掉上一条，避免两行
      // 动画互相覆盖。
      if (active) active.finish({ ok: false, note: '重新开始' });
      active = createHeadlessProgress({
        processObj,
        label: normalizeLabel(event.label),
        now: input.now
      });
      active.start();
      return;
    }
    if (event.phase === 'install:end') {
      const progress = active;
      active = null;
      if (!progress) return;
      const ok = event.ok !== false;
      progress.finish({ ok, note: ok ? '已安装' : '安装失败' });
    }
  };
}

module.exports = {
  createHarnessPrepareProgress
};
