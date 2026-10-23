'use strict';

// Usage status runtime: everything about the usage surface of an interactive
// PTY session — remaining-percentage summaries, the account tag that the
// terminal title carries, background snapshot refresh with idle pause, the
// display/idle watchers, and the usage-threshold auto-switch POLICY. The
// lifecycle ACTION of switching accounts (kill pty, respawn) stays in the
// runtime and is reached through the requestAccountSwitch callback. Extracted
// from runCliPty; exported names match the original closure functions so call
// sites are unchanged.
//
// The terminal title itself (OSC 0 status line, spinner, error item) is owned
// by terminal-title.js; this module only produces its account/usage segments.

const { formatUsageWindows } = require('../usage/window-format');
const { readRuntimeUsageField } = require('../../../runtime/usage-settings');
const { createTerminalTitle } = require('./terminal-title');
const { getOrderedUsageWindows } = require('../usage/window-format');
function createUsageStatusRuntime(deps = {}) {
  const {
    fs,
    path,
    processObj,
    aiHomeDir,
    provider: cliName,
    isLogin,
    isUsageManagedCli,
    readUsageConfig,
    readUsageCache,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    getUsageRemainingPercentValues,
    getNextAvailableId,
    stateStore,
    getActiveAccountRef,
    isGateway,
    getActiveCliAccountId,
    getForwardArgs,
    isInteractiveSession,
    isCodexResumeArgs,
    isSwapping,
    hasActivePty,
    isCleanedUp,
    isAuthRecoveryPromptOpen,
    isShellDrawerVisible,
    setShellDrawerStatusSummary,
    requestAccountSwitch,
    // 标题的内容来源：会话名、当前模型，以及网关模式下的路由观测值（都由
    // 运行时按需提供，缺省时对应的帧不出）。
    getSessionLabel,
    getActiveModel,
    getRouteObservation
  } = deps;
  const {
    readCodexApiKeyAccountInfo,
    buildRuntimeBlockedSummary
  } = stateStore;

  let thresholdTimer = null;
  let usageDisplayTimer = null;
  let usageIdleStatusTimer = null;
  let lastUsageDisplaySignature = '';
  let lastKnownUsageStatusSummary = '';
  let usageRefreshInFlight = false;
  let lastUsageRefreshStartAt = 0;
  let lastSessionActivityAt = Date.now();

  function getDisplayAccountId(accountRef = getActiveAccountRef()) {
    return String(getActiveCliAccountId() || '').trim();
  }

  function canRenderUsageStatusBar() {
    const stdout = processObj.stdout || {};
    const stdin = processObj.stdin || {};
    if (stdout.isTTY === true) return true;
    if (stdin.isTTY === true) return true;
    return false;
  }

  // **只管 PTY 底部的用量状态行**，与终端标题无关（标题走 OSC 0，不占屏幕任何一行，
  // 见 shouldShowTerminalTitle）。底部状态行会真的挤占全屏 TUI 的最后一行，所以
  // codex 的续接 / 网关会话在那里仍然让位——这条语义从底部状态行诞生起就成立。
  function shouldSuppressUsageStatusForFullscreenTui(args = getForwardArgs()) {
    if (cliName !== 'codex') return false;
    return isCodexResumeArgs(args) || isGateway();
  }

  function stopUsageRefreshProcess() {
    usageRefreshInFlight = false;
  }

  function getUsageIdlePauseMs() {
    return 5 * 60 * 1000;
  }

  function isUsageRefreshPausedByIdle() {
    return Date.now() - lastSessionActivityAt > getUsageIdlePauseMs();
  }

  function markSessionActivity() {
    const wasIdle = isUsageRefreshPausedByIdle();
    lastSessionActivityAt = Date.now();
    if (wasIdle) {
      emitUsageStatus(getActiveAccountRef(), { forcePrint: true, forceRefresh: true, bypassIdleCheck: true });
    }
  }

  async function refreshUsageSnapshotNoCache(cliNameArg, idArg) {
    const cache = readUsageCache(cliNameArg, idArg);
    if (typeof ensureUsageSnapshotAsync === 'function') {
      return ensureUsageSnapshotAsync(cliNameArg, idArg, cache, { forceRefresh: true });
    }
    if (typeof ensureUsageSnapshot === 'function') {
      return ensureUsageSnapshot(cliNameArg, idArg, cache, { forceRefresh: true });
    }
    return cache;
  }

  function getUsageDisplayIntervalMs() {
    return 60_000;
  }

  function getUsageStaleMs() {
    return 300_000;
  }

  function shouldShowUsageInPty(args = getForwardArgs()) {
    const enabled = String(readRuntimeUsageField(processObj.env, 'show', '1')) !== '0';
    const interactive = isInteractiveSession(args);
    return enabled && interactive && isUsageManagedCli(cliName) && !shouldSuppressUsageStatusForFullscreenTui(args);
  }

  // 标题状态行对**所有**交互式会话生效——与用量是否被托管、走网关还是钉选账号、
  // 以及是哪家 provider 都无关。标题要回答「这是哪个会话 / 哪个账号 / 在不在跑」，
  // 这对每个 provider 都成立，`aih claude` 与 `aih codex` 在这里没有区别。
  //
  // 被抑制的只有三类**真的不该动标题**的场景：
  //   * 登录流（屏幕交给认证交互，标题由它自己管）
  //   * 非交互会话（`-p` 之类的 headless 运行）
  //   * 用户显式关掉（`show: '0'` —— 历史上这个开关就是「不要动标题」）
  //
  // 曾经的 `shouldSuppressUsageStatusForFullscreenTui`（codex + 网关/续接）已删除：
  // 它是「用量数字会挤占全屏 TUI 底部行」时代的遗留，而标题走 OSC 0、不占屏幕
  // 任何一行，抑制它反而让网关会话的标题永远停在静态的「AIH GPT」。
  function shouldShowTerminalTitle(args = getForwardArgs()) {
    if (isLogin) return false;
    if (!isInteractiveSession(args)) return false;
    if (String(readRuntimeUsageField(processObj.env, 'show', '1')) === '0') return false;
    return true;
  }

  // 账号身份帧（邮箱 / 套餐）的开关：默认关闭——`aih ls` 的账号序号已经能对上人，
  // 标签栏里塞邮箱是长文本。用户显式要（runtime usage 的 identity=1）时才显示。
  // 与用量开关分开：用量是「剩多少」，身份是「这是谁的账号」。
  function shouldShowAccountIdentity() {
    return String(readRuntimeUsageField(processObj.env, 'identity', '0')) === '1';
  }

  function shouldShowUsageNumbers() {
    return String(readRuntimeUsageField(processObj.env, 'show', '1')) !== '0';
  }

  function buildApiKeyStatusSummary(accountRef) {
    const ref = String(accountRef || '').trim();
    const displayId = getDisplayAccountId(ref);
    const info = readCodexApiKeyAccountInfo(ref);
    if (!info.apiKeyMode) return '';
    return `account ${displayId} api-key mode`;
  }

  function buildInitialUsageStatusSummary(accountRef) {
    const targetRef = String(accountRef || getActiveAccountRef() || '').trim();
    const displayId = getDisplayAccountId(targetRef);
    return buildApiKeyStatusSummary(targetRef) || `account ${displayId} usage remaining: unknown`;
  }

  function buildUsageStatusFromCache(cache) {
    const capturedAt = Number(cache && cache.capturedAt);
    const safeCapturedAt = Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : null;
    const values = getUsageRemainingPercentValues(cache);
    if (!values.length) {
      return {
        remainingPct: null,
        capturedAt: safeCapturedAt
      };
    }
    return {
      remainingPct: Math.min(...values),
      capturedAt: safeCapturedAt
    };
  }

  function refreshUsageInBackgroundIfStale(id, cache) {
    const capturedAt = Number(cache && cache.capturedAt);
    const stale = !cache || !Number.isFinite(capturedAt) || capturedAt <= 0 || (Date.now() - capturedAt > getUsageStaleMs());
    if (stale) {
      tryRefreshUsageSnapshotInBackground(id);
    }
  }

  function buildUsageStatusSummary(status, accountRef) {
    const cliAccountId = getDisplayAccountId(accountRef);
    if (!Number.isFinite(status && status.remainingPct)) {
      return `account ${cliAccountId} usage remaining: unknown`;
    }
    return `account ${cliAccountId} usage remaining: ${status.remainingPct.toFixed(1)}%`;
  }

  function isUsageApiKeyAccount(accountRef) {
    // buildApiKeyStatusSummary is non-empty only for API-key accounts (codex
    // api-key creds, or the built-in aih server profile); oauth → empty.
    return !!buildApiKeyStatusSummary(String(accountRef || '').trim());
  }

  function formatUsageRemainingShort(accountRef) {
    const cache = readUsageCache(cliName, String(accountRef || '').trim());
    // codex/claude: every window that has a figure, compact (e.g. "5h:91% 7days:52%").
    const windows = formatUsageWindows(cache, { compact: true });
    if (windows) return windows;
    const status = buildUsageStatusFromCache(cache);
    if (!Number.isFinite(status.remainingPct)) return '?';
    const pct = Math.max(0, Math.min(100, status.remainingPct));
    return `${Math.round(pct)}%`;
  }

  // Compact, screen-safe account tag. OAuth accounts carry their remaining
  // headroom ([o:<id>:<remaining>]); API-key accounts have no usage figure
  // ([a:<id>]). 这是标题里的**用量**事实，状态行把它与身份段并列展示。
  function buildUsageTitle(accountRef = getActiveAccountRef()) {
    const ref = String(accountRef || '').trim();
    const cliAccountId = getDisplayAccountId(ref);
    if (!cliAccountId) return '';
    if (isUsageApiKeyAccount(ref)) return `[a:${cliAccountId}]`;
    return `[o:${cliAccountId}:${formatUsageRemainingShort(ref)}]`;
  }

  function buildRuntimeTerminalTitle(accountRef = getActiveAccountRef(), options = {}) {
    const cliAccountId = getDisplayAccountId(accountRef);
    const usageTitle = options.withUsage === false
      ? (cliAccountId ? `[a:${cliAccountId}]` : '')
      : buildUsageTitle(accountRef);
    if (!usageTitle) return '';
    return usageTitle;
  }

  // 标题的「会话」段：provider 侧的可读标题，或用户显式命名的会话。
  function buildTitleSessionLabel() {
    return typeof getSessionLabel === 'function' ? String(getSessionLabel() || '').trim() : '';
  }

  // 标题的「额度」帧：只在该 provider 有用量事实、且用户没关用量显示时出现。
  // 归一交给额度领域（lib/usage/quota 的视图模型），这里只把 scope 摊成
  // `{ label, remainingPct, resetIn }`，渲染规则在标题来源里（sources/index.js）。
  function buildTitleUsageFrames() {
    if (!shouldShowUsageNumbers()) return [];
    const accountRef = getActiveAccountRef();
    const cache = readUsageCache(cliName, String(accountRef || '').trim());
    const windows = getOrderedUsageWindows(cache);
    if (windows.length > 0) {
      return windows.map((entry) => ({
        label: entry.window,
        remainingPct: entry.remainingPct,
        resetIn: entry.resetIn
      }));
    }
    // 非时间窗形态（bucket / models）：退化成账号级单值，绝不伪造窗口标签。
    const status = buildUsageStatusFromCache(cache);
    if (!Number.isFinite(status.remainingPct)) return [];
    return [{ label: '', remainingPct: status.remainingPct, resetIn: '' }];
  }

  // 标题的「账号」帧（邮箱 / 套餐）：快照里的 account 事实。默认不出帧——标签栏里
  // 塞邮箱是长文本，用户显式要（runtime usage 的 identity=1）时才显示。
  function buildTitleAccountFacts() {
    if (!shouldShowAccountIdentity()) return null;
    const accountRef = getActiveAccountRef();
    const cache = readUsageCache(cliName, String(accountRef || '').trim());
    const account = cache && cache.account;
    if (!account || typeof account !== 'object') return null;
    return {
      email: String(account.email || '').trim(),
      planType: String(account.planType || account.planName || '').trim()
    };
  }

  // 门面的上下文：**唯一**给标题供数的地方。来源不认 provider，也不读全局状态，
  // 需要什么事实都在这里备齐。
  function collectTitleContext() {
    const accountRef = getActiveAccountRef();
    return {
      provider: cliName,
      accountId: getDisplayAccountId(accountRef),
      model: typeof getActiveModel === 'function' ? String(getActiveModel() || '').trim() : '',
      sessionLabel: buildTitleSessionLabel(),
      usageFrames: buildTitleUsageFrames(),
      account: buildTitleAccountFacts(),
      showAccountIdentity: shouldShowAccountIdentity(),
      // 网关模式：请求由本地 server 按池调度，每个回合可能落到不同账号。
      // 观测值由运行时注入（getRouteObservation），缺省为空 → 路由帧不出。
      route: typeof getRouteObservation === 'function' ? (getRouteObservation() || null) : null
    };
  }

  const terminalTitle = createTerminalTitle({
    processObj,
    isEnabled: () => canRenderUsageStatusBar() && shouldShowTerminalTitle(getForwardArgs()),
    isSuppressed: () => isShellDrawerVisible() || isAuthRecoveryPromptOpen(),
    collectContext: collectTitleContext
  });
  function writeTerminalProgress(state, progress = 0) {
    if (!processObj.env || !processObj.env.WT_SESSION) return;
    try {
      processObj.stdout.write(`\x1b]9;4;${Number(state) || 0};${Number(progress) || 0}\x07`);
    } catch (_error) {}
  }

  function clearRuntimeTerminalRunning() {
    writeTerminalProgress(0, 0);
  }

  // 标题写入统一经状态行：它自己负责去重与 OSC 0 序列。
  function writeUsageStatusLine(_lineText, _options = {}) {
    if (isShellDrawerVisible()) return;
    if (!canRenderUsageStatusBar()) return;
    terminalTitle.refresh();
  }

  function shouldShowProviderRuntimeTitle(args = getForwardArgs()) {
    if (shouldShowUsageInPty(args)) return false;
    if (isLogin) return false;
    return isInteractiveSession(args) && !shouldSuppressUsageStatusForFullscreenTui(args);
  }

  function writeProviderRuntimeTitle() {
    if (isShellDrawerVisible()) return;
    if (!canRenderUsageStatusBar()) return;
    if (!shouldShowProviderRuntimeTitle()) return;
    terminalTitle.refresh();
  }

  function startRuntimeTitleWatcher() {
    if (!shouldShowTerminalTitle()) return;
    terminalTitle.start();
  }

  function startUsageIdleStatusWatcher() {
    if (!shouldShowUsageInPty()) return;
    if (usageIdleStatusTimer) return;
    // Keep the cached summary (for the shell drawer) and the title fresh, and
    // react promptly to runtime-blocked transitions. emitUsageStatus dedupes,
    // so the title is only rewritten when its tag actually changes.
    usageIdleStatusTimer = setInterval(() => {
      if (isCleanedUp() || isSwapping() || !hasActivePty()) return;
      if (isAuthRecoveryPromptOpen()) return;
      emitUsageStatus(getActiveAccountRef(), { forcePrint: true, forceRefresh: false });
    }, 900);
    if (usageIdleStatusTimer && typeof usageIdleStatusTimer.unref === 'function') {
      usageIdleStatusTimer.unref();
    }
  }

  function emitUsageStatus(accountRef, options = {}) {
    if (isShellDrawerVisible()) return;
    if (isAuthRecoveryPromptOpen()) return;
    if (!shouldShowUsageInPty()) return;
    const forcePrint = !!options.forcePrint;
    const forceRefresh = !!options.forceRefresh;
    const bypassIdleCheck = !!options.bypassIdleCheck;
    if (!bypassIdleCheck && isUsageRefreshPausedByIdle()) {
      writeUsageStatusLine();
      return;
    }
    const targetRef = String(accountRef || getActiveAccountRef() || '').trim();
    const validAccountRef = /^acct_[a-f0-9]{20}$/.test(targetRef);
    if (!validAccountRef) {
      const apiKeySummary = buildApiKeyStatusSummary(targetRef);
      if (!apiKeySummary) return;
      lastKnownUsageStatusSummary = apiKeySummary;
      setShellDrawerStatusSummary(apiKeySummary);
      const signature = `${targetRef}|api-key`;
      if (!forcePrint && signature === lastUsageDisplaySignature) return;
      lastUsageDisplaySignature = signature;
      writeUsageStatusLine();
      return;
    }
    const runtimeSummary = buildRuntimeBlockedSummary(targetRef);
    if (runtimeSummary) {
      lastKnownUsageStatusSummary = runtimeSummary;
      setShellDrawerStatusSummary(runtimeSummary);
      const signature = `${targetRef}|runtime|${runtimeSummary}`;
      if (!forcePrint && signature === lastUsageDisplaySignature) return;
      lastUsageDisplaySignature = signature;
      writeUsageStatusLine();
      return;
    }
    const apiKeySummary = buildApiKeyStatusSummary(targetRef);
    if (apiKeySummary) {
      lastKnownUsageStatusSummary = apiKeySummary;
      setShellDrawerStatusSummary(apiKeySummary);
      const signature = `${targetRef}|api-key`;
      if (!forcePrint && signature === lastUsageDisplaySignature) return;
      lastUsageDisplaySignature = signature;
      writeUsageStatusLine();
      return;
    }
    const cache = readUsageCache(cliName, targetRef);
    if (forceRefresh) {
      tryRefreshUsageSnapshotInBackground(targetRef);
    } else {
      refreshUsageInBackgroundIfStale(targetRef, cache);
    }
    if (usageRefreshInFlight) {
      writeUsageStatusLine();
      return;
    }
    const status = buildUsageStatusFromCache(cache);
    lastKnownUsageStatusSummary = buildUsageStatusSummary(status, targetRef);
    setShellDrawerStatusSummary(lastKnownUsageStatusSummary);
    const remainingSignature = Number.isFinite(status.remainingPct) ? status.remainingPct.toFixed(3) : 'na';
    const signature = `${targetRef}|${status.capturedAt || 0}|${remainingSignature}`;
    if (!forcePrint && signature === lastUsageDisplaySignature) return;
    lastUsageDisplaySignature = signature;
    writeUsageStatusLine();
  }

  function tryRefreshUsageSnapshotInBackground(accountRef) {
    if (!isUsageManagedCli(cliName)) return;
    if (typeof ensureUsageSnapshot !== 'function' && typeof ensureUsageSnapshotAsync !== 'function') return;
    if (usageRefreshInFlight) return;
    const minIntervalMs = 60_000;
    const now = Date.now();
    if (now - lastUsageRefreshStartAt < minIntervalMs) return;
    const targetRef = String(accountRef || '').trim();
    if (!/^acct_[a-f0-9]{20}$/.test(targetRef)) return;

    lastUsageRefreshStartAt = now;
    usageRefreshInFlight = true;
    Promise.resolve()
      .then(() => refreshUsageSnapshotNoCache(cliName, targetRef))
      .catch(() => null)
      .finally(() => {
        usageRefreshInFlight = false;
        if (!isCleanedUp()) emitUsageStatus(targetRef, { forcePrint: true });
      });
  }

  function getThresholdPct() {
    const cfg = readUsageConfig({ fs, aiHomeDir });
    const val = Number(cfg && cfg.threshold_pct);
    if (!Number.isFinite(val)) return 95;
    return Math.max(1, Math.min(100, Math.floor(val)));
  }

  function getCurrentRemainingPct(accountRef) {
    if (buildRuntimeBlockedSummary(accountRef)) return null;
    if (buildApiKeyStatusSummary(accountRef)) return null;
    const cache = readUsageCache(cliName, accountRef);
    const capturedAt = Number(cache && cache.capturedAt);
    const stale = !cache || !Number.isFinite(capturedAt) || capturedAt <= 0 || (Date.now() - capturedAt > getUsageStaleMs());
    if (stale) {
      refreshUsageInBackgroundIfStale(accountRef, cache);
      return null;
    }
    const status = buildUsageStatusFromCache(cache);
    return status.remainingPct;
  }

  function startThresholdWatcher() {
    const enabled = true;
    const interactive = isInteractiveSession(getForwardArgs());
    if (!enabled || !interactive || cliName !== 'codex' || isGateway()) return;
    const intervalMs = 60_000;
    thresholdTimer = setInterval(() => {
      if (isSwapping() || !hasActivePty()) return;
      if (isUsageRefreshPausedByIdle()) return;
      const remaining = getCurrentRemainingPct(getActiveAccountRef());
      if (!Number.isFinite(remaining)) return;
      const usagePct = Math.max(0, Math.min(100, 100 - remaining));
      const thresholdPct = getThresholdPct();
      if (usagePct < thresholdPct) return;
      const nextId = getNextRuntimeAccountId();
      if (!nextId || String(nextId) === getActiveCliAccountId()) {
        processObj.stdout.write(`\r\n\x1b[90m[aih] usage ${remaining.toFixed(1)}% remaining (>= threshold hit), no eligible standby account.\x1b[0m\r\n`);
        return;
      }
      requestAccountSwitch(nextId, `usage threshold reached (${remaining.toFixed(1)}% remaining)`);
    }, intervalMs);
    if (thresholdTimer && typeof thresholdTimer.unref === 'function') thresholdTimer.unref();
  }

  function stopThresholdWatcher() {
    if (thresholdTimer) {
      clearInterval(thresholdTimer);
      thresholdTimer = null;
    }
  }

  function getNextRuntimeAccountId() {
    if (isGateway()) return null;
    const nextId = typeof getNextAvailableId === 'function'
      ? getNextAvailableId(cliName, getActiveCliAccountId(), { refreshSnapshot: false })
      : null;
    if (!nextId || String(nextId) === getActiveCliAccountId()) return nextId;
    return nextId;
  }

  function startUsageDisplayWatcher() {
    if (!shouldShowUsageInPty()) return;
    emitUsageStatus(getActiveAccountRef(), { forcePrint: true, forceRefresh: true });
    usageDisplayTimer = setInterval(() => {
      if (isSwapping() || !hasActivePty()) return;
      emitUsageStatus(getActiveAccountRef(), { forcePrint: true, forceRefresh: true });
    }, getUsageDisplayIntervalMs());
    if (usageDisplayTimer && typeof usageDisplayTimer.unref === 'function') usageDisplayTimer.unref();
  }
  function stopUsageWatchers() {
    if (usageDisplayTimer) {
      clearInterval(usageDisplayTimer);
      usageDisplayTimer = null;
    }
    if (usageIdleStatusTimer) {
      clearInterval(usageIdleStatusTimer);
      usageIdleStatusTimer = null;
    }
  }

  function resetUsageTitle() {
    terminalTitle.stop();
    terminalTitle.reset();
  }

  // 子进程活动 → 标题转圈。pty-runtime-run 在子进程有输出/输入时调用。
  function markTitleBusy() {
    terminalTitle.markBusy();
  }

  function markTitleIdle() {
    terminalTitle.markIdle();
  }

  // 中断 / 上游错误进标题的错误段（用户要求：这些状态也要能看到）。
  function setTitleError(text) {
    terminalTitle.setError(text);
  }

  function clearTitleError() {
    terminalTitle.clearError();
  }

  function refreshTitle() {
    terminalTitle.refresh();
  }

  function resetUsageDisplaySignature() {
    lastUsageDisplaySignature = '';
  }

  function getUsageStatusSummaryFallback() {
    if (isGateway()) return '';
    return lastKnownUsageStatusSummary || buildInitialUsageStatusSummary(getActiveAccountRef());
  }

  return {
    canRenderUsageStatusBar,
    shouldShowUsageInPty,
    shouldShowTerminalTitle,
    shouldShowUsageNumbers,
    shouldSuppressUsageStatusForFullscreenTui,
    markSessionActivity,
    isUsageRefreshPausedByIdle,
    stopUsageRefreshProcess,
    refreshUsageSnapshotNoCache,
    getUsageStaleMs,
    buildApiKeyStatusSummary,
    buildInitialUsageStatusSummary,
    buildUsageStatusFromCache,
    buildUsageStatusSummary,
    writeUsageStatusLine,
    writeTerminalProgress,
    clearRuntimeTerminalRunning,
    startRuntimeTitleWatcher,
    startUsageIdleStatusWatcher,
    startUsageDisplayWatcher,
    startThresholdWatcher,
    stopThresholdWatcher,
    getNextRuntimeAccountId,
    emitUsageStatus,
    stopUsageWatchers,
    resetUsageTitle,
    markTitleBusy,
    markTitleIdle,
    setTitleError,
    clearTitleError,
    refreshTitle,
    resetUsageDisplaySignature,
    getUsageStatusSummaryFallback
  };
}

module.exports = {
  createUsageStatusRuntime
};
