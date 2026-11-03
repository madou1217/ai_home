'use strict';

/**
 * 补全用的两个「更贵一点」的候选来源，都**只在对应位置**才加载：
 * - 会话 id（`aih <cli> resume|fork <TAB>`）：读该 provider 自己的会话库（约 140ms）。
 * - server config 的选项（`aih server config set --<TAB>`）：读 `SERVER_CONFIG_FIELDS`
 *   这张唯一描述符表（约 50ms），因此 `aih server config set` 能补的选项永远和
 *   `aih server config list` / `--help` 同源，不会各写一份。
 *
 * 两者都 fail-soft：读不到就返回空列表（补全不该因为底层读失败而报错）。
 */

const SESSION_CANDIDATE_LIMIT = 10;
const ACCOUNT_SCOPED_SESSION_PROVIDERS = new Set(['cline', 'qoder', 'qodercn', 'kiro']);

// 会话候选要读原生会话库（实测 codebuddy 家族 300ms）。TAB 不能每次都付这个成本，
// 所以在 aiHome 下放一份很短的缓存：45 秒内重复按 TAB 直接命中。
// 只有**读**路径用它；真实列表/续聊永远读原库，不会被缓存影响。
const SESSION_CACHE_TTL_MS = 45 * 1000;
// 缓存多存一些（50），这样按标题片段过滤时也能命中较早的会话；展示仍按 limit 截断。
const SESSION_CACHE_DEPTH = 50;

function sessionCacheFile(aiHomeDir, key) {
  const home = String(aiHomeDir || '').trim();
  if (!home) return '';
  const safe = String(key || '').replace(/[^a-zA-Z0-9_.-]+/g, '_');
  return require('node:path').join(home, 'run', 'cache', 'complete', `sessions-${safe}.json`);
}

function readSessionCache(aiHomeDir, key) {
  const file = sessionCacheFile(aiHomeDir, key);
  if (!file) return null;
  try {
    const parsed = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.sessions)) return null;
    if (Date.now() - Number(parsed.at || 0) > SESSION_CACHE_TTL_MS) return null;
    return parsed.sessions;
  } catch (_error) {
    return null;
  }
}

/** 展示用的截断：没有过滤词时给 limit 条；有过滤词时在更深的结果集里找。 */
function selectSessionCandidates(sessions, current, limit) {
  const needle = String(current || '').trim().toLowerCase();
  if (!needle) return sessions.slice(0, limit);
  const matched = sessions.filter((session) => String(session.id || '').toLowerCase().includes(needle)
    || String(session.title || '').toLowerCase().includes(needle));
  return matched.slice(0, Math.max(limit, 20));
}

function writeSessionCache(aiHomeDir, key, sessions) {
  const file = sessionCacheFile(aiHomeDir, key);
  if (!file) return;
  try {
    const fsImpl = require('node:fs');
    fsImpl.mkdirSync(require('node:path').dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, JSON.stringify({ at: Date.now(), sessions }), 'utf8');
  } catch (_error) { /* 缓存写不进去不影响补全 */ }
}

