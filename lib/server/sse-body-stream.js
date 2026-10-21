'use strict';

// SSE 中继流（CLI/HTTP transport → upstream-stream-forwarder）的统一构造器。
//
// 为什么必须带兜底 error 监听：
// 这些 transport 在失败时用 `body.destroy(error)` 把错误交给消费方。但消费方
// （pipeReadableBodyToResponse）并不保证还在听——客户端可能在 CLI 吐出首字节前就
// 断开，此时 res 已关闭，forwarder 立刻 cancel 并返回，流的 listenerCount('error')
// 归零。看门狗随后（实测 qoder 是 180s）才开火 destroy，Node 对没有
// error 监听器的流会直接在 events 层 throw，**整个 server 进程退出**。
// 2026-10-21 本机因此崩了两次（qoder_cli_no_output_180000ms、opencode free tier），
// launchd 重启窗口内 WebUI 全部 502 → 显示 offline。
//
// 兜底监听只吸收「没人在听」的那一类错误；消费方在场时仍会正常收到 error。

const { PassThrough } = require('node:stream');

function createSseBodyStream() {
  const body = new PassThrough();
  // 故意空实现：错误本身已通过 destroy 携带，消费方在场时会收到。
  body.on('error', () => {});
  return body;
}

module.exports = { createSseBodyStream };
