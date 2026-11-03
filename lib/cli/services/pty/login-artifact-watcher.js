'use strict';

// 登录产物轮询器。
//
// 事故形态（2026-10-30 真机，codebuddy 2.178.1）：`aih codebuddy login` 起在
// `run/login/codebuddy/auth-<uuid>` 的假 HOME 里，浏览器登录成功后 CLI 把凭据写进
// `Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`，
// **然后直接进 TUI**（产品配置 startChatAfterCompleted=true），进程不退出。
// 而 aih 的账号入库只挂在 PTY 的 onExit(exitCode===0) 上 —— 用户看到的就是
// 「浏览器显示登录成功，aih 里却没有账号」。
//
// 这个轮询器只做一件事：登录期间按固定间隔问 probe()「凭据落地了吗」，
// 连续 stableTicks 次都回答「是」才认为写完了（避免读到写了一半的文件），
// 然后把收尾交给调用方。它不碰文件、不碰进程，纯定时逻辑，便于单测。

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_STABLE_TICKS = 2;
const DEFAULT_MAX_ATTEMPTS = 900; // 15 分钟；超时就静默停手，交回原有 onExit 逻辑

function createLoginArtifactWatcher(options = {}) {
  const probe = options.probe;
  if (typeof probe !== 'function') throw new TypeError('login_artifact_watcher_probe_required');
  const onComplete = typeof options.onComplete === 'function' ? options.onComplete : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const intervalMs = Math.max(100, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const stableTicks = Math.max(1, Number(options.stableTicks) || DEFAULT_STABLE_TICKS);
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;

  let attempts = 0;
  let consecutive = 0;
  let timer = null;
  let stopped = false;

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  }

  function tick() {
    if (stopped) return false;
    attempts += 1;
    let ready = false;
    try {
      ready = probe() === true;
    } catch (error) {
      stop();
      onError(error);
      return false;
    }
    if (ready) {
      consecutive += 1;
      if (consecutive >= stableTicks) {
        stop();
        onComplete();
        return true;
      }
    } else {
      consecutive = 0;
    }
    if (attempts >= maxAttempts) stop();
    return false;
  }

  timer = setIntervalImpl(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    stop,
    tick,
    get attempts() { return attempts; },
    get running() { return !stopped; }
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STABLE_TICKS,
  createLoginArtifactWatcher
};
