'use strict';

/**
 * 登录进程退出时，这次登录算不算「完成」。
 *
 * 三条成立任一即算完成：
 *   1. 退出码 0 —— CLI 自己正常收尾；
 *   2. 轮询器已经判定完成并主动结束了进程（退出码必然非 0，被信号终止）；
 *   3. **凭据已经落地** —— 用户自己 Ctrl-C、CLI 崩溃、或轮询还没到点进程就先退出。
 *
 * 第 3 条是 2026-11-01 真机丢账号的入口：浏览器里已经登录成功、凭据已写进登录沙箱，
 * 但退出码非 0，旧逻辑直接走失败分支，把沙箱连同凭据一起清掉，账号从此不存在。
 *
 * 探针只回答「凭据文件是否已落地且非空」，不判真伪；凭据能不能用仍由登记时的
 * realm / 身份校验兜底（校验不过就登记失败，不会产生错账号）。
 *
 * 探针抛错按「未完成」处理：读盘异常不能把一次失败的登录判成成功。
 *
 * @param {{isLogin?: boolean, exitCode?: number|null, completedByWatcher?: boolean,
 *          probeArtifact?: (() => boolean)|null}} options
 * @returns {boolean}
 */
function shouldCompleteLoginOnExit(options = {}) {
  const { isLogin, exitCode, completedByWatcher, probeArtifact } = options;
  if (isLogin !== true) return false;
  if (exitCode === 0) return true;
  if (completedByWatcher === true) return true;
  if (typeof probeArtifact !== 'function') return false;
  try {
    return probeArtifact() === true;
  } catch (_error) {
    return false;
  }
}

module.exports = { shouldCompleteLoginOnExit };
