'use strict';

// 会话身份（native session identity）——「这个正在跑的 CLI 属于哪一段对话」。
//
// 两个消费方，同一份事实：
//   1. 终端标题：会话名帧（没有真名字时也不能空着）
//   2. 会话内换号：换账号后要**续接同一段对话**，必须拿到原生会话身份
//
// 为什么需要独立模块：身份解析是唯一同时被「显示」和「切换」使用的 provider
// 知识。放在标题层会让换号依赖标题的渲染节奏；放在换号层又会让标题重复一遍
// 探测逻辑。这里只回答两个问题，不写终端、不碰 PTY：
//
//   resolve*()  → { sessionId, title, source }
//   buildContinuationArgs() → 该 provider 的续接参数
//
// 解析是**昂贵**的（codebuddy 冷启动全量扫描实测 ~0.8s），因此默认走后台子
// 进程：标题不能被一次 0.8s 的同步扫描卡住，换号也要先让屏幕保持响应。

const { buildProviderResumeArgs, buildProviderResumeVerbArgs, resolveProviderResumeStrategy } = require('../../../runtime/provider-resume');

// 与标题渲染侧（terminal-title/labels.js 的 60）同一个口径：会话名是标题的一段，
// 不是正文。
const SESSION_TITLE_MAX_LENGTH = 60;
const IDENTITY_PROBE_TIMEOUT_MS = 6000;
// 兜底：没有身份时只接受「最近半天内活动过」的会话，宁可留空也不贴错对话。
const FALLBACK_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// 会「吃掉一个值」的续接旗标：删除旧参数时必须连值一起删。
const VALUE_FLAGS = Object.freeze(new Set([
  '--resume', '-r', '--conversation', '--session', '-s', '--id', '--session-file'
]));

// 短旗标不在合同里（合同只声明长旗标），但用户可能从原生 CLI 直接带进来。
const EXTRA_RESUME_FLAGS = Object.freeze({
  claude: ['-r', '-c'],
  cline: ['-i'],
  gemini: ['-r'],
  agy: ['-c'],
  grok: ['-r', '-c'],
  zcode: ['-r', '-c'],
  opencode: ['-s', '-c'],
  qoder: ['-r', '-c'],
  qodercn: ['-r', '-c'],
  codebuddy: ['-r', '-c'],
  codebuddycn: ['-r', '-c'],
  workbuddy: ['-r', '-c'],
  workbuddycn: ['-r', '-c']
});

const NOISE_TITLE_PATTERNS = Object.freeze([
  /^caveat:/i,
  /^<local-command/i,
  /^<command-name>/i,
  /^warmup$/i,
  /^未命名会话$/,
  // 只写了 slash 命令的消息（`/clear`、`/compact`……）不是会话主题：这类标题
  // 在 codebuddy 的会话库里真实存在，显示出来只会让人以为会话没名字。
  /^\/(?:clear|compact|resume|help|exit|quit|status)$/i,
  // 生成中的状态词不是会话主题（CLI 会把「正在想」写成标题）。
  /^(?:thinking|running|working|esc to interrupt)[\s.…]*$/i
]);

// CLI 的标题带一个状态标记前缀（codebuddy / claude 用 ✳、生成中还会换成
// braille 转圈帧）。标记是状态，不是标题内容，展示前摘掉。
const TITLE_MARKER_PREFIX = /^[\u00b7\u2022\u2219\u2731-\u273f\u28ff\u2800-\u28ff*]\s*/;

// 子进程自己写的 OSC 0/1/2 标题（terminal title）。它比会话库更**新鲜**：
// 用户换话题时 CLI 会立刻改写，而会话库里的标题还是首条消息。
const OSC_TITLE_PATTERN = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function readText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeProvider(value) {
  return readText(value).toLowerCase();
}