/** `aih <cli> resume|fork <TAB>` 的候选：该 provider 的会话 id（带标题与时间）。 */
function listProviderSessions(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const limit = Math.max(1, Number(options.limit) || SESSION_CANDIDATE_LIMIT);
  if (!id) return [];
  let cacheHome = String(options.aiHomeDir || '').trim();
  if (!cacheHome) {
    try { cacheHome = require('../../runtime/aih-home').resolveAiHomeDir({ env: options.env || process.env }); } catch (_error) { cacheHome = ''; }
  }
  const cacheKey = id + '__' + String(options.accountRef || '').trim();
  const cached = readSessionCache(cacheHome, cacheKey);
  if (cached && cached.length) return selectSessionCandidates(cached, options.current, limit);
  try {
    const { readProjectsFromHostByProviders } = require('../../sessions/session-reader');
    const { resolveAiHomeDir } = require('../../runtime/aih-home');
    const { resolveHostHomeDir } = require('../../runtime/host-home');
    // aiHomeDir/hostHomeDir 必须显式给出：账号投影型 provider（cline/kiro/qoder/grok）
    // 的读取器要靠它们定位「每个账号的存储」与宿主共享目录。
    const env = options.env || process.env;
    const readerOptions = {
      aiHomeDir: options.aiHomeDir || resolveAiHomeDir({ env }),
      hostHomeDir: options.hostHomeDir || resolveHostHomeDir({ env }),
      ...(options.readerOptions || {})
    };
    const projects = readProjectsFromHostByProviders([id], readerOptions) || [];
    const sessions = [];
    for (const project of projects) {
      for (const session of (project && project.sessions) || []) {
        const sessionId = String((session && session.id) || '').trim();
        if (!sessionId) continue;
        sessions.push({
          id: sessionId,
          title: String((session && (session.title || session.summary)) || '').trim(),
          updatedAt: String((session && (session.updatedAt || session.lastActiveAt || session.createdAt)) || '').trim()
        });
      }
    }
    // aih 自己的持久会话（服务器侧 tmux/psmux 注册表）优先：用户正在用的那几段
    // 一定比"历史里最近"更可能是他要 resume 的。读不到就跳过（无账号上下文时）。
    const liveIds = new Set();
    const accountRef = String(options.accountRef || '').trim();
    if (accountRef) {
      try {
        const { listPersistentSessions } = require('../services/ai-cli/persistent-session-list');
        // 这个函数是给终端渲染用的：必须把它的输出压掉，否则 TAB 候选里会混进一张会话表。
        const silent = {
          consoleImpl: { log() {}, error() {}, warn() {} },
          processImpl: { ...process, stdout: { write() {}, isTTY: false }, isTTY: false }
        };
        const registry = listPersistentSessions(id, accountRef, silent);
        for (const row of (registry && registry.rows) || []) {
          if (row && row.agentSessionId) liveIds.add(String(row.agentSessionId));
        }
      } catch (_error) { /* 注册表不可用：只给历史 */ }
    }

    sessions.sort((left, right) => {
      const leftLive = liveIds.has(left.id) ? 1 : 0;
      const rightLive = liveIds.has(right.id) ? 1 : 0;
      if (leftLive !== rightLive) return rightLive - leftLive;
      return Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
        || right.updatedAt.localeCompare(left.updatedAt);
    });
    const annotated = sessions.map((session) => ({
      ...session,
      live: liveIds.has(session.id)
    }));
    writeSessionCache(cacheHome, cacheKey, annotated.slice(0, SESSION_CACHE_DEPTH));
    return selectSessionCandidates(annotated, options.current, limit);
  } catch (_error) {
    return [];
  }
}

/** `aih server config …` 的选项：来自唯一描述符表，说明取该字段的第一句。 */
function listServerConfigFlags(options = {}) {
  try {
    const { SERVER_CONFIG_FIELDS } = require('../../server/server-config-schema');
    const flags = [];
    const seen = new Set();
    for (const field of SERVER_CONFIG_FIELDS || []) {
      const summary = String((field && field.summary) || '').split('。')[0];
      for (const raw of String((field && field.flag) || '').split('|')) {
        const name = raw.trim().split(/\s+/)[0];
        if (!name || seen.has(name)) continue;
        seen.add(name);
        flags.push({ value: name, description: summary });
      }
    }
    return flags;
  } catch (_error) {
    return [];
  }
}

/**
 * `aih server config set --<flag> <TAB>` 的取值：枚举字段的 values 直接来自描述符表，
 * 布尔字段给 on/off（描述符里的旗标写法就是 `--open-network|--local-only`，不接受裸值）。
 */
