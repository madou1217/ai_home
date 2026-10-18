'use strict';

// 重启/停止时的推理请求排空（graceful drain）。
//
// 旧实现关机时立刻停 Go Core、5 秒强退，`aih server restart` 500ms 后 SIGKILL：
// 正在流式输出的 Claude/Codex 回答被从中间截断，客户端只能报
// "Connection lost mid-response"，这类中途断开无法重试。
// 顺序：先关闭监听端口（新请求 ECONNREFUSED，客户端会退避重试直到新实例就绪），
// 再给在途推理请求一个短宽限，最后才停 Go Core 与其它后台服务。
// 只等推理入口：WebUI 事件流等长连接会一直挂着，等它们会让每次重启都卡满上限；
// 已升级的 WebSocket 不经过这里（Codex WS 断开后客户端自动重连）。
//
// 宽限为什么只有 2 秒（2026-10-18 用户决策：极速重启优先于跑完回答）：
// 排空期间监听已关闭，新请求全部被拒，等待的每一秒都是整个网关的停机时间；而线上
// 推理请求中位耗时 16s、22% 超过 30s，长宽限换来的是每次重启停机 16–90s。实际体验也
// 印证了这一点 —— 重启没完成会话就已经断了，长等待并没有保住回答。因此只留一个
// 让"即将结束的回答写完最后几个字节、用量能入账"的宽限，其余交给客户端重试。
// 曾经的 90s 设定在 macOS 后台常驻路径上也从未真正生效（被 supervisor 的 15s 上限截断）。

const DEFAULT_DRAIN_TIMEOUT_MS = 2 * 1000;
// 停止方（aih server restart/stop、launchd ExitTimeOut、systemd TimeoutStopSec）等待进程
// 退出的上限：排空宽限 + 停 Go Core（≤4.5s）与插件宿主（≤6s）的余量。
// 正常关闭远低于它；只有某个环节真的卡死才会用满（见 server.js 的 [aih:shutdown] 计时）。
const SHUTDOWN_GRACE_MS = DEFAULT_DRAIN_TIMEOUT_MS + 10 * 1000;

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