// provider 有时把「项目目录」当会话标题写进会话库（codebuddy 的 session-meta 就是
// 这样：/Users/me/proj → "Users-me-proj"）。这不是用户写的主题，显示出来等于告诉
// 用户「这段会话叫项目名」——比留空还糟，直接当噪音丢掉，交给 #会话号 兜底。
function isProjectDerivedTitle(title, cwd) {
  const squash = (value) => String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const titleKey = squash(title);
  const cwdKey = squash(cwd);
  if (!titleKey || !cwdKey) return false;
  return titleKey === cwdKey;
}

// provider 侧标题常是「首条用户消息的原文」：CLI 的 slash 命令会写成
// <command-name>/goal</command-name><command-args>真正的需求</command-args>。
// 直接塞进标题栏既长又不可读，这里还原成用户真正写下的那句话。
function normalizeSessionTitle(value) {
  let text = readText(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  const commandArgs = text.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  if (commandArgs && readText(commandArgs[1])) {
    text = commandArgs[1];
  } else {
    const commandName = text.match(/<command-name>([\s\S]*?)<\/command-name>/i);
    if (commandName && readText(commandName[1])) text = commandName[1];
  }
  text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(TITLE_MARKER_PREFIX, '').trim();
  if (!text) return '';
  if (NOISE_TITLE_PATTERNS.some((pattern) => pattern.test(text))) return '';
  return text.slice(0, SESSION_TITLE_MAX_LENGTH);
}

// 从一段终端输出里取 OSC 标题（可能一次带好几条，取最后一条的调用方自己取）。
// 只认完整序列：跨 chunk 分片的由调用方保留尾部再拼一次。
function extractOscTitles(text) {
  const source = String(text == null ? '' : text);
  if (!source || source.indexOf('\x1b]') < 0) return [];
  const titles = [];
  OSC_TITLE_PATTERN.lastIndex = 0;
  let match = OSC_TITLE_PATTERN.exec(source);
  while (match) {
    const title = normalizeSessionTitle(match[1]);
    if (title) titles.push(title);
    match = OSC_TITLE_PATTERN.exec(source);
  }
  return titles;
}

// 标题里的「会话名」。三档，保证**非空**：
//   1. provider 侧的真标题（codex thread title / codebuddy 首条消息……）
//   2. 用户显式命名的会话（s-<label>）
//   3. 「项目名 · #会话号」——裸启动的会话没有 provider 标题，但留空在用户眼里
//      就是「标题坏了」（2026-11-03 用户报的「看不到 session-title」）。项目名给
//      上下文，会话号保证同项目的多个会话不撞车。
function formatSessionLabel(input = {}) {
  const title = normalizeSessionTitle(input.title);
  if (title) return title;
  const named = readText(input.named);
  if (named) return named;
  const project = readText(input.project);
  const shortId = readText(input.sessionId).replace(/[^0-9a-zA-Z]/g, '').slice(0, 6);
  if (!project) return shortId ? '#' + shortId : '';
  return shortId ? project + ' · #' + shortId : project;
}

// 命令行上是否已经带续接意图。覆盖三种形态：带 id 的旗标（--resume <id>）、
// 只写旗标的（--continue / -c）、codex 的 resume 子命令。换号时这类参数原样保留：
// 用户已经指明了要哪一段对话，自动身份不该把它顶掉。
function hasContinuationIntent(provider, args) {
  const flags = listResumeFlags(provider);
  return (Array.isArray(args) ? args : []).some((raw) => {
    const token = String(raw == null ? '' : raw).trim();
    if (!token) return false;
    if (flags.has(token)) return true;
    const equalIndex = token.indexOf('=');
    return equalIndex > 0 && flags.has(token.slice(0, equalIndex));
  });
}

// 该 provider 在命令行上「续接一段对话」的全部旗标形态（长旗标来自合同策略，
// 短旗标来自原生 CLI 习惯）。派发处不认识 provider 名。
function listResumeFlags(provider) {
  const name = normalizeProvider(provider);
  const flags = new Set();
  const strategy = resolveProviderResumeStrategy(name);
  if (strategy) {
    const interactive = strategy.interactive || {};
    const idArgs = typeof interactive.idArgs === 'function' ? interactive.idArgs('__id__') : [];
    if (Array.isArray(idArgs) && idArgs.length) flags.add(String(idArgs[0]));
    for (const token of Array.isArray(interactive.latestArgs) ? interactive.latestArgs : []) {
      if (String(token).startsWith('-')) flags.add(String(token));
    }
    // 注意：fork 旗标（--fork-session / --fork）**刻意不在**这个集合里。它不是
    // 身份，只是「别写回原对话」的修饰；留着它，换号后仍然是「续接同一段 + 分叉」，
    // 摘掉反而会让新账号写进原对话。
    for (const token of Array.isArray(strategy.declaredFlags) ? strategy.declaredFlags : []) {
      flags.add(String(token));
    }
  }
  for (const token of EXTRA_RESUME_FLAGS[name] || []) flags.add(token);
  return flags;
}

// 用户显式写下的续接身份（--resume <id> / --conversation <id> / resume <id>）。
// 这是最可信的一路：用户已经告诉我们是哪一段对话了。
function extractResumeSessionId(provider, args) {
  const name = normalizeProvider(provider);
  const list = (Array.isArray(args) ? args : []).map((value) => String(value));
  if (name === 'codex') {
    const index = list.findIndex((token) => token === 'resume' || token === '/resume' || token === 'fork');
    if (index >= 0) {
      for (let at = index + 1; at < list.length; at += 1) {
        const token = readText(list[at]);
        if (token && !token.startsWith('-')) return token;
      }
    }
    return '';
  }
  const flags = listResumeFlags(name);
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    const equalIndex = token.indexOf('=');
    if (equalIndex > 0) {
      const flag = token.slice(0, equalIndex);
      if (flags.has(flag) && VALUE_FLAGS.has(flag)) {
        const value = readText(token.slice(equalIndex + 1));
        if (value) return value;
      }
      continue;
    }
    if (!flags.has(token) || !VALUE_FLAGS.has(token)) continue;
    const value = readText(list[index + 1]);
    if (value && !value.startsWith('-')) return value;
  }
  return '';
}

