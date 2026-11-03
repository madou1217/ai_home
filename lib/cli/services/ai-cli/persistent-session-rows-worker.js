'use strict';

// 持久会话列表的**后台采集**线程。
//
// 采集本身要 spawn tmux（每个账号 socket 一次）+ 读会话库，单次 90~260ms；留在主线程
// 就意味着每 1.5s 的刷新会把键盘事件压住这么久——用户看到的是「按 x/q/Esc 有延迟」。
// 搬到 worker 后主线程只做渲染，按键处理永远是毫秒级。
//
// 只回传可结构化克隆的纯数据（rows 都是 JSON 形状），worker 里的任何异常都当作
// 「这次刷新失败」，由主线程沿用上一次结果。

const { parentPort } = require('node:worker_threads');
const { collectGlobalPersistentSessionRows } = require('./persistent-session-list');

let lastRequestId = 0;

parentPort.on('message', (message) => {
  const request = message && typeof message === 'object' ? message : {};
  const id = Number(request.id) || (lastRequestId += 1);
  try {
    const summary = collectGlobalPersistentSessionRows({
      aiHomeDir: request.aiHomeDir,
      hostHomeDir: request.hostHomeDir,
      providers: request.providers,
      skipAgentTitles: request.skipAgentTitles === true,
      processImpl: process,
      fs: require('node:fs')
    });
    parentPort.postMessage({
      id,
      ok: true,
      rows: summary.rows,
      accountCount: summary.accountCount,
      unavailableCount: summary.unavailableCount,
      unavailableHint: summary.unavailableHint
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: String((error && error.message) || error)
    });
  }
});
