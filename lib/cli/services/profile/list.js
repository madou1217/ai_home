'use strict';

const { resolveEffectiveAccountStatus } = require('../../../account/status-file');
const {
  deriveRuntimeStatus,
  isBlockingRuntimeStatus,
  isAuthInvalidRuntimeStatus,
  formatRuntimeStatusLabel
} = require('../../../account/runtime-view');
const { readAccountCredentials } = require('../../../server/account-credential-store');
const { listCliAccountRefRecords } = require('../../../server/account-ref-store');
const { readGoAccounts } = require('../../../account/go-bridge/go-account-store-reader');
const { readJsonValue: readAppStateJsonValue } = require('../../../server/app-state-store');
const { readDefaultAccountRef } = require('../../../account/default-account-store');
const {
  activityOf,
  readAccountActivity,
  renderPrefix,
  runAnimatedList
} = require('./account-list-animator');
const { buildThrottleBadgeVariants } = require('./model-throttle');
const { buildAccountDisplayNames } = require('../../../server/account-display-identity');
const { enrichAccountView } = require('./enrich-account');

// 列表分两段出数据，别再合成一段：
//   1. 先用「账号索引 + 已缓存的展示态」把整屏画出来（只读 SQLite，毫秒级）；
//   2. 每个账号的重活（读凭据 / 刷新索引 / 用量标签 / 套餐徽章）单独排队补算，
//      一次只算一个，算完下一帧自动出现。
// 之前是在一帧里对**所有**账号做重活（实测 ~150ms/账号），40 个账号就是每帧阻塞
// 好几秒——列表看着像卡死。现在任何一帧最多只有一个账号的重活。
const ENRICH_TICK_MS = 250;
// 同一个账号的展示态多久重算一次。索引里的状态本来就会持续更新，这里只是保底刷新，
// 没必要每秒把每个账号的凭据、用量快照、索引写一遍。
const ENRICH_TTL_MS = 15000;
// 非交互输出（管道/重定向）也按时间片补算，避免长任务把 Ctrl+C 挡住。
const ENRICH_SLICE_MS = 40;
// 一行放不下所有用量分组 / 多个限流条目：轮换显示，每次只出现一条。
//
// 调度是**全局节拍 + 轮流**，不是每行各按各的时钟跳：
//   * 一个节拍（ROTATE_STEP_MS）只让一个账号换一次内容 —— 不会出现"整屏同时跳"，
//     也不会"刚刷完又刷"；
//   * 每个账号按轮到的次数推进自己的候选下标，N 个需要轮换的账号就是一个 N 拍循环。
const ROTATE_STEP_MS = 1500;

/**
 * 某个账号当前轮到第几次。
 *
 * @param {{slot: number, rotatingCount: number, stepMs?: number, startedAt?: number, nowMs?: number}} input
 * @returns {number} 轮换次数（对候选数取模即得下标）
 */
function rotationTurn(input = {}) {
  const slot = Math.max(0, Number(input.slot) || 0);
  const count = Math.max(1, Number(input.rotatingCount) || 1);
  const stepMs = Number(input.stepMs) > 0 ? Number(input.stepMs) : ROTATE_STEP_MS;
  const startedAt = Number(input.startedAt) || 0;
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const step = Math.floor((nowMs - startedAt) / stepMs);
  // 首屏展示下标 0；slot 在第 slot+1 拍轮到自己，之后每 count 拍再轮一次。
  if (!Number.isFinite(step) || step <= slot) return 0;
  return 1 + Math.floor((step - 1 - slot) / count);
}

/**
 * 列表的 provider 作用域：null = 全量，否则是大小写归一后的名字集合。
 * 接受单个名字（旧调用）、数组（通配/--scope 解析结果）或 Set。
 */
/**
 * 按筛选词裁行：**逐行**判断，不是整块保留。
 * provider 头只在"它下面还有行命中"时留下（否则会剩一堆孤零零的分组标题）；
 * 命中的 provider 里没命中的账号也要丢掉——否则搜 "qq" 仍然把 gmail 账号摆在眼前，
 * 那就不叫筛选了。标题/空行只在有内容存活时才保留。
 * 一个都没命中时给一行明确提示，而不是空白屏。
 */
function filterListRows(rows, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return rows;
  const head = [];
  const blocks = [];
  let current = null;
  rows.forEach((row) => {
    if (row.kind === 'provider') {
      current = [row];
      blocks.push(current);
      return;
    }
    if (current) current.push(row);
    else head.push(row);
  });
  const kept = [];
  blocks.forEach((block) => {
    const [header, ...children] = block;
    const hits = children.filter((row) => row.text.includes(needle));
    if (hits.length === 0) return;
    kept.push(header, ...hits);
  });
  if (kept.length === 0) {
    return [{ render: () => `  No accounts match "${query}".`, meta: null, kind: 'notice', text: '' }];
  }
  return [...head, ...kept];
}