function listServerConfigValues(flagName) {
  const name = String(flagName || '').trim();
  if (!name.startsWith('--')) return [];
  try {
    const { SERVER_CONFIG_FIELDS } = require('../../server/server-config-schema');
    for (const field of SERVER_CONFIG_FIELDS || []) {
      const names = String((field && field.flag) || '').split('|').map((part) => part.trim().split(/\s+/)[0]);
      if (!names.includes(name)) continue;
      if (Array.isArray(field.values) && field.values.length > 0) {
        return field.values.map((value) => ({ value: String(value), description: '允许的取值' }));
      }
      return [];
    }
    return [];
  } catch (_error) {
    return [];
  }
}

/**
 * \`aih resume <TAB>\`：跨 provider 的最近会话（选择器的候选）。
 * 与 aih resume 列表同源（同一段会话只出现一次），带缓存，避免 TAB 去扫全部 provider。
 */
function listResumeSessions(options = {}) {
  const limit = Math.max(1, Number(options.limit) || SESSION_CANDIDATE_LIMIT);
  let cacheHome = String(options.aiHomeDir || '').trim();
  if (!cacheHome) {
    try { cacheHome = require('../../runtime/aih-home').resolveAiHomeDir({ env: options.env || process.env }); } catch (_error) { cacheHome = ''; }
  }
  const cached = readSessionCache(cacheHome, 'resume__all');
  if (cached && cached.length) return selectSessionCandidates(cached, options.current, limit);
  try {
    const { readProjectsFromHostByProviders } = require('../../sessions/session-reader');
    const { resolveHostHomeDir } = require('../../runtime/host-home');
    const env = options.env || process.env;
    const projects = readProjectsFromHostByProviders(null, {
      aiHomeDir: cacheHome || require('../../runtime/aih-home').resolveAiHomeDir({ env }),
      hostHomeDir: options.hostHomeDir || resolveHostHomeDir({ env })
    }) || [];
    const collected = [];
    for (const project of projects) {
      for (const item of (project && project.sessions) || []) {
        const id = String((item && item.id) || '').trim();
        if (!id) continue;
        collected.push({
          id,
          title: String((item && (item.title || item.summary)) || '').trim(),
          updatedAt: Number((item && (item.updatedAt || item.lastActiveAt)) || 0) || 0,
          provider: String((project && project.provider) || '').trim(),
          projectPath: String((item && item.projectPath) || (project && project.path) || '').trim()
        });
      }
    }
    const byId = new Map();
    for (const item of collected) {
      const existing = byId.get(item.id);
      if (!existing || (!existing.title && item.title)) byId.set(item.id, item);
    }
    const list = Array.from(byId.values()).sort((left, right) => right.updatedAt - left.updatedAt);
    writeSessionCache(cacheHome, 'resume__all', list.slice(0, SESSION_CACHE_DEPTH));
    return selectSessionCandidates(list, options.current, limit);
  } catch (_error) {
    return [];
  }
}

/**
 * aih ss <TAB>：本机正在跑的持久会话名（tmux / psmux pane 名）。
 *
 * 采集函数本身是给终端渲染用的，这里必须把 stdout / console 全部压掉，
 * 否则 TAB 候选里会混进一张会话表（踩过一次）。
 */
function listPersistentSessionNames(options = {}) {
  // 实现见 persistent-candidates.js：读持久会话注册表（JSON），不逐 socket 问 tmux。
  try {
    return require('./persistent-candidates').listPersistentSessionNames(options);
  } catch (_error) {
    return [];
  }
}

/**
 * `--model` / `--model-alias` 的取值候选：本次会话「网关实际能路由」的模型名。
 *
 * 数据来自本地已有的两份缓存，**不发网络请求**（补全必须 100ms 内出结果）：
 *   1. Pi 的网关模型投影（model-projection-refresh 写的 run/harness/pi/<ref>/models.json，
 *      没钉账号时退回 pool 那份）；
 *   2. 别名表里的 alias 名与 target（用户自己配过的名字，往往正是要映射的目标）。
 *
 * 读不到就返回空列表——补全 fail-soft，不让底层读失败冒到 shell。
 */
