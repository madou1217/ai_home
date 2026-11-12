'use strict';

// 把 Go 的 account_models 读取器注入模型探测选项（Go 接管的 Provider 用）。
//
// 为什么单独成函数：注入点漏一次，Go 接管的 Provider 就会以
// `go_model_catalog_reader_missing` 失败——`/v0/management/models` 与 `/v1/models`
// 的全局目录直接变空（实测漏了 wrapper 的最后一跳，178 个模型变成 0）。
// 纯函数 + 单测，比在 server.js 里靠注释提醒可靠。
function withGoModelSource(options, goCoreHost) {
  if (!goCoreHost || typeof goCoreHost.listAccountModels !== 'function') return options;
  const base = options && typeof options === 'object' ? options : {};
  return {
    ...base,
    goAccountModels: (path) => goCoreHost.listAccountModels(path),
    goAccountRefFor: (ref) => (typeof goCoreHost.goAccountRefFor === 'function'
      ? goCoreHost.goAccountRefFor(ref)
      : ref)
  };
}

module.exports = { withGoModelSource };
