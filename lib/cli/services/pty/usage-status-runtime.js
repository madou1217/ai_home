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
const {
  buildAccountLabel,
  resolveProviderShortLabel
} = require('./terminal-title-labels');
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
    // 标题状态行的两个内容来源：会话名与当前模型（两者都由运行时按需提供，
    // 缺省时标题退化为只显示账号项）。
    getSessionLabel,
    getActiveModel
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

  // 标题状态行对所有交互式会话生效——与用量是否被托管无关：标题要回答「这是哪个
  // 会话 / 哪个账号 / 在不在跑」，这对每个 provider 都成立。用量数字（如果该
  // provider 有）仍受用户的用量显示开关控制，只影响标题的最后一段。
  //
  // `show: '0'` 关掉的是整个终端标题面（历史上这个开关就是「不要动标题」），
  // 所以状态行同样让位。
  function shouldShowTerminalTitle(args = getForwardArgs()) {
    if (isLogin) return false;
    if (!isInteractiveSession(args)) return false;
    if (String(readRuntimeUsageField(processObj.env, 'show', '1')) === '0') return false;
    return !shouldSuppressUsageStatusForFullscreenTui(args);
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

  // 标题的「账号」段：`Cline:1:deepseek-xxx`（provider:序号:模型）。
  function buildTitleAccountLabel() {
    const accountRef = getActiveAccountRef();
    const cliAccountId = getDisplayAccountId(accountRef);
    if (!cliAccountId) return '';
    const model = typeof getActiveModel === 'function' ? String(getActiveModel() || '').trim() : '';
    return buildAccountLabel({
      provider: resolveProviderShortLabel(cliName),
      cliAccountId,
      model
    });
  }

  // 标题的「会话」段。
  function buildTitleSessionLabel() {
    return typeof getSessionLabel === 'function' ? String(getSessionLabel() || '').trim() : '';
  }

  // 标题的「用量」段：只在该 provider 有用量事实、且用户没关用量显示时出现。
  // 与账号段分开，是因为它是**会变的状态**（额度消耗、窗口重置），而账号段是身份。
  function buildTitleUsageLabel() {
    if (!shouldShowUsageNumbers() || !isUsageManagedCli(cliName)) return '';
    const accountRef = getActiveAccountRef();
    const usage = buildRuntimeTerminalTitle(accountRef, { withUsage: true });
    // [o:<id>:<剩余>] / [a:<id>] 里的 id 与账号段重复，标题里只留数字部分。
    const match = String(usage || '').match(/^\[[oa]:[^:]+(?::([^\]]+))?\]$/);
    if (!match) return '';
    return match[1] ? String(match[1]).trim() : '';
  }

  const terminalTitle = createTerminalTitle({
    processObj,
    isEnabled: () => canRenderUsageStatusBar() && shouldShowTerminalTitle(getForwardArgs()),
    isSuppressed: () => isShellDrawerVisible() || isAuthRecoveryPromptOpen(),
    getSessionLabel: buildTitleSessionLabel,
    getAccountLabel: buildTitleAccountLabel,
    getUsageLabel: buildTitleUsageLabel
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
