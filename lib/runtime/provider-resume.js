'use strict';

/**
 * Provider resume 策略注册表（持久会话重启恢复的「怎么续接」唯一出处）。
 *
 * 背景：一个 aih 持久会话（tmux/psmux pane）重启后要「接着上一段对话」，每个 CLI
 * 的原生入口都不一样，而 aih 以前把它写成 `buildRestoreForwardArgs` 里的两个 if：
 * codex → `resume <threadId>`、claude → `--continue`，其余 provider 一律普通重启
 * （对话丢失）。本模块把「provider → 恢复参数」变成数据驱动的策略表，新增 provider
 * 只加一条声明，调用方（持久恢复引擎）不再认识任何 provider 名。
 *
 * 契约方向：provider 的 resume 能力属于**合同事实**，声明在 Go 合同
 * （core/providers/builtins.go 的 nativeBoundary.sessions.flags，经
 * `npm run providers:generate` 投影到 contracts/providers/manifest.json，Node 侧经
 * lib/provider-native-capability-registry.js 读取）。本表只负责「怎么拼参数」，
 * 并通过 declaredFlags 与合同对齐；test/provider-resume.test.js 守住两边不漂移。
 *
 * 精确续接 vs 近似续接（`exactIdentity`）：
 *   - exactIdentity=true：只有拿到**原生会话身份**才能恢复，猜不得（codex 的
 *     thread id 就是这样——按 cwd 猜会话等于接错对话，宁可判不可恢复）。
 *   - exactIdentity=false：没有身份时仍有一条**近似但安全**的退路（claude 的
 *     `--continue` = 同 cwd 最近一段对话），有身份则用精确入口。
 * 拿不到身份、也没有安全退路的 provider 一律**普通重启**（返回空参数），
 * 绝不猜测会话身份。
 */

const { getProviderNativeCapability } = require('../provider-native-capability-registry');
const { resolveCodexPersistentThreadId } = require('./codex-persistent-thread');
const { normalizeSessionId: normalizeClineSessionId, extractClineSessionId } = require('../sessions/cline-session-store');
const { FAMILY_PROVIDERS } = require('./codebuddy-family-layouts');

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeIdentity(value) {
  const text = String(value || '').trim();
  return text && !text.includes('\0') ? text : '';
}

