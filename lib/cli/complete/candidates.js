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

module.exports = {
  ACCOUNT_SCOPED_SESSION_PROVIDERS,
  SESSION_CANDIDATE_LIMIT,
  listProviderSessions,
  listServerConfigFlags,
  listServerConfigValues
};
