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
// 一行放不下所有用量分组 / 多个限流条目：按时间轮换显示，每次只出现一条。
// 每行有各自的相位（见 rotationTick），避免整屏同时跳变。
const ROTATE_INTERVAL_MS = 5000;

/** 行级轮换相位：同一个账号稳定落在某个时间片，错开不同行的切换时刻。 */
function rotationTick(key, nowMs = Date.now(), intervalMs = ROTATE_INTERVAL_MS) {
  const text = String(key || '');
  const interval = Number(intervalMs) > 0 ? Number(intervalMs) : ROTATE_INTERVAL_MS;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const phase = hash % interval;
  return Math.floor((Number(nowMs) + phase) / interval);
}

/**
 * 列表的 provider 作用域：null = 全量，否则是大小写归一后的名字集合。
 * 接受单个名字（旧调用）、数组（通配/--scope 解析结果）或 Set。
 */
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
  const rotateIntervalMs = Number(options.rotateIntervalMs) > 0
    ? Number(options.rotateIntervalMs)
    : ROTATE_INTERVAL_MS;

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
  - Keys in live mode: \x1b[32mq\x1b[0m / \x1b[32mEsc\x1b[0m = quit, \x1b[32mCtrl+C\x1b[0m = quit.
  - Non-interactive mode (pipe/redirect): show first ${listPageSize} and print omitted count.
  - Throttling is shown as a yellow badge, one entry at a time:
    \x1b[33m[限流: deepseek-v4.1-flash 至 14:29]\x1b[0m for a model-scoped cooldown (the
    account itself is still schedulable) or \x1b[33m[限流: 账号 至 12:30]\x1b[0m when the
    whole account is rate limited (same fact as WebUI's rate_limited). "受限"
    means the upstream refuses that model for another reason (e.g. plan tier).
  - Usage groups rotate as well: only one "[Remaining: ...]" entry is shown per
    line and it switches every few seconds (percent vs credits / per-window /
    per-model buckets), so nothing is hidden but the line stays readable.

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
  function resolveRowView(model) {
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
    return {
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
    const rotation = rotationTick(`${tool}:${model.accountRef}`, Date.now(), rotateIntervalMs);
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

  /**
   * 便宜的一遍：只读账号引用 + 账号索引，产出行模型和渲染闭包。
   * 重活一个都不做——这是"先出列表"的那一遍。
   */
  function buildAccountListRows(filterProvider = null, filterAccountId = null) {
    const providerFilter = normalizeProviderFilter(filterProvider);
    let tools = Object.keys(cliConfigs)
      .filter((tool) => listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length > 0);

    if (providerFilter) {
      tools = tools.filter((tool) => providerFilter.has(tool));
    }

    const outputRows = [];
    const rowMeta = [];
    const accounts = [];

    if (tools.length === 0) {
      outputRows.push(() => '  No profiles found.');
      rowMeta.push(null);
      return { outputRows, rowMeta, accounts };
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
    outputRows.push(() => '');
    rowMeta.push(null);
    outputRows.push(() => `\x1b[36m📦 AI Home Accounts Overview\x1b[0m${scopeLabel}`);
    rowMeta.push(null);
    outputRows.push(() => '');
    rowMeta.push(null);

    tools.forEach((tool) => {
      outputRows.push(() => `\x1b[33m▶ ${tool}\x1b[0m`);
      rowMeta.push(null);
      let indexedMap = new Map();
      try {
        const indexedStates = getAccountStateIndex().listStates(tool);
        indexedMap = new Map(indexedStates.map((row) => [row.accountRef, row]));
      } catch (_error) {
        indexedMap = new Map();
      }
      let records = listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true });
      if (filterAccountId && /^\d+$/.test(String(filterAccountId))) {
        records = records.filter((record) => record.cliAccountId === String(filterAccountId));
      }
      if (records.length === 0) {
        outputRows.push(() => '  (Empty)');
        rowMeta.push(null);
        return;
      }
      const seenAccounts = new Map();
      const defaultRef = readDefaultAccountRef(fs, aiHomeDir, tool);
      const mobileRef = tool === 'codex' ? readCodexMobileAccountRef() : '';

      records.forEach((record) => {
        const model = {
          provider: tool,
          accountRef: record.accountRef,
          id: record.cliAccountId,
          indexRow: indexedMap.get(record.accountRef) || null,
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
        outputRows.push((prefix) => formatAccountRow(model, prefix));
        rowMeta.push({ provider: tool, accountRef: model.accountRef });
      });
    });

    return { outputRows, rowMeta, accounts };
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
    return true;
  }

  /** 主线程兜底补算：worker 不可用（或没接 worker）时用，语义与 worker 侧完全一致。 */
  function enrichAccountInline(model) {
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
      return { interactive: false, done: enrichAllThenPrint(accounts, printAll) };
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
        if (!isStale(model)) continue;
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
    let tools = Object.keys(cliConfigs)
      .filter((tool) => listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length > 0);

    if (providerFilter) {
      tools = tools.filter((tool) => providerFilter.has(tool));
    }

    const providers = {};
    let total = 0;
    tools.forEach((tool) => {
      const count = listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length;
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
  ROTATE_INTERVAL_MS,
  rotationTick,
  createProfileListService
};
