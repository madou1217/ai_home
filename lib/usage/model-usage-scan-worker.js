'use strict';

// 独立线程同样要装过滤：node:sqlite 的 ExperimentalWarning 是按进程/线程首次使用时
// 发出的，主线程的 patch 管不到 worker。
require('../runtime/sqlite-warning-filter').installSqliteWarningFilter(process);

const { parentPort, workerData } = require('node:worker_threads');
const { createModelUsageService } = require('./model-usage-service');

// 扫描在 worker 里跑：读会话 JSONL 是整段同步 IO + JSON 解析（单文件可达百 MB），
// 留在主事件循环上会把网关请求和健康探针一起卡死（2026-11-01 隧道「假 open」的根因）。
//
// 计价语义不变：扫描写入时的单价解析读的是库里已激活的价格目录，
// 这里按 aiHomeDir 重建的是同一套默认链路（models.dev + 账号自定义价），
// 因此只有无法跨线程传递的 resolver/provider 才需要留在主线程。
const modelUsageService = createModelUsageService({
  ...((workerData && workerData.serviceOptions) || {}),
  // 防递归：worker 里绝不能再建 query/scan 执行器。
  enableAsyncQueries: false,
  enableAsyncScans: false
});

function serializeError(error) {
  return {
    name: String(error && error.name || 'Error'),
    code: String(error && error.code || ''),
    message: String(error && error.message || error || 'model_usage_scan_failed'),
    stack: String(error && error.stack || '')
  };
}

parentPort.on('message', (message = {}) => {
  const id = Number(message.id) || 0;
  const method = String(message.method || '');
  if (!id || method !== 'scan') {
    parentPort.postMessage({
      id,
      ok: false,
      error: serializeError(Object.assign(
        new Error('model_usage_scan_method_invalid'),
        { code: 'model_usage_scan_method_invalid' }
      ))
    });
    return;
  }

  try {
    const result = modelUsageService.scan(message.scan || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeError(error) });
  }
});