// 换号时把「上一段的续接参数」整段摘掉：新账号要续的是同一段对话，但旗标值
// 必须由新解析出来的身份重新给，旧值留着会把新进程拉回旧账号的上下文。
function stripContinuationArgs(provider, args) {
  const name = normalizeProvider(provider);
  const list = (Array.isArray(args) ? args : []).map((value) => String(value));
  const flags = listResumeFlags(name);
  let index = 0;
  if (name === 'codex' && ['resume', 'fork', '/resume'].includes(readText(list[0]))) {
    index = 1;
    if (readText(list[1]) && !String(list[1]).startsWith('-')) index = 2;
  }
  const out = [];
  for (; index < list.length; index += 1) {
    const token = list[index];
    const equalIndex = token.indexOf('=');
    if (equalIndex > 0 && flags.has(token.slice(0, equalIndex))) continue;
    if (flags.has(token)) {
      if (VALUE_FLAGS.has(token)) {
        const next = readText(list[index + 1]);
        if (next && !next.startsWith('-')) index += 1;
      }
      continue;
    }
    out.push(token);
  }
  return out;
}

// 续接参数：有精确身份就用精确入口；没有身份时用 provider 自己的「最近一段」
// 退路（--continue 之类）。两者都没有 = 明确拒绝，绝不猜参数。
function buildContinuationArgs(provider, sessionId) {
  const name = normalizeProvider(provider);
  const id = readText(sessionId);
  if (id) {
    // 有身份就走 `aih <provider> resume <id>` 的同一条下发路径：那是用户在真机上
    // 每天用的入口，比任何「按 provider 特判」的拼参都可信。
    const exact = buildProviderResumeVerbArgs(name, { sessionId: id });
    if (exact && exact.ok && Array.isArray(exact.args) && exact.args.length > 0) {
      return { ok: true, exact: true, sessionId: id, args: exact.args };
    }
    // 会话库里的身份可能需要 provider 自己再翻译一次（gemini 的会话文件路径）。
    const restored = buildProviderResumeArgs(name, { nativeSessionId: id });
    if (Array.isArray(restored) && restored.length > 0) {
      return { ok: true, exact: true, sessionId: id, args: restored };
    }
  }
  const latest = buildProviderResumeVerbArgs(name, {});
  if (latest && latest.ok && Array.isArray(latest.args) && latest.args.length > 0) {
    return { ok: true, exact: false, sessionId: id, args: latest.args };
  }
  return {
    ok: false,
    exact: false,
    sessionId: id,
    reason: readText(latest && latest.reason) || 'resume_unsupported',
    message: readText(latest && latest.message)
      || (name + ' 没有可用的续接入口，换号会丢失当前对话。')
  };
}