// 模型候选：`--model <TAB>` 给「这个账号能真的跑起来的模型」，`--model-alias <TAB>`
// 给「可以拿来当目标的东西」（别名本身 + 别名目标 + 账号模型）。
//
// 数据源是 Go 账号库 aih.db 的 account_models（上游发现结果 + 人工覆盖），不是
// harness 的 pi pool —— 后者是网关侧给 pi 用的目录，和 provider 原生模型 id 不是一回事。
// 账号没有模型行时退到同 provider 其它账号的并集：新建/未刷新的账号不至于一条都补不出来。
const MODEL_CANDIDATE_LIMIT = 200;
// 别名模式多一类「钉 Provider / 账号」的完整写法；上限放宽到能装下所有账号×模型。
const MODEL_ALIAS_CANDIDATE_LIMIT = 800;

function readAccountModelRows(aiHomeDir, provider, deps = {}) {
  const providerId = String(provider || '').trim().toLowerCase();
  if (!providerId) return [];
  const fsImpl = deps.fs || require('node:fs');
  const file = require('node:path').join(aiHomeDir, 'aih.db');
  try {
    if (!fsImpl.existsSync(file)) return [];
  } catch (_error) {
    return [];
  }
  let DatabaseSync = deps.DatabaseSync;
  if (!DatabaseSync) {
    try {
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch (_error) {
      return [];
    }
  }
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA query_only = ON');
    return db.prepare(`
      SELECT m.account_ref AS accountRef, m.model_id AS modelId
        FROM account_models m
        JOIN accounts a ON a.account_ref = m.account_ref
       WHERE a.provider_id = ?
         AND (m.manual_policy = 'force_enable'
              OR (m.manual_policy = 'inherit' AND m.upstream_available = 1))
       ORDER BY m.model_id
    `).all(providerId).map((row) => ({
      accountRef: String(row.accountRef || ''),
      modelId: String(row.modelId || '')
    }));
  } catch (_error) {
    return [];
  } finally {
    try { if (db) db.close(); } catch (_error) { /* 关不掉也不影响候选 */ }
  }
}

/**
 * 服务端探测快照（app-state 的 `cache:webui-models-snapshot.json`）：`byProvider` 是
 * 「该 Provider 真正能路由的模型」，`byAccount` 是「该账号真正能路由的模型」。
 *
 * 为什么不用 aih.db 的 account_models：kiro / gemini 这类 Provider 的目录来自运行时探测，
 * Go 账号库里根本没有行（实测 kiro 5 个账号全为空），只有这份快照有货。
 * 直接读 app-state.db（~2ms）；**不要** require 服务端模块——起进程要 250ms+。
 */
function readModelSnapshot(aiHomeDir, deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const file = require('node:path').join(aiHomeDir, 'app-state.db');
  try {
    if (!fsImpl.existsSync(file)) return null;
  } catch (_error) {
    return null;
  }
  let DatabaseSync = deps.DatabaseSync;
  if (!DatabaseSync) {
    try {
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch (_error) {
      return null;
    }
  }
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA query_only = ON');
    const row = db.prepare('SELECT value FROM app_kv WHERE key = ?')
      .get('cache:webui-models-snapshot.json');
    if (!row || !row.value) return null;
    const parsed = JSON.parse(row.value);
    return {
      byProvider: parsed && parsed.byProvider && typeof parsed.byProvider === 'object' ? parsed.byProvider : {},
      byAccount: parsed && parsed.byAccount && typeof parsed.byAccount === 'object' ? parsed.byAccount : {}
    };
  } catch (_error) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_error) { /* 关不掉也不影响候选 */ }
  }
}

/**
 * 账号候选（provider + 用户可见的 CLI 编号 + accountRef）。
 *
 * 唯一事实源是 app-state 的 `account_cli_aliases`：`aih <cli> ls` 与 `--model-alias`
 * 的账号解析用的都是它，模型快照的 byAccount 也按这里的 accountRef 存。
 * **不要**用 aih.db 的 accounts：那是 Go 内部编号，删过账号后和用户看到的错位
 * （实测 kiro：Go 1..5、CLI 2..6），而且 codex 这类账号两边的 accountRef 根本不是同一个。
 */
