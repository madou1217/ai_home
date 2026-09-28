'use strict';

// 重启/停止时的推理请求排空（graceful drain）。
//
// 旧实现关机时立刻停 Go Core、5 秒强退，`aih server restart` 500ms 后 SIGKILL：
// 正在流式输出的 Claude/Codex 回答被从中间截断，客户端只能报
// "Connection lost mid-response"，这类中途断开无法重试。
// 正确顺序：先关闭监听端口（新请求 ECONNREFUSED，客户端会退避重试直到新实例就绪），
// 再等在途推理请求自然完成（有上限），最后才停 Go Core 与其它后台服务。
// 只等推理入口：WebUI 事件流等长连接会一直挂着，等它们会让每次重启都卡满上限；
// 已升级的 WebSocket 不经过这里（Codex WS 断开后客户端自动重连）。

const DEFAULT_DRAIN_TIMEOUT_MS = 90 * 1000;
// 停止方（aih server restart/stop、launchd ExitTimeOut、systemd TimeoutStopSec）等待进程
// 退出的上限：排空上限 + 停 Go Core 与后台服务的余量。低于它会在排空途中强杀。
const SHUTDOWN_GRACE_MS = DEFAULT_DRAIN_TIMEOUT_MS + 20 * 1000;

function isInferencePath(pathname) {
  const value = String(pathname || '');
  return value.startsWith('/v1/') || value.startsWith('/v1beta/');
}

function createInferenceDrain(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let inFlight = 0;
  const waiters = new Set();

  function notify() {
    if (inFlight !== 0) return;
    for (const resolve of waiters) resolve(true);
    waiters.clear();
  }

  // track 在请求入口调用：推理请求计数，响应结束（完成或客户端断开）时释放。
  function track(pathname, res) {
    if (!isInferencePath(pathname) || !res || typeof res.once !== 'function') return;
    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      notify();
    };
    res.once('close', release);
    res.once('finish', release);
  }

  // waitForIdle 等在途推理请求清零；超时返回 false，由调用方强制关闭剩余连接。
  function waitForIdle(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
    if (inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(value);
      };
      // 不 unref：排空期间要保持进程存活直到超时或清零（计时本身有上限）。
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      waiters.add(done);
    });
  }

  return {
    track,
    waitForIdle,
    inFlight: () => inFlight,
    startedAt: now()
  };
}

module.exports = {
  DEFAULT_DRAIN_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  createInferenceDrain,
  isInferencePath
};
