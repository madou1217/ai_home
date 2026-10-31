'use strict';

/**
 * `aih resume` —— 跨 provider 的**会话选择器**（不记得 id 也能续聊）。
 *
 * 和 `aih <cli> resume [id]` 的分工：
 *   - `aih <cli> resume <id>`：你已经知道是哪一段，直接续；
 *   - `aih resume [关键词]`：不知道，让 aih 列出来选。列表按"正在跑的会话 → 最近使用"
 *     排序，每行带 provider / 标题 / 相对时间，选中后调用 `aih <cli> resume <id>`。
 *
 * 为什么是"编号列表 + 读一行"而不是全屏 TUI：任何终端、任何 shell、SSH/CI 里都能用，
 * 也不需要接管 raw mode；输入编号、id 前缀、关键词都可以，直接回车取第一条。
 */

const nodePath = require('node:path');
const nodeFs = require('node:fs');

const DEFAULT_LIMIT = 20;

const HELP = [
  'aih resume — 跨 provider 选择一段会话并续聊',
  '',
  '用法：',
  '  aih resume                    列出最近会话（当前目录的项目排前面）',
  '  aih resume <关键词>           按标题 / id 片段过滤',
  '  aih resume --provider codex   只看某个 provider',
  '  aih resume --account 2        指定账号（默认账号可续聊任意会话）',
  '  aih resume --json             只输出候选，不启动（给脚本用）',
  '',
  '选择方式：输入编号 / id 前缀 / 关键词后回车；直接回车取第一条；q 退出。',
  ''
].join('\n');

function takeValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return { rest: argv, value: '' };
  return { rest: [...argv.slice(0, index), ...argv.slice(index + 2)], value: String(argv[index + 1] || '') };
}

function parseResumeArgs(argv = []) {
  let rest = (Array.isArray(argv) ? argv : []).map(String);
  const result = { provider: '', account: '', limit: DEFAULT_LIMIT, json: false, help: false, query: '' };

  const p = takeValue(rest, '--provider');
  rest = p.rest;
  const a = takeValue(rest, '--account');
  rest = a.rest;
  const l = takeValue(rest, '--limit');
  rest = l.rest;
  result.provider = p.value.trim().toLowerCase();
  result.account = a.value.trim();
  if (l.value && /^\d+$/.test(l.value.trim())) result.limit = Math.max(1, Number(l.value));

  for (const flag of ['--json', '--help', '-h', 'help']) {
    const index = rest.indexOf(flag);
    if (index >= 0) {
      rest = [...rest.slice(0, index), ...rest.slice(index + 1)];
      if (flag === '--json') result.json = true;
      else result.help = true;
    }
  }
  result.query = rest.join(' ').trim();
  return result;
}

/** 相对时间：`3 分钟前` / `2 小时前` / 日期。 */
function formatRelativeTime(value) {
  const ms = typeof value === 'number' ? value : Number(String(value || '').trim());
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 同一段会话在家族里会被多个 provider 看到（codebuddy / codebuddycn / workbuddy…）。
// 按会话 id 去重，保留"最能直接续聊"的那一支（有独立 CLI 的 provider 优先），
// 否则列表里同一段对话会出现四五次。
const PROVIDER_PRIORITY = Object.freeze(['codebuddy', 'codebuddycn', 'codex', 'claude', 'gemini', 'agy',
  'opencode', 'grok', 'kimi', 'kiro', 'cline', 'qoder', 'qodercn', 'zcode', 'workbuddy', 'workbuddycn']);

function providerPriority(provider) {
  const index = PROVIDER_PRIORITY.indexOf(String(provider || ''));
  return index >= 0 ? index : PROVIDER_PRIORITY.length;
}

function dedupeSessions(sessions) {
  const byId = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || !session.id) continue;
    const existing = byId.get(session.id);
    if (!existing || providerPriority(session.provider) < providerPriority(existing.provider)) {
      byId.set(session.id, session);
    }
  }
  return Array.from(byId.values()).sort((left, right) => right.updatedAt - left.updatedAt);
}

function normalizeSession(session, provider) {
  const id = String((session && session.id) || '').trim();
  if (!id) return null;
  const rawUpdated = session.updatedAt || session.lastActiveAt || session.createdAt || 0;
  const updatedAt = typeof rawUpdated === 'number' ? rawUpdated : Number(String(rawUpdated).trim()) || 0;
  return {
    id,
    provider,
    title: String((session && (session.title || session.summary)) || '').trim(),
    projectPath: String((session && (session.projectPath || session.cwd)) || '').trim(),
    updatedAt
  };
}

/**
 * 收集候选：只读宿主存储（会话本来就是产品级共享，不区分账号）。
 *
 * @returns {Array<{id:string, provider:string, title:string, projectPath:string, updatedAt:number}>}
 */