function readCliAccountRows(aiHomeDir, deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const file = require('node:path').join(aiHomeDir, 'app-state.db');
  const out = [];
  try {
    if (!fsImpl.existsSync(file)) return out;
  } catch (_error) {
    return out;
  }
  let DatabaseSync = deps.DatabaseSync;
  if (!DatabaseSync) {
    try {
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch (_error) {
      return out;
    }
  }
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA query_only = ON');
    for (const row of db.prepare(`
      SELECT provider, cli_account_id AS cliAccountId, account_ref AS accountRef
        FROM account_cli_aliases
       ORDER BY provider, CAST(cli_account_id AS INTEGER)
    `).all()) {
      const provider = String(row.provider || '').trim().toLowerCase();
      const cliAccountId = String(row.cliAccountId || '').trim();
      const accountRef = String(row.accountRef || '').trim();
      if (provider && cliAccountId && accountRef) out.push({ provider, cliAccountId, accountRef });
    }
  } catch (_error) {
    return out;
  } finally {
    try { if (db) db.close(); } catch (_error) { /* 关不掉也不影响候选 */ }
  }
  return out;
}

function providerLabel(provider) {
  try {
    return String(require('../../provider-catalog').getProviderMenuLabel(provider) || '').trim() || provider;
  } catch (_error) {
    return provider;
  }
}

/**
 * 带命名空间的别名目标候选（`kiro.glm-5` / `kiro.2.glm-5`）。
 *
 * 只在用户已经在写命名空间（`current` 含点或是 Provider 名）时才给：否则直接 TAB 会把
 * 几百条 `provider.account.model` 全倒出来，把原本的模型列表淹掉。
 * 纯函数，测试直接喂快照即可。
 */
function buildScopedAliasCandidates(snapshot, accounts = []) {
  const out = [];
  const seen = new Set();
  const push = (value, description) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ value: text, description });
  };
  if (!snapshot || !snapshot.byProvider) return out;
  const modelsFor = (provider) => {
    const list = snapshot.byProvider[provider];
    return Array.isArray(list)
      ? list.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
  };
  for (const provider of Object.keys(snapshot.byProvider).sort()) {
    const label = providerLabel(provider);
    for (const model of modelsFor(provider)) {
      push(`${provider}.${model}`, `${label} · ${model}｜钉 Provider，账号由池子选`);
    }
  }
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const provider = String(account && account.provider || '').trim().toLowerCase();
    const cliAccountId = String(account && account.cliAccountId || '').trim();
    const accountRef = String(account && account.accountRef || '').trim();
    if (!provider || !cliAccountId || !accountRef) continue;
    const label = providerLabel(provider);
    const own = snapshot.byAccount && snapshot.byAccount[accountRef];
    const models = Array.isArray(own) && own.length
      ? own.map((id) => String(id || '').trim()).filter(Boolean)
      : modelsFor(provider);
    for (const model of models) {
      push(`${provider}.${cliAccountId}.${model}`, `${label} 账号 ${cliAccountId} · ${model}｜钉 Provider + 账号`);
    }
  }
  return out;
}

/** 用户是否已经在写命名空间（`kiro` / `kiro.` / `kiro.2.`）——见 buildScopedAliasCandidates。 */
function wantsScopedAliasTargets(current) {
  const text = String(current || '').trim();
  if (!text) return false;
  if (text.includes('.')) return true;
  try {
    return Boolean(require('../../provider-catalog').isKnownProvider(text.toLowerCase()));
  } catch (_error) {
    return false;
  }
}

function listScopedAliasCandidates(aiHomeDir, deps = {}) {
  const snapshot = readModelSnapshot(aiHomeDir, deps);
  if (!snapshot) return [];
  return buildScopedAliasCandidates(snapshot, readCliAccountRows(aiHomeDir, deps));
}