// 每条策略：
//   id              策略标识（测试与日志用）
//   providers       适用 provider（含别名/家族成员）
//   declaredFlags   该策略实际下发的 CLI flag；必须 ⊆ 合同的 nativeBoundary.sessions.flags
//   exactIdentity   是否必须拿到原生会话身份（true 时无身份 → 判不可恢复）
//   contractDeclared 合同里是否已声明 sessions 边界（false = 合同尚未覆盖，见注释）
//   buildArgs       纯函数：({entry, nativeSessionId, deps}) => string[]
const RESUME_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'codex-thread',
    // aih codex fork [<id>]：codex 自己的 fork 子命令（无 id = 原生 picker；--last 分叉最近一段）。
    fork: Object.freeze({
      idArgs: (sessionId) => ['fork', sessionId],
      latestArgs: Object.freeze(['fork'])
    }),
    // aih codex resume [<id>]：codex 自己有 resume 子命令（无 id 时是原生 picker）。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['resume', sessionId],
      latestArgs: Object.freeze(['resume'])
    }),
    providers: Object.freeze(['codex']),
    declaredFlags: Object.freeze(['resume']),
    exactIdentity: true,
    dedupeIdentity: true,
    identityLabel: 'thread',
    contractDeclared: true,
    // codex 只认精确 thread id（registry 绑定值或显式 resume 参数里的 UUID）。
    buildArgs: ({ entry }) => {
      const threadId = resolveCodexPersistentThreadId(entry || {});
      return threadId ? ['resume', threadId] : [];
    }
  }),
  Object.freeze({
    id: 'claude-session',
    // aih claude fork [<id>]：--resume <id> --fork-session / 无 id 时 --continue --fork-session。
    fork: Object.freeze({
      forkFlag: '--fork-session'
    }),
    // aih claude resume [<id>]：--resume <id>；无 id 时用 --continue（同 cwd 最近一段）。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--resume', sessionId],
      latestArgs: Object.freeze(['--continue'])
    }),
    providers: Object.freeze(['claude']),
    declaredFlags: Object.freeze(['--resume', '--continue']),
    exactIdentity: false,
    contractDeclared: true,
    // 有绑定的 session id → 精确恢复；否则同 cwd 最近一段对话（历史行为）。
    buildArgs: ({ nativeSessionId }) => (nativeSessionId ? ['--resume', nativeSessionId] : ['--continue'])
  }),
  Object.freeze({
    id: 'cline-session',
    // cline 没有 fork（--help 里没有），统一 fork 明确拒绝。
    fork: null,
    // aih cline resume <id>：只有 --id 一条路，没有「最近一段」的安全退路（无 id 时报错）。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--id', sessionId],
      latestArgs: Object.freeze([])
    }),
    providers: Object.freeze(['cline']),
    declaredFlags: Object.freeze(['--id']),
    exactIdentity: false,
    // 没有身份可以普通重启（不 fail-closed），但**有**身份时它是精确的：一段对话只能
    // 由一个 pane 恢复，两个 pane 带着同一个 id 重启会互相覆盖同一份历史。
    dedupeIdentity: true,
    identityLabel: 'session',
    contractDeclared: true,
    // `cline --id <session-id>`：会话身份来自 <CLINE_DATA_DIR>/db/sessions.db
    // （见 lib/sessions/cline-session-store.js）。没有身份就普通重启——cline 没有
    // `--continue` 这类「同 cwd 最近一段」的安全退路。身份也可以从 forwardArgs 里
    // 认出来：恢复后的 pane 会把 `--id <id>` 记进注册表，于是跨重启一路带下去。
    buildArgs: ({ entry, nativeSessionId }) => {
      const sessionId = normalizeClineSessionId(nativeSessionId)
        || extractClineSessionId(entry && entry.forwardArgs);
      return sessionId ? ['--id', sessionId] : [];
    }
  }),
  Object.freeze({
    id: 'gemini-session-file',
    // gemini 没有 fork。
    fork: null,
    // aih gemini resume [<id|latest>]：--resume 接受 index / latest（同 cwd 有效）。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--resume', sessionId],
      latestArgs: Object.freeze(['--resume', 'latest'])
    }),
    providers: Object.freeze(['gemini']),
    declaredFlags: Object.freeze(['--session-file']),
    exactIdentity: false,
    contractDeclared: true,
    // gemini 的 `--resume <index>` 按 cwd → projectHash 发现会话，跨重启不可靠
    // （WebUI 聊天路径已实测必报 "No previous sessions found for this project"）。
    // 因此只在**能解析到会话文件绝对路径**时用 `--session-file`，否则普通重启。
    buildArgs: ({ nativeSessionId, deps }) => {
      if (!nativeSessionId || typeof deps.resolveSessionFile !== 'function') return [];
      let sessionFile = '';
      try {
        sessionFile = normalizeIdentity(deps.resolveSessionFile(nativeSessionId));
      } catch (_error) {
        sessionFile = '';
      }
      return sessionFile ? ['--session-file', sessionFile] : [];
    }
  }),
  Object.freeze({
    id: 'agy-conversation',
    // agy 没有 fork。
    fork: null,
    // aih agy resume [<id>]：--conversation <id>；无 id 时 --continue。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--conversation', sessionId],
      latestArgs: Object.freeze(['--continue'])
    }),
    providers: Object.freeze(['agy']),
    declaredFlags: Object.freeze(['--conversation']),
    exactIdentity: false,
    contractDeclared: true,
    buildArgs: ({ nativeSessionId }) => (nativeSessionId ? ['--conversation', nativeSessionId] : [])
  }),
  Object.freeze({
    id: 'grok-session',
    // aih grok fork [<id>]：--resume <id> --fork-session / --continue --fork-session。
    fork: Object.freeze({
      forkFlag: '--fork-session'
    }),
    // aih grok resume [<id>]：--resume <id>；无 id 时 --continue（同 cwd 最近一段）。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--resume', sessionId],
      latestArgs: Object.freeze(['--continue'])
    }),
    providers: Object.freeze(['grok']),
    declaredFlags: Object.freeze(['--resume']),
    exactIdentity: false,
    contractDeclared: true,
    buildArgs: ({ nativeSessionId }) => (nativeSessionId ? ['--resume', nativeSessionId] : [])
  }),
  Object.freeze({
    id: 'opencode-session',
    // aih opencode fork [<id>]：--session <id> --fork / --continue --fork。
    fork: Object.freeze({
      forkFlag: '--fork'
    }),
    // aih opencode resume [<id>]：--session <id>；无 id 时 --continue（last session）。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--session', sessionId],
      latestArgs: Object.freeze(['--continue'])
    }),
    providers: Object.freeze(['opencode']),
    declaredFlags: Object.freeze(['--session']),
    exactIdentity: false,
    contractDeclared: true,
    // `opencode run --help` 实测：`-c/--continue`（最近一段）、`-s/--session <id>`。
    buildArgs: ({ nativeSessionId }) => (nativeSessionId ? ['--session', nativeSessionId] : [])
  }),
  Object.freeze({
    id: 'qoder-session',
    // aih qoder fork [<id>]：--resume <id> --fork-session / --continue --fork-session。
    fork: Object.freeze({
      forkFlag: '--fork-session'
    }),
    providers: Object.freeze(['qoder', 'qodercn']),
    declaredFlags: Object.freeze(['--continue', '--resume']),
    exactIdentity: false,
    identityLabel: 'session',
    contractDeclared: true,
    // qodercli / qoderclicn 1.1.72 `--help` 实测：`-c/--continue` 续最近一段、`-r/--resume [id]` 按 id 续。
    // aih 不读它的会话库：没有身份走 --continue（同 cwd 的近似但安全退路），有身份走 --resume（精确）。
    buildArgs: ({ nativeSessionId }) => (nativeSessionId ? ['--resume', nativeSessionId] : ['--continue']),
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--resume', sessionId],
      latestArgs: Object.freeze(['--continue'])
    })
  }),
  Object.freeze({
    id: 'codebuddy-family-resume',
    // aih codebuddy fork [<id>]：--resume <id> --fork-session / --continue --fork-session。
    fork: Object.freeze({
      forkFlag: '--fork-session'
    }),
    // aih codebuddy resume [<id>]：家族四支都是 --resume <id> / --continue。
    interactive: Object.freeze({
      idArgs: (sessionId) => ['--resume', sessionId],
      latestArgs: Object.freeze(['--continue'])
    }),
    providers: Object.freeze(FAMILY_PROVIDERS),
    declaredFlags: Object.freeze(['--resume']),
    exactIdentity: false,
    contractDeclared: true,
    // 家族四支的 `-r/--resume <sessionId>` 已在 WebUI 聊天路径实测可用。
    buildArgs: ({ nativeSessionId }) => (nativeSessionId ? ['--resume', nativeSessionId] : [])
  })
]);

