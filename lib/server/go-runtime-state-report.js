'use strict';

// 把 Node 的完整 runtime_state 上报给 Go（Go 是运行态的存储与派生真相）。
//
// 只传 Node 自己维护的 JSON 文档：Go 负责持久化、派生 status/until/reason，
// 并把可映射的失败物化成账号级阻塞。旁路上报，Go 不可用时静默跳过，
// Node 本地状态与选号不受影响。

let stateReporter = null;
let clearReporter = null;

function setRuntimeStateReporter(onState, onClear) {
  stateReporter = typeof onState === 'function' ? onState : null;
  clearReporter = typeof onClear === 'function' ? onClear : null;
}

function reportRuntimeState(accountRef, runtimeState, updatedAt) {
  const ref = String(accountRef || '').trim();
  if (!ref) return;
  const updatedAtMs = Number(updatedAt) || Date.now();
  try {
    if (!runtimeState || typeof runtimeState !== 'object') {
      if (clearReporter) clearReporter(ref, updatedAtMs);
      return;
    }
    if (stateReporter) stateReporter(ref, runtimeState, updatedAtMs);
  } catch (_error) {
    // 旁路上报失败不影响本地状态。
  }
}

module.exports = {
  reportRuntimeState,
  setRuntimeStateReporter
};