/** 去掉 SGR 序列：筛选比对的是"用户看到的文字"，不是颜色码。 */
function stripAnsi(text) {
  return String(text == null ? '' : text).replace(/\x1b\[[0-9;]*m/g, '');
}

function normalizeProviderFilter(filter) {
  if (!filter) return null;
  const list = Array.isArray(filter)
    ? filter
    : (filter instanceof Set ? Array.from(filter) : [filter]);
  const names = list
    .map((name) => String(name == null ? '' : name).trim().toLowerCase())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

/**
 * 账号可展示身份（与 WebUI 完全同一套）：邮箱 → 手机 → 昵称，数组顺序即轮播顺序。
 * 哪些身份存在由服务端的 buildAccountDisplayNames 判定，CLI 不再按 provider 拼身份。
 */
function buildIdentityVariants(status, apiKeyMode, accountName) {
  const source = status && typeof status === 'object' ? status : {};
  const fallbackName = accountName && accountName !== 'Unknown' ? accountName : '';
  const entries = buildAccountDisplayNames({
    displayName: String(source.nickname || source.accountName || fallbackName || '').trim(),
    phone: source.phone,
    email: source.email || source.accountEmail,
    apiKeyMode: !!apiKeyMode
  });
  return entries
    .map((entry) => String(entry && entry.value || '').trim())
    .filter(Boolean);
}

function createProfileListService(options = {}) {
  const {
    fs,
    path,
    processObj,
    aiHomeDir,
    cliConfigs,
    listPageSize,
    getAccountStateIndex,
    checkStatus,
    formatAccountPlanBadge,
    formatUsageLabel,
    formatUsageLabelVariants,
    refreshIndexedStateForAccount,
    // 可选：把补算丢给 worker（fast path 用）。没有就退回主线程兜底。
    accountEnricher
  } = options;
  const renderAccountPlanBadge = typeof formatAccountPlanBadge === 'function'
    ? formatAccountPlanBadge
    : () => '';

  // key = `${provider}:${accountRef}` → { at, status, apiKeyMode, baseUrl, derived, usageLabel, usageVariants, planBadge }
  const viewCache = new Map();
  // TTY 才轮换（一行放不下多个分组）；管道输出保持"全量一行"，脚本可读且稳定。
  let rotateLabels = false;
  const rotateStepMs = Number(options.rotateStepMs) > 0
    ? Number(options.rotateStepMs)
    : ROTATE_STEP_MS;
  const rotateStartedAt = Date.now();
  // 补算拿到新候选后要立刻重排槽位，否则要等下一次 1s 重建才会开始轮换。
  let refreshRotationSlots = null;

  function showLsHelp(scope = null) {
    const target = scope ? `aih ${scope} ls` : 'aih ls';
    console.log(`
\x1b[36mAI Home List Mode Help\x1b[0m

\x1b[33mUsage:\x1b[0m
  ${target}
  ${target} <id>
  aih ls --scope <provider...>
  aih <name|glob> ls [id]

\x1b[33mBehavior:\x1b[0m
  - Default output: first ${listPageSize} accounts.
  - The provider slot is fuzzy: a bare name matches as a substring, so
    \`aih buddy ls\` == \`aih ls --scope codebuddy codebuddycn workbuddy workbuddycn\`.
    No quotes needed — zsh expands \`*\` before aih ever runs.
  - Globs still work when quoted: \`aih '*buddy*' ls\` (\`*\` = any run, \`?\` = one char,
    case-insensitive). \`--scope\` takes comma-separated values and may be repeated.
    A selector that matches no provider is an error, never a silent full list.
  - Interactive mode: if output is a terminal (TTY), locks the screen and
    live-refreshes account status/usage/activity every second.
  - First paint comes from the account index only; credential/usage details are
    filled in asynchronously, one account at a time, so the list never freezes.
  - Keys in live mode: \x1b[32m/\x1b[0m = filter (type to narrow; Enter keeps it, Esc clears it),
    \x1b[32mq\x1b[0m / \x1b[32mEsc\x1b[0m = quit, \x1b[32mCtrl+C\x1b[0m = quit. While typing a filter,
    q is just a character. With a filter applied, Esc clears it first and quits on the next press.
  - Non-interactive mode (pipe/redirect): show first ${listPageSize} and print omitted count.
  - Throttling is shown as a yellow badge, one entry at a time:
    \x1b[33m[限流: deepseek-v4.1-flash 至 14:29]\x1b[0m for a model-scoped cooldown (the
    account itself is still schedulable) or \x1b[33m[限流: 账号 至 12:30]\x1b[0m when the
    whole account is rate limited (same fact as WebUI's rate_limited). "受限"
    means the upstream refuses that model for another reason (e.g. plan tier).
  - Usage groups rotate as well: only one "[Remaining: ...]" entry is shown per
    line (percent vs credits / per-window / per-model buckets). Rotation is
    scheduled globally: one account advances per beat (~1.5s), never several at
    the same time, so the screen stays calm instead of flickering.

\x1b[33mExamples:\x1b[0m
  aih ls
  aih codex ls
  aih codex ls 24444
  aih codex ls --help
  aih ls --scope codebuddy workbuddy
  aih buddy ls              # substring: all four buddy providers, no quotes
  aih '*buddy*' ls          # same thing with a glob (quote it, or zsh expands it)
  aih cn ls 24444
`);
  }

  function readLatestIndexedRow(accountRef, fallbackRow) {
    if (typeof getAccountStateIndex !== 'function') return fallbackRow;
    try {
      const index = getAccountStateIndex();
      if (!index || typeof index.getAccountState !== 'function') return fallbackRow;
      return index.getAccountState(accountRef) || fallbackRow;
    } catch (_error) {
      return fallbackRow;
    }
  }

  function readCodexMobileAccountRef() {
    const statePath = path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
    try {
      if (!fs.existsSync(statePath)) return '';
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const stateRef = String(parsed && parsed.desktopAccountRef || '').trim();
      return /^acct_[a-f0-9]{20}$/.test(stateRef) ? stateRef : '';
    } catch (_error) {
      return '';
    }
  }

  function cachedView(provider, accountRef) {
    return viewCache.get(`${provider}:${accountRef}`) || null;
  }

  /**
   * 这一行现在能显示什么。索引给"便宜"的事实（状态/剩余率/模型冷却/显示名），
   * 缓存给"贵"的事实（凭据、用量窗口、套餐）。缓存没有也能出完整的一行，只是细一点。
   */
  // 渲染每 100ms 一帧、每帧都要视图：身份/限流候选这类派生不必每帧重算，
  // 只要补算缓存没变（cache.at 相同）就复用 500ms 内的结果。
  const rowViewCache = new Map();

  function resolveRowView(model) {
    const cacheKey = `${model.provider}:${model.accountRef}`;
    const cachedForHit = cachedView(model.provider, model.accountRef);
    const cacheStamp = cachedForHit && cachedForHit.at ? cachedForHit.at : 0;
    const hit = rowViewCache.get(cacheKey);
    if (hit && hit.cacheStamp === cacheStamp && Date.now() - hit.at < 500) return hit.view;

    const indexRow = model.indexRow;
    const cached = cachedView(model.provider, model.accountRef);
    const status = cached && cached.status ? cached.status : null;
    const derived = cached && cached.derived ? cached.derived : null;
    // null = 索引里还没有这个账号的状态，先按"未知"渲染（不误报 [待登录]）。
    const configured = cached && status && typeof status.configured === 'boolean'
      ? !!status.configured
      : (indexRow ? !!indexRow.configured : null);
    const accountName = (status && status.accountName)
      ? String(status.accountName)
      : (indexRow && indexRow.displayName ? String(indexRow.displayName) : 'Unknown');
    const accountEmail = status && typeof status.accountEmail === 'string'
      ? status.accountEmail.trim()
      : '';
    const identityKey = status && typeof status.identityKey === 'string' ? status.identityKey : '';
    const apiKeyMode = cached
      ? !!cached.apiKeyMode
      : !!(indexRow && indexRow.apiKeyMode);
    const baseUrl = cached && cached.baseUrl ? String(cached.baseUrl) : '';
    const quotaStatus = derived ? String(derived.quotaStatus || '').trim() : '';
    let remainingPct = derived && typeof derived.remainingPct === 'number'
      ? derived.remainingPct
      : (indexRow && typeof indexRow.remainingPct === 'number' ? indexRow.remainingPct : null);
    const operationalStatus = resolveEffectiveAccountStatus(
      (derived && derived.status != null ? derived.status : null) || (indexRow && indexRow.status)
    );
    // 状态检查器直接给出的运行时结论优先（例如 zcode 的桌面会话过期）；
    // 否则回落到索引里的运行时状态。
    const runtimeStatus = (status && status.runtimeStatus) || deriveRuntimeStatus(indexRow);
    const runtimeBlocked = isBlockingRuntimeStatus(runtimeStatus);
    const usageLabel = cached ? String(cached.usageLabel || '') : '';
    // 分组用量轮换候选：优先用分条数据；老缓存只有单条时退化成一条。
    const usageVariants = cached && Array.isArray(cached.usageVariants) && cached.usageVariants.length > 0
      ? cached.usageVariants.map((item) => String(item || '')).filter(Boolean)
      : (usageLabel ? [usageLabel] : []);
    // 限流徽章同样有多条候选（账号级 + 各模型），按时间轮换显示。
    const throttleVariants = buildThrottleBadgeVariants(
      indexRow && indexRow.runtimeState,
      runtimeStatus
    );
    // 身份轮播（邮箱 / 手机 / 昵称）：复用 WebUI 的装配，顺序即轮播顺序。
    const identityVariants = buildIdentityVariants(status, apiKeyMode, accountName);
    const planBadge = cached && cached.planBadge ? String(cached.planBadge) : '';
    const view = {
      indexRow,
      cached,
      status,
      derived,
      configured,
      accountName,
      accountEmail,
      identityKey,
      apiKeyMode,
      baseUrl,
      quotaStatus,
      remainingPct,
      operationalStatus,
      runtimeStatus,
      runtimeBlocked,
      usageLabel,
      usageVariants,
      throttleVariants,
      identityVariants,
      planBadge
    };
    rowViewCache.set(cacheKey, { at: Date.now(), cacheStamp, view });
    return view;
  }

  function formatAccountUsageLabel(view, rotation) {
    if (view.apiKeyMode) {
      return view.baseUrl
        ? `\x1b[90m[Base URL: ${view.baseUrl}]\x1b[0m`
        : '\x1b[90m[Remaining: API Key mode]\x1b[0m';
    }
    if (view.configured === false) {
      return '\x1b[90m[Remaining: Unconfigured (login required)]\x1b[0m';
    }
    if (view.runtimeBlocked) {
      // runtimeStatus 有两种形状：checkStatus 给字符串，deriveRuntimeStatus 给 {status,...}。
      const rawStatus = view.runtimeStatus;
      const status = String(typeof rawStatus === 'string' ? rawStatus : (rawStatus && rawStatus.status) || '')
        .trim()
        .toLowerCase();
      // 这两种已经有更精确的徽章，再说一遍就是同一句话重复两次：
      //   认证失效 → [认证失效]；账号级限流 → [限流: 账号 至 HH:MM]。
      if (status === 'auth_invalid' || status === 'rate_limited') return '';
      return `\x1b[31m${formatRuntimeStatusLabel(view.runtimeStatus)}\x1b[0m`;
    }
    // 分组用量按时间轮换：一次只显示一组（分组多 / 百分比与积分交替都由它实现）。
    if (rotateLabels && view.usageVariants.length > 0) {
      const index = ((rotation % view.usageVariants.length) + view.usageVariants.length) % view.usageVariants.length;
      return view.usageVariants[index];
    }
    // 非 TTY（管道/重定向）保留完整一行：所有分组都在，脚本读起来稳定。
    if (view.usageLabel) return view.usageLabel;
    if (view.usageVariants.length > 0) return view.usageVariants[0];
    if (typeof view.remainingPct === 'number') {
      return `\x1b[36m[Remaining: ${view.remainingPct.toFixed(1)}%]\x1b[0m`;
    }
    if (view.configured === null) return '\x1b[90m[Remaining: …]\x1b[0m';
    return '\x1b[90m[Remaining: Unknown]\x1b[0m';
  }

  function formatAccountRow(model, prefix) {
    const view = resolveRowView(model);
    const tool = model.provider;
    // 每行独立的轮换相位：不同账号在不同时刻切换，整屏不会同时跳。
    const rotation = model.rotationSlot >= 0
      ? rotationTurn({
        slot: model.rotationSlot,
        rotatingCount: model.rotatingCount,
        stepMs: rotateStepMs,
        startedAt: rotateStartedAt
      })
      : 0;
    const usageLabel = formatAccountUsageLabel(view, rotation);
    const throttleVariants = view.throttleVariants;
    let modelThrottleBadge = '';
    if (view.configured && !view.apiKeyMode && throttleVariants.length > 0) {
      if (rotateLabels && throttleVariants.length > 1) {
        modelThrottleBadge = throttleVariants[((rotation % throttleVariants.length) + throttleVariants.length) % throttleVariants.length];
      } else {
        modelThrottleBadge = throttleVariants.join(' ');
      }
    }
    const quotaBadge = !view.runtimeBlocked && !view.apiKeyMode && view.quotaStatus === 'exhausted'
      ? '\x1b[31m[额度已耗尽]\x1b[0m'
      : '';
    const statusBadge = view.operationalStatus === 'down'
      ? '\x1b[90m[关闭]\x1b[0m'
      : view.runtimeBlocked
      ? (isAuthInvalidRuntimeStatus(view.runtimeStatus) ? '\x1b[31m[认证失效]\x1b[0m' : '\x1b[31m[运行态不可用]\x1b[0m')
      : view.configured === false
      ? '\x1b[90m[待登录]\x1b[0m'
      : '';
    const roleBadges = [
      model.accountRef === model.defaultRef ? '\x1b[32m[★ Default]\x1b[0m' : '',
      tool === 'codex' && model.accountRef === model.mobileRef ? '\x1b[35m[📱 Mobile]\x1b[0m' : ''
    ].filter(Boolean).join(' ');
    const accountBadges = [roleBadges, statusBadge, quotaBadge, modelThrottleBadge].filter(Boolean).join(' ');
    const accountBadgesSuffix = accountBadges ? `  ${accountBadges}` : '';
    const planPrefix = view.planBadge ? `${view.planBadge} ` : '';
    // 身份：TTY 下按 WebUI 优先级（邮箱 → 手机 → 昵称）逐条轮换；管道输出保持一行全量。
    let accountInfo = '';
    if (view.configured && view.identityVariants.length > 0) {
      const identity = rotateLabels
        ? view.identityVariants[((rotation % view.identityVariants.length) + view.identityVariants.length) % view.identityVariants.length]
        : view.identityVariants.join(' / ');
      accountInfo = `(${identity})`;
    }
    return `${prefix}${planPrefix}Account ID: \x1b[36m${model.id}\x1b[0m${accountBadgesSuffix} \x1b[35m${accountInfo}\x1b[0m ${usageLabel} ${model.duplicateWarning || ''}`.replace(/\s+$/, '');
  }

  function shouldHideAccount(model, view, filterAccountId) {
    if (filterAccountId) return false;
    if (view.runtimeBlocked) return false;
    if (!view.configured) return false;
    if (view.apiKeyMode) return false;
    return Number.isFinite(view.remainingPct) && view.remainingPct <= 0;
  }

  // 交互筛选词（`/` 输入）。只影响显示，不影响补算——被筛掉的账号照样继续算，
  // 否则清空筛选后要等下一轮才有名字。
  let filterQuery = '';

  /** 把裁好的行投影成动画要的三份数组（`accounts` 不裁：补算要覆盖全部账号）。 */
  function projectRows(rows, accounts) {
    const visible = filterListRows(rows, filterQuery);
    return {
      outputRows: visible.map((row) => row.render),
      rowMeta: visible.map((row) => row.meta),
      accounts
    };
  }

  // Go 独有的账号（Node 别名表里没有对应 ref）。
  //
  // 账号是 Go 与 Node 两份库：Go 是写入方（浏览器登录、导入），Node 侧靠
  // go-account-sync 的链接表把两侧 ref 对上。对不上的就是「Go 独有」——例如
  // 2026-11-11 用 Go 完成 agy 登录后的账号：它真实存在、可用，但 `aih ls`
  // 以前只列 Node 别名表，于是完全看不见。
  //
  // 列表动画每秒重绘一次，aih.db 不能每秒读一遍：按 GO_ONLY_TTL_MS 缓存。
  const GO_ONLY_TTL_MS = 5000;
  let goOnlyCache = { at: 0, byProvider: new Map() };

  function readSyncLinks() {
    try {
      const state = readAppStateJsonValue(fs, aiHomeDir, 'go-account-sync:state');
      const links = state && state.links && typeof state.links === 'object' ? state.links : {};
      const mapped = {};
      for (const [nodeRef, link] of Object.entries(links)) {
        if (link && link.goRef) mapped[nodeRef] = String(link.goRef);
      }
      return mapped;
    } catch (_error) {
      return {};
    }
  }

  function readGoOnlyAccountRecords() {
    const now = Date.now();
    if (now - goOnlyCache.at < GO_ONLY_TTL_MS) return goOnlyCache.byProvider;
    const byProvider = new Map();
    try {
      const store = readGoAccounts(aiHomeDir, { fs });
      if (store && store.exists) {
        const linkedGoRefs = new Set(Object.values(readSyncLinks()));
        for (const account of store.accounts) {
          if (!account || !account.provider) continue;
          if (linkedGoRefs.has(account.accountRef)) continue;
          const credential = account.credential && typeof account.credential === 'object'
            ? account.credential
            : {};
          const email = String((account.profile && account.profile.email) || credential.email || '').trim();
          const list = byProvider.get(account.provider) || [];
          list.push({
            accountRef: account.accountRef,
            provider: account.provider,
            cliAccountId: String(account.cliAccountId || ''),
            createdAt: 0,
            updatedAt: Number(account.credentialUpdatedAtMs) || 0,
            // goOnly 行没有 Node 状态索引，行视图用这些事实兜底（否则会误报 [待登录]）。
            goOnly: true,
            email,
            enabled: account.enabled !== false,
            authKind: String(account.authKind || '')
          });
          byProvider.set(account.provider, list);
        }
      }
    } catch (_error) {
      // 读不到 Go 库时按"没有 Go 独有账号"处理：列表退化为原来的 Node 视图。
      return goOnlyCache.byProvider;
    }
    goOnlyCache = { at: now, byProvider };
    return byProvider;
  }

  /**
   * 便宜的一遍：只读账号引用 + 账号索引，产出行模型和渲染闭包。
   * 重活一个都不做——这是"先出列表"的那一遍。
   */
  function buildAccountListRows(filterProvider = null, filterAccountId = null) {
    const providerFilter = normalizeProviderFilter(filterProvider);
    const goOnlyByProvider = readGoOnlyAccountRecords();
    let tools = Object.keys(cliConfigs)
      .filter((tool) => listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length > 0
        || (goOnlyByProvider.get(tool) || []).length > 0);

    if (providerFilter) {
      tools = tools.filter((tool) => providerFilter.has(tool));
    }

    const rows = [];
    const accounts = [];
    const pushRow = (render, meta, kind, text = '') => {
      rows.push({ render, meta, kind, text: String(text).toLowerCase() });
    };

    if (tools.length === 0) {
      pushRow(() => '  No profiles found.', null, 'notice');
      return projectRows(rows, accounts);
    }

    // 全局行集合：所有 provider 的行收集完后统一渲染/动画，保证整屏重绘完整。
    // 作用域命中多个 provider 时把名单挂在标题上 —— 通配符展开成什么必须看得见，
    // 否则用户无法判断 `*buddy*` 到底选中了谁。单个 provider 不加（`aih codebuddy ls`
    // 的输出与以前逐字节一致）。
    const scopeLabel = providerFilter && providerFilter.size > 1
      ? `\x1b[90m · ${Array.from(providerFilter).join(', ')}\x1b[0m`
      : '';
    // 注意：每个元素必须**只占屏幕一行**。增量重绘用绝对行号定位，任何内嵌 \n
    // 都会让后续行整体错位（2026-11-04 真机：标题行带换行 → 整屏串行）。
    pushRow(() => '', null, 'spacer');
    pushRow(() => `\x1b[36m📦 AI Home Accounts Overview\x1b[0m${scopeLabel}`, null, 'title');
    pushRow(() => '', null, 'spacer');

    tools.forEach((tool) => {
      pushRow(() => `\x1b[33m▶ ${tool}\x1b[0m`, null, 'provider', tool);
      let indexedMap = new Map();
      try {
        const indexedStates = getAccountStateIndex().listStates(tool);
        indexedMap = new Map(indexedStates.map((row) => [row.accountRef, row]));
      } catch (_error) {
        indexedMap = new Map();
      }
      let records = listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true });
      // Go 独有的账号（Node 别名表里没有对应 ref）也要出现在 `aih ls` 里：
      // 2026-11-11 的 agy 登录就是这样——账号写在 Go，CLI 却完全看不见。
      const knownRefs = new Set(records.map((record) => record.accountRef));
      for (const goOnly of goOnlyByProvider.get(tool) || []) {
        if (knownRefs.has(goOnly.accountRef)) continue;
        records = [...records, goOnly];
        knownRefs.add(goOnly.accountRef);
      }
      if (filterAccountId && /^\d+$/.test(String(filterAccountId))) {
        records = records.filter((record) => record.cliAccountId === String(filterAccountId));
      }
      if (records.length === 0) {
        pushRow(() => '  (Empty)', null, 'empty', tool);
        return;
      }
      const seenAccounts = new Map();
      const defaultRef = readDefaultAccountRef(fs, aiHomeDir, tool);
      const mobileRef = tool === 'codex' ? readCodexMobileAccountRef() : '';

      records.forEach((record) => {
        // Go 独有账号没有 Node 状态索引：用 Go 的事实造一行等价索引（已配置、
        // 凭据来自 Go），否则行视图会把它当成「待登录」。
        const goOnlyIndexRow = record.goOnly ? {
          accountRef: record.accountRef,
          provider: tool,
          configured: true,
          status: record.enabled ? 'up' : 'down',
          displayName: record.email || '',
          apiKeyMode: record.authKind === 'api_key',
          remainingPct: null
        } : null;
        const model = {
          provider: tool,
          accountRef: record.accountRef,
          id: record.cliAccountId,
          // Go 独有账号：Node 侧没有凭据/状态可补算，跳过补算队列（见 enrichAccountInline）。
          goOnly: Boolean(record.goOnly),
          indexRow: indexedMap.get(record.accountRef) || goOnlyIndexRow,
          defaultRef,
          mobileRef,
          duplicateWarning: ''
        };
        const view = resolveRowView(model);
        if (shouldHideAccount(model, view, filterAccountId)) return;

        // 判重键：状态检查给出可信身份键（如 kiro 的 userInfo.userId）时只按身份判重；
        // 展示名可能是占位符，或同一邮箱下的不同身份，只作没有身份证据时的启发式。
        const identityKey = view.identityKey;
        const duplicateKey = identityKey ? `identity:${identityKey}` : `name:${view.accountName}`;
        if (view.configured && view.accountName !== 'Unknown' && view.accountName !== 'Token Configured' && !view.accountName.startsWith('API Key')) {
          if (seenAccounts.has(duplicateKey)) {
            model.duplicateWarning = ` \x1b[31m[⚠️ Duplicate of ID ${seenAccounts.get(duplicateKey)}]\x1b[0m`;
          } else {
            seenAccounts.set(duplicateKey, model.id);
          }
        }

        accounts.push(model);
        // 搜索文本就是"用户看到的那一行"去掉 ANSI，外加 provider 名（行里没有它）。
        // 多算一次 formatAccountRow 只在重建行时发生（1s 一次），换的是"所见即所搜"。
        pushRow(
          (prefix) => formatAccountRow(model, prefix),
          { provider: tool, accountRef: model.accountRef },
          'account',
          `${tool} ${stripAnsi(formatAccountRow(model, ''))}`
        );
      });
    });

    assignRotationSlots(accounts);
    return projectRows(rows, accounts);
  }

  /**
   * 只给"确实有多条候选"的账号排槽位：全局一个节拍推进一个槽位，
   * 所以同一时刻只有一行会换内容，不会整屏一起跳。
   */
  function assignRotationSlots(accounts) {
    const rotating = [];
    accounts.forEach((model) => {
      const view = resolveRowView(model);
      const multi = view.usageVariants.length > 1
        || view.identityVariants.length > 1
        || view.throttleVariants.length > 1;
      model.rotationSlot = multi ? rotating.length : -1;
      if (multi) rotating.push(model);
    });
    accounts.forEach((model) => { model.rotatingCount = rotating.length; });
  }

  /** 把补算结果写进展示缓存；行本身下一帧自动读到。 */
  function applyEnrichment(provider, accountRef, payload) {
    if (!payload) return false;
    viewCache.set(`${provider}:${accountRef}`, {
      at: Date.now(),
      status: payload.status || null,
      apiKeyMode: !!payload.apiKeyMode,
      baseUrl: String(payload.baseUrl || ''),
      derived: payload.derived || null,
      usageLabel: String(payload.usageLabel || ''),
      usageVariants: Array.isArray(payload.usageVariants)
        ? payload.usageVariants.map((item) => String(item || '')).filter(Boolean)
        : [],
      planBadge: String(payload.planBadge || '')
    });
    if (typeof refreshRotationSlots === 'function') refreshRotationSlots();
    return true;
  }

  /** 主线程兜底补算：worker 不可用（或没接 worker）时用，语义与 worker 侧完全一致。 */
  function enrichAccountInline(model) {
    // Go 独有账号的凭据在 Go 库里，Node 侧 checkStatus/readAccountCredentials 只会
    // 得出「未配置」并把行视图打回 [待登录]。这类行用建行时的 Go 事实，不做补算。
    if (model && model.goOnly) return true;
    const payload = enrichAccountView({
      provider: model.provider,
      accountRef: model.accountRef,
      indexRow: model.indexRow,
      fs,
      aiHomeDir,
      readAccountCredentials,
      checkStatus,
      formatUsageLabel,
      formatUsageLabelVariants,
      formatAccountPlanBadge: renderAccountPlanBadge,
      refreshIndexedStateForAccount
    });
    if (!payload) return false;
    applyEnrichment(model.provider, model.accountRef, payload);
    // 刷新索引后这一行的事实可能变了（剩余率、模型冷却、状态），顺手更新。
    model.indexRow = readLatestIndexedRow(model.accountRef, model.indexRow) || model.indexRow;
    return true;
  }

  function isStale(model, nowMs = Date.now()) {
    const cached = cachedView(model.provider, model.accountRef);
    if (!cached || !Number.isFinite(Number(cached.at))) return true;
    return nowMs - Number(cached.at) >= ENRICH_TTL_MS;
  }

  function toTask(model) {
    return { provider: model.provider, accountRef: model.accountRef, indexRow: model.indexRow };
  }

  /** 非交互：补算完全部账号再一次性打印（管道输出必须是完整快照）。 */
  function enrichAllThenPrint(accounts, rebuildAndPrint) {
    const finish = () => {
      // 一次性命令：用完就把 worker 关掉，别让它拖住退出。
      if (accountEnricher && typeof accountEnricher.close === 'function') accountEnricher.close();
      rebuildAndPrint();
    };
    if (accounts.length === 0) {
      finish();
      return Promise.resolve();
    }
    // 一次性命令（管道/重定向）不需要"帧"，主线程时间片补算最快，也省掉 worker 启动开销。
    return enrichAllInline(accounts).then(finish);
  }

  /** 主线程按时间片兜底补算（没有 worker，或 worker 不可用）。 */
  function enrichAllInline(accounts) {
    let cursor = 0;
    return new Promise((resolve) => {
      const step = () => {
        const sliceStart = Date.now();
        while (cursor < accounts.length && Date.now() - sliceStart < ENRICH_SLICE_MS) {
          enrichAccountInline(accounts[cursor]);
          cursor += 1;
        }
        if (cursor < accounts.length) {
          setImmediate(step);
          return;
        }
        resolve();
      };
      setImmediate(step);
    });
  }

  function listProfiles(filterProvider = null, filterAccountId = null) {
    const buildListRows = () => buildAccountListRows(filterProvider, filterAccountId);
    const first = buildListRows();
    const outputRows = first.outputRows;
    const rowMeta = first.rowMeta;
    const accounts = first.accounts;
    refreshRotationSlots = () => assignRotationSlots(accounts);

    const animator = runAnimatedList({
      renderLine: (prefix, index) => {
        const render = outputRows[index];
        return render ? render(prefix) : '';
      },
      lineCount: outputRows.length,
      readActivity: () => readAccountActivity(aiHomeDir, fs),
      activityOfRow: (activities, index) => {
        const meta = rowMeta[index];
        return meta && meta.accountRef ? activityOf(activities, meta.provider, meta.accountRef) : null;
      },
      refreshLines: () => {
        // 每秒只重建"便宜"的那一遍；重活由下面的补算队列负责。
        const next = buildListRows();
        outputRows.length = 0;
        outputRows.push(...next.outputRows);
        rowMeta.length = 0;
        rowMeta.push(...next.rowMeta);
        accounts.length = 0;
        accounts.push(...next.accounts);
        return outputRows.length;
      },
      // `/` 输入的查询词回写到服务层：下一次 buildListRows 就按它裁行。
      onFilterChange: (query) => { filterQuery = String(query || ''); },
      keepAlive: !!(processObj && processObj.stdin && typeof processObj.stdin.resume === 'function'),
      processObj,
      onExit: null
    });

    if (!animator) {
      const printAll = () => {
        const next = buildListRows();
        next.outputRows.forEach((render) => console.log(render(renderPrefix(null, null, { staticMarker: '●' }))));
        console.log('');
      };
      const done = enrichAllThenPrint(accounts, printAll);
      // 一次性输出跑完就该退出；万一还有句柄（worker/定时器）把事件循环挂住，
      // 10 秒后强制收尾 —— 绝不允许留下"跑完了还赖着"的 aih 进程。
      done.then(() => {
        const guard = setTimeout(() => {
          try {
            if (accountEnricher && typeof accountEnricher.close === 'function') accountEnricher.close();
          } catch (_error) {}
          if (processObj && typeof processObj.exit === 'function') processObj.exit(0);
        }, 10000);
        if (guard && typeof guard.unref === 'function') guard.unref();
      });
      return { interactive: false, done };
    }

    // 到这一步说明是真正的 TTY 动画：启用按时间轮换（一行只放一条分组 / 一条限流）。
    rotateLabels = true;

    if (processObj && processObj.stdin && typeof processObj.stdin.resume === 'function') {
      try { processObj.stdin.resume(); } catch (_error) {}
    }

    // 补算队列：一次只处理一个账号，算完自动出现在下一帧。
    // 有 worker 时按"上次算完"继续推进（主线程全程不阻塞）；没有 worker 才按固定
    // 节奏在主线程算，避免连续阻塞把动画按住。
    let cursor = 0;
    let disabled = false;
    let inflight = false;
    function nextStaleModel() {
      const list = accounts;
      if (list.length === 0) return null;
      for (let attempt = 0; attempt < list.length; attempt += 1) {
        const index = (cursor + attempt) % list.length;
        const model = list[index];
        if (model.goOnly || !isStale(model)) continue;
        cursor = (index + 1) % list.length;
        return model;
      }
      return null;
    }
    function pump() {
      if (disabled || inflight) return;
      const model = nextStaleModel();
      if (!model) return;
      if (!accountEnricher || typeof accountEnricher.request !== 'function') {
        enrichAccountInline(model);
        return;
      }
      inflight = true;
      accountEnricher.request([toTask(model)]).then((results) => {
        inflight = false;
        if (disabled) return;
        if (Array.isArray(results) && results.length > 0) {
          results.forEach((result) => applyEnrichment(result.provider, result.accountRef, result));
          setImmediate(pump);
          return;
        }
        // worker 不可用：这一个退回主线程算，列表照样能补全。
        enrichAccountInline(model);
        setTimeout(pump, ENRICH_TICK_MS);
      }, () => {
        inflight = false;
        if (disabled) return;
        enrichAccountInline(model);
        setTimeout(pump, ENRICH_TICK_MS);
      });
    }
    // 先把返回路径走完、让第一帧真正写出去，再开始补算。
    setImmediate(pump);
    const enrichTimer = setInterval(() => { pump(); }, ENRICH_TICK_MS);
    if (enrichTimer && typeof enrichTimer.unref === 'function') enrichTimer.unref();

    // 退出：把转圈定格成静态标记就走，不整屏清 —— 退出瞬间"闪一下"同样是体验事故。
    const finalize = () => {
      disabled = true;
      if (enrichTimer) clearInterval(enrichTimer);
      if (accountEnricher && typeof accountEnricher.close === 'function') accountEnricher.close();
      if (typeof animator.renderStatic === 'function') {
        try { animator.renderStatic(); } catch (_error) {}
      }
      if (typeof animator.stop === 'function') animator.stop();
      try { processObj.stdout.write('\n'); } catch (_error) {}
    };
    if (processObj && typeof processObj.on === 'function') {
      processObj.on('SIGINT', () => {
        finalize();
        processObj.exit(130);
      });
    }
    if (typeof animator.onQuit === 'function') {
      animator.onQuit(() => {
        finalize();
        if (processObj && typeof processObj.exit === 'function') processObj.exit(0);
      });
    }
    return { interactive: true, done: Promise.resolve() };
  }

  function countProfiles(filterProvider = null) {
    const providerFilter = normalizeProviderFilter(filterProvider);
    const goOnlyByProvider = readGoOnlyAccountRecords();
    let tools = Object.keys(cliConfigs)
      .filter((tool) => listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length > 0
        || (goOnlyByProvider.get(tool) || []).length > 0);

    if (providerFilter) {
      tools = tools.filter((tool) => providerFilter.has(tool));
    }

    const providers = {};
    let total = 0;
    tools.forEach((tool) => {
      // 计数与列表同口径：Node 别名表 + Go 独有账号（按 accountRef 去重）。
      const refs = new Set(listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true })
        .map((record) => record.accountRef));
      for (const goOnly of goOnlyByProvider.get(tool) || []) refs.add(goOnly.accountRef);
      const count = refs.size;
      providers[tool] = count;
      total += count;
    });

    return { total, providers };
  }

  return {
    showLsHelp,
    listProfiles,
    countProfiles
  };
}

module.exports = {
  ROTATE_STEP_MS,
  rotationTurn,
  filterListRows,
  createProfileListService
};