/**
 * 网关模型投影：`run/harness/pi/<账号>/models.json` 是网关 /v1/models 的本地快照
 * （model-projection-refresh 写的）。它比 account_models 覆盖面广——claude / gemini
 * 这类账号库里没有模型行的 provider 只有这里有货，且内容就是「网关真能路由到的模型」。
 * 账号维度的投影优先，其次 pool（= 全局池）。
 */
function readGatewayModelIds(fsImpl, aiHomeDir, keys) {
  const pathImpl = require('node:path');
  for (const key of keys) {
    if (!key) continue;
    const file = pathImpl.join(aiHomeDir, 'run', 'harness', 'pi', key, 'models.json');
    let parsed = null;
    try { parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (_error) { continue; }
    const list = parsed && parsed.providers && parsed.providers.aih && parsed.providers.aih.models;
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

function listModelCandidates(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return [];
  const mode = String(options.mode || 'model').trim().toLowerCase();
  const provider = String(options.provider || '').trim().toLowerCase();
  const accountRef = String(options.accountRef || '').trim();
  // 投影目录可能按 accountRef 命名，也可能按 CLI 编号命名（`run/harness/pi/41/`）。
  const accountToken = String(options.accountToken || '').trim();
  const seen = new Set();
  const models = [];
  const push = (id, description) => {
    const value = String(id || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    models.push({ value, description });
  };

  // 先别名：`--model-alias` 的第一意图是「挑一个别名」，排在原生模型前面。
  if (mode === 'alias') {
    try {
      const { loadAliasesSync } = require('../../server/model-alias-store');
      const loaded = loadAliasesSync(fsImpl, aiHomeDir, options.deps || {});
      for (const alias of (loaded && loaded.aliases) || []) {
        if (!alias || alias.enabled === false) continue;
        if (provider && alias.provider && alias.provider !== 'all' && alias.provider !== provider) continue;
        push(alias.alias, `别名 → ${alias.target || '?'}`);
      }
      for (const alias of (loaded && loaded.aliases) || []) {
        if (!alias || alias.enabled === false) continue;
        push(alias.target, '别名目标');
      }
    } catch (_error) { /* 读不到别名不影响模型候选 */ }
  }

  // 命名空间写法：`kiro.glm-5` / `kiro.2.glm-5`（`--model-alias` 专属）。
  // 只在用户已经打出命名空间时给，避免空 TAB 被几百条账号×模型淹没。
  if (mode === 'alias' && wantsScopedAliasTargets(options.current)) {
    for (const item of listScopedAliasCandidates(aiHomeDir, { fs: fsImpl, DatabaseSync: options.DatabaseSync })) {
      push(item.value, item.description);
    }
  }

  // 网关模型投影：账号维度（`--account` 命中的 ref 或编号）优先，其次全局 pool。
  // harness 没给 --provider 时（`aih harness pi --model <TAB>`）没有账号可查，
  // 正好落到 pool 那一份：那是 harness 真正能请求到的集合。
  const scopedKeys = [accountRef, accountToken];
  const scopedProjection = readGatewayModelIds(fsImpl, aiHomeDir, scopedKeys);
  const projected = scopedProjection.length ? scopedProjection : readGatewayModelIds(fsImpl, aiHomeDir, ['pool']);
  const projectedScope = scopedProjection.length ? '本账号' : '网关池';
  for (const entry of projected) push(entry && entry.id, `${projectedScope}模型`);

  // 账号库的 account_models（上游发现结果 + 人工覆盖）：比投影更「账号真实」，
  // 但只有部分 provider 有行，所以放在投影之后补齐。
  const rows = readAccountModelRows(aiHomeDir, provider, { fs: fsImpl, DatabaseSync: options.DatabaseSync });
  if (rows.length) {
    const scoped = accountRef ? rows.filter((row) => row.accountRef === accountRef) : [];
    const pool = scoped.length ? scoped : rows;
    const scopeLabel = scoped.length ? '本账号模型' : '同 provider 模型';
    for (const row of pool) push(row.modelId, scopeLabel);
  }

  return models.slice(0, mode === 'alias' ? MODEL_ALIAS_CANDIDATE_LIMIT : MODEL_CANDIDATE_LIMIT);
}

/**
 * `aih peer send <TAB>` 的候选：能收消息的会话（aih 持久会话 + claude 的本机会话）。
 *
 * 预算同样是 100ms：这里只读本地登记文件（注册表 / ~/.claude/sessions/*.json），
 * **不连 socket**（claude 的存活探测要 250ms/个）。真正的可达性由发送时再判。
 * 数据源跟 `aih peer list` 同源，只是跳过探测，所以补全出来的名字一定能对上。
 */
function listPeerCandidates(options = {}) {
  const env = options.env || process.env;
  const out = [];
  const seen = new Set();
  const push = (value, detail, provider, channel) => {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ value: name, detail, provider, channel });
  };

  try {
    const { resolvePeerHostHome, resolvePeerAiHomeDir, listClaudeConfigDirs } = require('../services/peer/scope');
    const hostHomeDir = options.hostHomeDir || resolvePeerHostHome(env);
    const aiHomeDir = String(options.aiHomeDir || '').trim() || resolvePeerAiHomeDir(env, hostHomeDir);

    for (const row of listPersistentSessionNames({ env, aiHomeDir, hostHomeDir, cwd: options.cwd })) {
      const detail = [row.provider, row.title, row.live ? '● 运行中' : ''].filter(Boolean).join(' · ');
      push(row.name, detail, row.provider || '', 'inject');
    }

    const claude = require('../services/peer/adapters/claude-uds');
    for (const peer of claude.listPeersSync({ env, configDirs: listClaudeConfigDirs(hostHomeDir, env) })) {
      const detail = ['claude', peer.status || '', peer.cwd || ''].filter(Boolean).join(' · ');
      push(peer.name || String(peer.pid), detail, 'claude', 'native');
    }
  } catch (_error) {
    return out;
  }
  return out;
}

/**
 * `aih peer read|reply <TAB>` 的候选：收件箱里的消息 id（前缀就是完整可用的 id）。
 *
 * 只读 `<aiHome>/run/peer/` 下的 JSON，不连任何通道；预算 100ms 足够。
 * 按时间倒序，最近的消息排前面——回复几乎总是针对刚收到的那条。
 */
function listPeerMessageCandidates(options = {}) {
  const env = options.env || process.env;
  try {
    const { resolvePeerHostHome, resolvePeerAiHomeDir } = require('../services/peer/scope');
    const { createPeerStore, shortMessageId } = require('../services/peer/store');
    const hostHomeDir = options.hostHomeDir || resolvePeerHostHome(env);
    const aiHomeDir = String(options.aiHomeDir || '').trim() || resolvePeerAiHomeDir(env, hostHomeDir);
    if (!aiHomeDir) return [];
    const store = createPeerStore({ aiHomeDir });
    return store.listMessages({ state: options.state || 'all', limit: options.limit || 50 })
      .slice()
      .reverse()
      .map((record) => {
        const from = String(record.from && record.from.name || '').trim() || '-';
        const body = String(record.body || '').replace(/\s+/g, ' ').slice(0, 40);
        return {
          value: shortMessageId(record.id),
          detail: `${record.state} · ${from} · ${body}`,
          state: record.state
        };
      });
  } catch (_error) {
    return [];
  }
}

module.exports = {
  ACCOUNT_SCOPED_SESSION_PROVIDERS,
  SESSION_CANDIDATE_LIMIT,
  buildScopedAliasCandidates,
  readCliAccountRows,
  wantsScopedAliasTargets,
  listProviderSessions,
  listResumeSessions,
  listPersistentSessionNames,
  listPeerCandidates,
  listPeerMessageCandidates,
  listServerConfigFlags,
  listServerConfigValues,
  listModelCandidates
};