function collectResumeSessions(options = {}) {
  const providers = options.provider ? [options.provider] : null;
  try {
    const { readProjectsFromHostByProviders } = require('../../../sessions/session-reader');
    const { resolveAiHomeDir } = require('../../../runtime/aih-home');
    const { resolveHostHomeDir } = require('../../../runtime/host-home');
    const env = options.env || process.env;
    const list = options.providers || providers;
    const projects = readProjectsFromHostByProviders(list, {
      aiHomeDir: options.aiHomeDir || resolveAiHomeDir({ env }),
      hostHomeDir: options.hostHomeDir || resolveHostHomeDir({ env })
    }) || [];
    const collected = [];
    for (const project of projects) {
      for (const session of (project && project.sessions) || []) {
        const normalized = normalizeSession(session, String((project && project.provider) || '').trim());
        if (!normalized) continue;
        if (!normalized.projectPath) normalized.projectPath = String((project && project.path) || '');
        collected.push(normalized);
      }
    }
    return dedupeSessions(collected);
  } catch (_error) {
    return [];
  }
}

function filterSessions(sessions, query, limit, cwd = '') {
  const needle = String(query || '').trim().toLowerCase();
  let list = sessions;
  if (needle) {
    list = sessions.filter((session) => session.id.toLowerCase().includes(needle)
      || session.title.toLowerCase().includes(needle)
      || session.provider.toLowerCase().includes(needle));
  }
  // 当前目录的会话排前面（同一项目里续聊是最常见场景），其余按时间。
  if (cwd) {
    const normalizedCwd = String(cwd).replace(/\/+$/, '');
    list = [...list].sort((left, right) => {
      const leftHere = left.projectPath && left.projectPath.replace(/\/+$/, '') === normalizedCwd ? 1 : 0;
      const rightHere = right.projectPath && right.projectPath.replace(/\/+$/, '') === normalizedCwd ? 1 : 0;
      if (leftHere !== rightHere) return rightHere - leftHere;
      return right.updatedAt - left.updatedAt;
    });
  }
  return list.slice(0, limit);
}

function formatResumeList(sessions, cwd = '') {
  const lines = [];
  sessions.forEach((session, index) => {
    const here = cwd && session.projectPath && session.projectPath.replace(/\/+$/, '') === String(cwd).replace(/\/+$/, '');
    const marker = here ? '◆' : ' ';
    const when = formatRelativeTime(session.updatedAt);
    const title = session.title || '(无标题)';
    lines.push(`${String(index + 1).padStart(2, ' ')} ${marker} ${session.provider.padEnd(10)} ${title}${when ? `  · ${when}` : ''}`);
    lines.push(`     ${session.id}${session.projectPath ? `  ${session.projectPath}` : ''}`);
  });
  return lines.join('\n');
}

/** 把用户的输入解析成一个候选：编号 → id 前缀 → 空回车取第一条。 */
function pickSession(sessions, answer) {
  const text = String(answer || '').trim();
  if (!text) return sessions[0] || null;
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    return sessions[index] || null;
  }
  return sessions.find((session) => session.id === text)
    || sessions.find((session) => session.id.toLowerCase().startsWith(text.toLowerCase()))
    || sessions.find((session) => session.title.toLowerCase().includes(text.toLowerCase()))
    || null;
}

async function runResumeCommand(argv = [], context = {}) {
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const parsed = parseResumeArgs(argv);
  if (parsed.help) {
    stdout.write(HELP);
    return 0;
  }

  const sessions = filterSessions(
    collectResumeSessions({ provider: parsed.provider, aiHomeDir: context.aiHomeDir, hostHomeDir: context.hostHomeDir, env: context.env }),
    parsed.query,
    parsed.limit,
    context.cwd || process.cwd()
  );

  if (parsed.json) {
    stdout.write(`${JSON.stringify({ ok: true, sessions }, null, 2)}\n`);
    return sessions.length ? 0 : 0;
  }
  if (sessions.length === 0) {
    stderr.write('[aih] 没找到会话。试试 aih <cli> sessions --history 或 aih <cli> resume <id>\n');
    return 1;
  }

  stdout.write('\x1b[36m[aih]\x1b[0m 选择要续聊的会话（回车 = 第一条，q 退出）：\n\n');
  stdout.write(`${formatResumeList(sessions, context.cwd || process.cwd())}\n\n`);

  const ask = context.ask || (async (promptText) => {
    const readline = require('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: stdout });
    try {
      return await rl.question(promptText);
    } finally {
      rl.close();
    }
  });

  let answer = '';
  try {
    answer = await ask('> ');
  } catch (_error) {
    answer = '';
  }
  if (String(answer).trim().toLowerCase() === 'q') return 0;

  const picked = pickSession(sessions, answer);
  if (!picked) {
    stderr.write('[aih] 没有匹配的会话\n');
    return 1;
  }

  const launchArgs = [picked.provider, ...(parsed.account ? [parsed.account] : []), 'resume', picked.id];
  const spawnImpl = context.spawn || require('node:child_process').spawn;
  const binPath = nodePath.join(__dirname, '..', '..', '..', '..', 'bin', 'ai-home.js');
  stdout.write(`\x1b[36m[aih]\x1b[0m ${picked.provider} resume ${picked.id}\n`);
  return await new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [binPath, ...launchArgs], {
      stdio: 'inherit',
      env: context.env || process.env,
      cwd: context.cwd || process.cwd()
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(Number.isInteger(code) ? code : 0));
  });
}

module.exports = {
  DEFAULT_LIMIT,
  HELP,
  collectResumeSessions,
  dedupeSessions,
  filterSessions,
  formatRelativeTime,
  formatResumeList,
  parseResumeArgs,
  pickSession,
  runResumeCommand
};