// 换号时的转发参数决策（纯函数，便于单测）：
//   - 用户显式写了续接 → 原样保留（会话 id 与账号无关）
//   - 登录 / 没有在跑的 pty → 没有「当前对话」可续，不猜 --continue
//   - 其余 → 摘掉旧续接旗标，把新身份算出来的续接参数**前置**
// 返回的 continuation 只用于展示与身份写回（null = 没做续接决策）。
function planAccountSwitch(input = {}) {
  const provider = normalizeProvider(input.provider);
  const forwardArgs = (Array.isArray(input.forwardArgs) ? input.forwardArgs : []).map((value) => String(value));
  const explicitSessionId = extractResumeSessionId(provider, forwardArgs);
  const keepExplicit = hasContinuationIntent(provider, forwardArgs) || Boolean(explicitSessionId);
  if (keepExplicit) {
    return { keepExplicit: true, explicitSessionId, continuation: null, args: forwardArgs };
  }
  if (input.isLogin || input.hasRunningPty === false) {
    return { keepExplicit: false, explicitSessionId: '', continuation: null, args: stripContinuationArgs(provider, forwardArgs) };
  }
  const continuation = buildContinuationArgs(provider, input.sessionId);
  const base = stripContinuationArgs(provider, forwardArgs);
  return {
    keepExplicit: false,
    explicitSessionId: '',
    continuation,
    args: continuation.ok ? continuation.args.concat(base) : base
  };
}

// ── 身份探测（子进程）────────────────────────────────────────────────────────
// 子进程只做一件事：读会话库 → 输出 {sessionId,title}。它让主进程保持响应，
// 也把「冷启动全量扫描」的代价关在进程外。
function buildProbeScript() {
  return [
    "'use strict';",
    "const payload = JSON.parse(process.argv[1] || '{}');",
    'try {',
    '  const { readProjectsFromHostByProviders } = require(payload.sessionReaderPath);',
    '  const { resolveAgentSessionIds, normalizeProjectPath } = require(payload.resolverPath);',
    '  const provider = String(payload.provider || "").toLowerCase();',
    '  const cwd = String(payload.cwd || "");',
    '  const startedAt = Number(payload.startedAt) || Date.now();',
    '  const options = { hostHomeDir: payload.hostHomeDir, aiHomeDir: payload.aiHomeDir, platform: payload.platform };',
    '  const wanted = normalizeProjectPath(cwd);',
    '  let sessionId = "";',
    '  try {',
    '    const resolved = resolveAgentSessionIds(provider, [{ name: "", path: cwd, created: Math.floor(startedAt / 1000) }], options);',
    '    sessionId = String((resolved && resolved[0] && resolved[0].agentSessionId) || "").trim();',
    '  } catch (_error) {}',
    '  let title = "";',
    '  let projects = [];',
    '  try { projects = readProjectsFromHostByProviders([provider], options) || []; } catch (_error) { projects = []; }',
    '  const project = projects.find((item) => normalizeProjectPath(item && item.path) === wanted) || null;',
    '  const sessions = (project && Array.isArray(project.sessions)) ? project.sessions : [];',
    '  if (sessionId) {',
    '    const hit = sessions.find((item) => String(item && item.id || "") === sessionId);',
    '    title = String((hit && hit.title) || "").trim();',
    '  } else if (sessions.length > 0) {',
    '    const newest = sessions.slice().sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0))[0];',
    '    const updatedAt = Number(newest && newest.updatedAt) || 0;',
    '    if (newest && updatedAt > 0 && Date.now() - updatedAt <= Number(payload.fallbackMaxAgeMs || 0)) {',
    '      sessionId = String(newest.id || "").trim();',
    '      title = String(newest.title || "").trim();',
    '    }',
    '  }',
    '  process.stdout.write(JSON.stringify({ sessionId, title }));',
    '} catch (_error) {',
    '  process.stdout.write(JSON.stringify({ sessionId: "", title: "" }));',
    '}'
  ].join('\n');
}