const ALL_RESUME_STRATEGIES = RESUME_STRATEGIES;

// 合同声明了 sessions 边界、但**没有**非交互 resume 标准可用的 provider：
// kimi / kiro 的会话入口是 TUI 内的 slash 命令（`-c`、`/rewind`、`/chat new`），
// 不是「带参数重启即恢复」。显式列在这里，避免将来有人以为它们被漏掉了。
const RESUME_STRATEGYLESS_PROVIDERS = Object.freeze(['kimi', 'kiro']);

function listResumeStrategies() {
  return ALL_RESUME_STRATEGIES.map((strategy) => ({ ...strategy, providers: Array.from(strategy.providers) }));
}

function resolveProviderResumeStrategy(provider) {
  const name = normalizeProvider(provider);
  if (!name) return null;
  return ALL_RESUME_STRATEGIES.find((strategy) => strategy.providers.includes(name)) || null;
}

// 该 provider 是否必须拿到精确原生身份才允许恢复（拿不到就判不可恢复）。
function providerRequiresExactResumeIdentity(provider) {
  const strategy = resolveProviderResumeStrategy(provider);
  return Boolean(strategy && strategy.exactIdentity);
}

// 该 provider 是否按原生身份去重（同一段对话只能由一个 pane 恢复）。
function providerDeduplicatesResumeIdentity(provider) {
  const strategy = resolveProviderResumeStrategy(provider);
  return Boolean(strategy && strategy.dedupeIdentity);
}

