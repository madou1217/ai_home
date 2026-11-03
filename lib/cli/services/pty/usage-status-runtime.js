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
    getRouteObservation,
    getSessionState,
    // 自动换号的判定层（lib/cli/services/pty/auto-switch-policy）。缺省 = 没有这个模式：
    // 阈值看门狗不启动，429 触发由运行时自己的输出观察器负责。
    autoSwitchPolicy
  } = deps;
  const {
    readCodexApiKeyAccountInfo,
    buildRuntimeBlockedSummary
  } = stateStore;

  let thresholdTimer = null;
  let thresholdFirstTimer = null;
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
      route: typeof getRouteObservation === 'function' ? (getRouteObservation() || null) : null,
      sessionState: typeof getSessionState === 'function' ? (getSessionState() || null) : null
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

  // Hook 事件（提问 / 权限请求 / 中断 / 失败）由 server 写进会话状态，标题要在它落盘后
  // 立刻跟上，而不是等下一个轮播节拍或用户输入。读侧是 store 的同步小文件读；只有
  // revision / lastEventAt 变化才重算，静止时这个节拍什么都不写。
  let sessionStateTimer = null;
  let lastSessionStateSignature = '';
  function readSessionStateSignature() {
    if (typeof getSessionState !== 'function') return '';
    try {
      const state = getSessionState();
      if (!state) return '';
      return `${state.revision || 0}:${state.lastEventAt || 0}:${state.turnState || ''}`;
    } catch (_error) {
      return '';
    }
  }
  function startSessionStateWatcher() {
    if (sessionStateTimer || typeof getSessionState !== 'function') return;
    lastSessionStateSignature = readSessionStateSignature();
    sessionStateTimer = setInterval(() => {
      if (isCleanedUp()) return;
      const signature = readSessionStateSignature();
      if (signature === lastSessionStateSignature) return;
      lastSessionStateSignature = signature;
      terminalTitle.refresh();
    }, 500);
    if (sessionStateTimer && typeof sessionStateTimer.unref === 'function') sessionStateTimer.unref();
  }
  function stopSessionStateWatcher() {
    if (!sessionStateTimer) return;
    clearInterval(sessionStateTimer);
    sessionStateTimer = null;
  }

  function startRuntimeTitleWatcher() {
    if (!shouldShowTerminalTitle()) return;
    terminalTitle.start();
    startSessionStateWatcher();
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
    const changed = signature !== lastUsageDisplaySignature;
    if (!forcePrint && !changed) return;
    lastUsageDisplaySignature = signature;
    writeUsageStatusLine();
    // 新快照落地 → 立刻判一次额度阈值（动作在 maybeAutoSwitchOnUsage 里防抖）。
    // 只在数值变化时判，避免 900ms 的节拍反复读配置；过期的快照不判——标题可以
    // 显示一个旧数字，换号不能拿旧数字做决定。
    const capturedAt = Number(status.capturedAt);
    const fresh = Number.isFinite(capturedAt) && capturedAt > 0 && (Date.now() - capturedAt <= getUsageStaleMs());
    if (changed && fresh && Number.isFinite(status.remainingPct)) {
      maybeAutoSwitchOnUsage(status.remainingPct);
    }
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

  // 自动换号的**动作**只有一条路：requestAccountSwitch → switchToAccount（真机已验证的
  // 续接路径）。这里只做「该不该换」的判定与防抖——一次额度见底会在多个节拍里被看到
  // （900ms 的用量节拍 + 60s 的看门狗），不防抖就会连续触发。
  const AUTO_SWITCH_ATTEMPT_DEBOUNCE_MS = 30_000;
  const AUTO_SWITCH_NOTICE_REPEAT_MS = 5 * 60_000;
  let lastAutoSwitchAttemptAt = 0;
  let lastAutoSwitchNoticeAt = 0;
  let lastAutoSwitchNoticeText = '';

  function notifyAutoSwitchBlocked(text) {
    const at = Date.now();
    if (text === lastAutoSwitchNoticeText && at - lastAutoSwitchNoticeAt < AUTO_SWITCH_NOTICE_REPEAT_MS) return;
    lastAutoSwitchNoticeAt = at;
    lastAutoSwitchNoticeText = text;
    processObj.stdout.write(`\r\n\x1b[90m[aih] ${text}\x1b[0m\r\n`);
  }

  function maybeAutoSwitchOnUsage(remainingPct) {
    if (!autoSwitchPolicy || typeof autoSwitchPolicy.evaluateUsage !== 'function') return false;
    if (isSwapping() || !hasActivePty()) return false;
    const decision = autoSwitchPolicy.evaluateUsage(remainingPct);
    if (!decision.switch) return false;
    const at = Date.now();
    if (at - lastAutoSwitchAttemptAt < AUTO_SWITCH_ATTEMPT_DEBOUNCE_MS) return false;
    lastAutoSwitchAttemptAt = at;
    const nextId = getNextRuntimeAccountId({ excludeCooling: true });
    if (!nextId || String(nextId) === getDisplayAccountId()) {
      notifyAutoSwitchBlocked(`${decision.reason}，但没有可切换的账号（其余账号不可用或正在冷却）。`);
      return false;
    }
    requestAccountSwitch(nextId, decision.reason);
    return true;
  }

  // 自动换号需要**新鲜**的额度事实：显示路径可以容忍「5 分钟内的快照」，换号不能——
  // 快照过期就主动探一次（同一账号 60s 内只探一次）。这条路径刻意不看 ptyUsageStatus：
  // 那个开关管的是标题显不显示用量，不是这个模式该不该有数据。
  let lastAutoSwitchRefreshAt = 0;
  function refreshUsageForAutoSwitch() {
    if (typeof refreshUsageSnapshotNoCache !== 'function') return;
    const targetRef = String(getActiveAccountRef() || '').trim();
    if (!/^acct_[a-f0-9]{20}$/.test(targetRef)) return;
    const at = Date.now();
    if (at - lastAutoSwitchRefreshAt < 60_000) return;
    lastAutoSwitchRefreshAt = at;
    // 与显示路径共用同一个「正在探」标记：两条路不要同时打同一个探测。
    usageRefreshInFlight = true;
    Promise.resolve()
      .then(() => refreshUsageSnapshotNoCache(cliName, targetRef))
      .then(() => {
        if (isCleanedUp()) return;
        // 探到了就立刻判（这条路径不依赖 emitUsageStatus —— 用量显示关掉的
        // provider 不会走那条路）。
        const remaining = getCurrentRemainingPct(targetRef);
        if (Number.isFinite(remaining)) maybeAutoSwitchOnUsage(remaining);
        else emitUsageStatus(targetRef, { forcePrint: true });
      })
      .catch(() => null)
      .finally(() => { usageRefreshInFlight = false; });
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

  // 额度看门狗：所有原生 provider 共用（以前只给 codex）。是否真的动手由
  // autoSwitchPolicy 决定——模式没开时每个节拍只读一次配置就返回，不动用量文件。
  //
  // 节拍 60s：用量快照本身就是分钟级刷新的，更密的轮询只会重复读到同一个数字。
  // 立即反应那条路在 emitUsageStatus（900ms 节拍）里——新快照一落地就能换。
  function startThresholdWatcher() {
    if (thresholdTimer || thresholdFirstTimer) return;
    if (isLogin || isGateway()) return;
    if (!isInteractiveSession(getForwardArgs())) return;
    const intervalMs = 60_000;
    const tick = () => {
      if (isCleanedUp() || isSwapping() || !hasActivePty()) return;
      if (!autoSwitchPolicy || !autoSwitchPolicy.isEnabled()) return;
      if (isUsageRefreshPausedByIdle()) return;
      const remaining = getCurrentRemainingPct(getActiveAccountRef());
      if (!Number.isFinite(remaining)) {
        // 没有可信数字就先补一次探测；探到新快照后会立刻判阈值。
        refreshUsageForAutoSwitch();
        return;
      }
      maybeAutoSwitchOnUsage(remaining);
    };
    // 启动后先判一次：账号本来就已用完时，用户不该等满一分钟才被换走。
    // （满额度的常见情况这一次什么也不做，代价是一次配置读 + 一次快照读。）
    thresholdFirstTimer = setTimeout(tick, 5_000);
    if (thresholdFirstTimer && typeof thresholdFirstTimer.unref === 'function') thresholdFirstTimer.unref();
    thresholdTimer = setInterval(tick, intervalMs);
    if (thresholdTimer && typeof thresholdTimer.unref === 'function') thresholdTimer.unref();
  }

  function stopThresholdWatcher() {
    if (thresholdFirstTimer) {
      clearTimeout(thresholdFirstTimer);
      thresholdFirstTimer = null;
    }
    if (thresholdTimer) {
      clearInterval(thresholdTimer);
      thresholdTimer = null;
    }
  }

  function getNextRuntimeAccountId(options = {}) {
    if (isGateway()) return null;
    // 冷却中的账号不能当换号目标：两个账号互相 429 时会来回弹。
    const excludeAccountRefs = options.excludeCooling && autoSwitchPolicy
      && typeof autoSwitchPolicy.coolingAccountRefs === 'function'
      ? autoSwitchPolicy.coolingAccountRefs()
      : [];
    const nextId = typeof getNextAvailableId === 'function'
      ? getNextAvailableId(cliName, getActiveCliAccountId(), { refreshSnapshot: false, excludeAccountRefs })
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
    stopSessionStateWatcher();
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

  // 事件播报（自动换号 / 续接失败……）：替换整条标题一小会儿，然后自动退场。
  // 与错误段同一入口，调用方不必知道标题的门面对象。
  function setTitleNotice(text, options) {
    terminalTitle.setNotice(text, options);
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
    setTitleNotice,
    refreshTitle,
    resetUsageDisplaySignature,
    getUsageStatusSummaryFallback
  };
}

module.exports = {
  createUsageStatusRuntime
};