function parseProbeOutput(stdout) {
  const text = readText(stdout);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      sessionId: readText(parsed.sessionId),
      title: normalizeSessionTitle(parsed.title),
      source: 'store'
    };
  } catch (_error) {
    return null;
  }
}

// 探测入口。依赖全部注入，测试可以给一个假的 execFile，不启动子进程。
function resolveSessionIdentityAsync(deps = {}) {
  const provider = normalizeProvider(deps.provider);
  const cwd = readText(deps.cwd);
  if (!provider || !cwd) return Promise.resolve(null);
  const execFile = deps.execFile || require('node:child_process').execFile;
  if (typeof execFile !== 'function') return Promise.resolve(null);
  const nodePath = readText(deps.execPath) || process.execPath;
  const payload = {
    provider,
    cwd,
    startedAt: Number(deps.startedAt) || Date.now(),
    hostHomeDir: readText(deps.hostHomeDir),
    aiHomeDir: readText(deps.aiHomeDir),
    platform: readText(deps.platform),
    sessionReaderPath: require.resolve('../../../sessions/session-reader'),
    resolverPath: require.resolve('../ai-cli/session-title-resolver'),
    fallbackMaxAgeMs: FALLBACK_SESSION_MAX_AGE_MS
  };
  const timeout = Math.max(500, Number(deps.timeoutMs) || IDENTITY_PROBE_TIMEOUT_MS);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      execFile(nodePath, ['-e', buildProbeScript(), JSON.stringify(payload)], {
        timeout,
        maxBuffer: 256 * 1024,
        windowsHide: true
      }, (error, stdout) => {
        if (error) {
          finish(null);
          return;
        }
        finish(parseProbeOutput(stdout));
      });
    } catch (_error) {
      finish(null);
    }
  });
}