// 不可恢复原因的用词：codex 是 thread、cline 是 session，保持历史字符串不变。
function resolveResumeIdentityLabel(provider) {
  const strategy = resolveProviderResumeStrategy(provider);
  return String((strategy && strategy.identityLabel) || 'thread');
}

// 精确身份的**去重键**：同一段对话只能由一个持久会话恢复，否则两个 pane 会写同一份
// 会话历史（codex = thread id；cline = session id，可以从 forwardArgs 里认出来）。
function resolveResumeIdentityKey(provider, entry = {}) {
  if (!providerDeduplicatesResumeIdentity(provider)) return '';
  const name = normalizeProvider(provider);
  if (name === 'codex') return resolveCodexPersistentThreadId(entry || {});
  if (name === 'cline') {
    return normalizeClineSessionId(entry && entry.nativeSessionId)
      || extractClineSessionId(entry && entry.forwardArgs);
  }
  return normalizeIdentity(entry && entry.nativeSessionId);
}

/**
 * 构建「重启后如何续接」的 CLI 参数。空数组 = 普通重启（新会话）。
 *
 * @param {string} provider
 * @param {{nativeSessionId?: string, forwardArgs?: string[]}} entry 持久会话注册表条目
 * @param {{resolveSessionFile?: Function}} [deps] 可选注入（gemini 用）
 * @returns {string[]}
 */
function buildProviderResumeArgs(provider, entry = {}, deps = {}) {
  const strategy = resolveProviderResumeStrategy(provider);
  if (!strategy) return [];
  const nativeSessionId = normalizeIdentity(entry && entry.nativeSessionId);
  let args = [];
  try {
    args = strategy.buildArgs({ provider: normalizeProvider(provider), entry, nativeSessionId, deps }) || [];
  } catch (_error) {
    return [];
  }
  return (Array.isArray(args) ? args : []).map((value) => String(value));
}

/**
 * `aih <provider> fork [<id>] [额外原生参数...]`：从一段已有对话**分叉**出新会话
 * （原对话不动），翻译到各 CLI 的原生 fork 入口。
 * 同样不猜：没有 fork 能力的 provider（gemini / cline / agy）明确拒绝。
 */
function buildProviderForkVerbArgs(provider, { sessionId = '', extraArgs = [] } = {}) {
  const name = normalizeProvider(provider);
  const extra = (Array.isArray(extraArgs) ? extraArgs : []).map((value) => String(value));
  const strategy = resolveProviderResumeStrategy(name);
  if (!strategy || !strategy.fork || !strategy.interactive) {
    const reason = RESUME_STRATEGYLESS_PROVIDERS.includes(name) ? 'resume_in_tui_only' : 'fork_unsupported';
    return {
      ok: false,
      reason,
      message: reason === 'resume_in_tui_only'
        ? `${name} 没有「带参数重启即恢复」的入口，也没有 fork：会话切换在 TUI 内的 slash 命令里。`
        : `${name} 未声明会话分叉入口，aih 不猜参数；需要分叉请用原生命令（aih ${name} --help）。`
    };
  }
  const identity = normalizeVerbIdentity(sessionId);
  if (identity === null) {
    return { ok: false, reason: 'resume_identity_invalid', message: `会话身份不能包含空白或控制字符：${JSON.stringify(String(sessionId))}` };
  }
  // 子命令形态（codex 的 `fork [<id>]`：有 id 走 idArgs，无 id 走原生 picker）
  if (typeof strategy.fork.idArgs === 'function' && identity) {
    return { ok: true, args: [...strategy.fork.idArgs(identity), ...extra] };
  }
  if (Array.isArray(strategy.fork.latestArgs) && !identity) {
    return { ok: true, args: [...strategy.fork.latestArgs, ...extra] };
  }
  // 旗标形态：分叉总是伴随一次「续接」（精确 id 或最近一段）
  const forkFlag = String(strategy.fork.forkFlag || '').trim();
  if (!forkFlag) {
    return { ok: false, reason: 'fork_unsupported', message: `${name} 未声明会话分叉入口。` };
  }
  if (identity) return { ok: true, args: [...strategy.interactive.idArgs(identity), forkFlag, ...extra] };
  const latest = Array.isArray(strategy.interactive.latestArgs) ? strategy.interactive.latestArgs : [];
  if (!latest.length) {
    return {
      ok: false,
      reason: 'resume_identity_required',
      message: `${name} 只能按精确${resolveResumeIdentityLabel(name)}分叉（没有「最近一段」）：先 aih ${name} sessions 选一个，再 aih ${name} fork <id>。`
    };
  }
  return { ok: true, args: [...latest, forkFlag, ...extra] };
}

// 合同侧声明的 resume flag（nativeBoundary.sessions.flags）；没有声明返回 null，
// 便于测试区分「合同说没有」与「合同没写」。
function getDeclaredResumeFlags(provider) {
  const capability = getProviderNativeCapability(provider);
  const flags = capability && capability.sessions && capability.sessions.flags;
  return Array.isArray(flags) ? flags.map((flag) => String(flag)) : null;
}

function normalizeVerbIdentity(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  // 身份里出现空白/控制字符一律当非法：宁可报错，也不要拼出一个会打到别的会话的参数。
  return /[\s\0]/.test(text) ? null : text;
}

/**
 * `aih <provider> resume [<id>] [额外原生参数...]` 的统一入口：
 * 把「resume 动词」翻译成该 provider **原生**的续接参数（事实来自上面的策略表，
 * flag 必须 ⊆ 合同 nativeBoundary.sessions.flags，test/provider-resume.test.js 守着）。
 *
 * 返回 `{ ok: true, args }` 或 `{ ok: false, reason, message }`——**绝不猜**：
 * 没有会话边界的 provider（未声明）、只有 TUI 内入口的 provider（kimi/kiro）、
 * 以及「必须精确身份但没有 id」的 provider（cline）都会明确拒绝并给出可行做法。
 */
function buildProviderResumeVerbArgs(provider, { sessionId = '', extraArgs = [] } = {}) {
  const name = normalizeProvider(provider);
  const extra = (Array.isArray(extraArgs) ? extraArgs : []).map((value) => String(value));
  const strategy = resolveProviderResumeStrategy(name);
  if (!strategy || !strategy.interactive) {
    const inTui = RESUME_STRATEGYLESS_PROVIDERS.includes(name);
    return {
      ok: false,
      reason: inTui ? 'resume_in_tui_only' : 'resume_unsupported',
      message: inTui
        ? `${name} 没有「带参数重启即恢复」的入口：会话切换在 TUI 内的 slash 命令里（见 docs/providers/agent-cli-usage.md）。`
        : `${name} 未声明会话续接入口，aih 不猜参数；可直接用原生命令（aih ${name} --help 看它的参数）。`
    };
  }
  const identity = normalizeVerbIdentity(sessionId);
  if (identity === null) {
    return { ok: false, reason: 'resume_identity_invalid', message: `会话身份不能包含空白或控制字符：${JSON.stringify(String(sessionId))}` };
  }
  if (identity) {
    return { ok: true, args: [...strategy.interactive.idArgs(identity), ...extra] };
  }
  const latest = Array.isArray(strategy.interactive.latestArgs) ? strategy.interactive.latestArgs : [];
  if (!latest.length) {
    return {
      ok: false,
      reason: 'resume_identity_required',
      message: `${name} 只能按精确${resolveResumeIdentityLabel(name)}续接（它没有「最近一段」这种安全退路）：先 aih ${name} sessions 选一个，再 aih ${name} resume <id>。`
    };
  }
  return { ok: true, args: [...latest, ...extra] };
}

module.exports = {
  RESUME_STRATEGIES,
  RESUME_STRATEGYLESS_PROVIDERS,
  buildProviderForkVerbArgs,
  buildProviderResumeArgs,
  buildProviderResumeVerbArgs,
  getDeclaredResumeFlags,
  listResumeStrategies,
  providerDeduplicatesResumeIdentity,
  providerRequiresExactResumeIdentity,
  resolveProviderResumeStrategy,
  resolveResumeIdentityKey,
  resolveResumeIdentityLabel
};