// 组合根：缓存最近一次身份，供标题同步读取（标题每 4s 轮播一次，不能等 I/O）。
function createSessionIdentity(options = {}) {
  const provider = normalizeProvider(options.provider);
  const cwd = readText(options.cwd);
  const startedAt = Number(options.startedAt) || Date.now();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const getForwardArgs = typeof options.getForwardArgs === 'function' ? options.getForwardArgs : () => [];
  const getRegistrySessionId = typeof options.getRegistrySessionId === 'function' ? options.getRegistrySessionId : () => '';
  const getCorrelationSessionId = typeof options.getCorrelationSessionId === 'function' ? options.getCorrelationSessionId : () => '';

  let knownSessionId = '';
  let cachedTitle = '';
  let observedTitle = '';
  let cachedSessionId = '';
  // 注册表 / hook 这两路要读磁盘，不能每次标题重算都走一遍（标题每 4s 轮播一次）。
  // 这里把它们的结果**记忆化**：只有身份还没确定、或一次探测跑完时才重算。
  let fallbackSessionId = '';
  let fallbackComputed = false;
  let inFlight = null;
  let lastResolvedAt = 0;

  function computeFallbackSessionId() {
    const registered = readText(getRegistrySessionId());
    if (registered) return registered;
    const correlated = readText(getCorrelationSessionId());
    if (correlated) return correlated;
    return cachedSessionId;
  }

  // 已知身份优先级（从最可信到最远）：
  //   1. 换号后由我们写回的身份 —— 就是本进程刚续接的那一段
  //   2. 用户显式写的续接参数
  //   3. 持久会话注册表里绑定的原生身份
  //   4. provider hook 上报的会话 id（codex/claude/agy 等）
  //   5. 会话库匹配（后台探测，结果进 cachedSessionId）
  function peekSessionId() {
    if (knownSessionId) return knownSessionId;
    const explicit = extractResumeSessionId(provider, getForwardArgs());
    if (explicit) return explicit;
    if (!fallbackComputed) {
      fallbackSessionId = computeFallbackSessionId();
      fallbackComputed = true;
    }
    return fallbackSessionId;
  }

  function current() {
    return {
      sessionId: peekSessionId(),
      title: cachedTitle,
      source: cachedTitle ? 'cache' : ''
    };
  }

  // 标题帧的兜底名字：项目目录名。用户明确要求「标题里要看得见会话」，
  // 而裸启动的会话没有 provider 标题；项目名是唯一立刻可得的稳定事实。
  function projectLabel() {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
    return readText(base);
  }

  function label() {
    // 子进程自己写的标题最新鲜（换话题立刻变），优先于会话库里那份首条消息。
    const observed = normalizeSessionTitle(observedTitle);
    if (observed && !isProjectDerivedTitle(observed, cwd)) return observed;
    const title = normalizeSessionTitle(cachedTitle);
    if (title && isProjectDerivedTitle(title, cwd)) return '';
    return title;
  }

  // CLI 写进终端标题的那句话（OSC 0/2）。它是最贴近「用户现在在聊什么」的事实，
  // 但只在**变了**的时候才需要调用方刷新标题。
  function setObservedTitle(value) {
    const next = normalizeSessionTitle(value);
    if (!next) return false;
    if (next === observedTitle) return false;
    observedTitle = next;
    return true;
  }

  function setKnownSessionId(sessionId, title) {
    const id = readText(sessionId);
    if (id) knownSessionId = id;
    const nextTitle = normalizeSessionTitle(title);
    if (nextTitle) cachedTitle = nextTitle;
  }

  function shouldRefresh(minIntervalMs) {
    if (inFlight) return false;
    if (!lastResolvedAt) return true;
    return now() - lastResolvedAt >= Math.max(0, Number(minIntervalMs) || 0);
  }

  function resolve(resolveOptions = {}) {
    if (!resolveOptions.force && !shouldRefresh(resolveOptions.minIntervalMs)) {
      return inFlight || Promise.resolve(current());
    }
    lastResolvedAt = now();
    const pending = resolveSessionIdentityAsync({
      provider,
      cwd,
      startedAt,
      hostHomeDir: options.hostHomeDir,
      aiHomeDir: options.aiHomeDir,
      platform: options.platform,
      execPath: options.execPath,
      execFile: options.execFile,
      timeoutMs: options.timeoutMs
    }).then((result) => {
      inFlight = null;
      if (result) {
        if (result.sessionId) cachedSessionId = result.sessionId;
        if (result.title) cachedTitle = result.title;
      }
      // 探测跑完 → 重算一次磁盘那几路（注册表 / hook 可能在这期间才写入）。
      fallbackSessionId = computeFallbackSessionId();
      fallbackComputed = true;
      return current();
    }, () => {
      inFlight = null;
      fallbackSessionId = computeFallbackSessionId();
      fallbackComputed = true;
      return current();
    });
    inFlight = pending;
    return pending;
  }

  return {
    provider,
    cwd,
    startedAt,
    label,
    projectLabel,
    current,
    peekSessionId,
    setKnownSessionId,
    setObservedTitle,
    resolve,
    isResolving: () => Boolean(inFlight)
  };
}

module.exports = {
  FALLBACK_SESSION_MAX_AGE_MS,
  IDENTITY_PROBE_TIMEOUT_MS,
  SESSION_TITLE_MAX_LENGTH,
  buildContinuationArgs,
  buildProbeScript,
  createSessionIdentity,
  extractOscTitles,
  extractResumeSessionId,
  formatSessionLabel,
  hasContinuationIntent,
  listResumeFlags,
  normalizeSessionTitle,
  parseProbeOutput,
  planAccountSwitch,
  resolveSessionIdentityAsync,
  stripContinuationArgs
};
