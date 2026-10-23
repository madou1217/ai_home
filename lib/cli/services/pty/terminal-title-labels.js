'use strict';

// 终端标题的**内容来源**：会话名、账号标签（provider:账号序号:模型）、以及从子进程
// 输出里识别出的中断 / API 错误。
//
// 与 terminal-title-cycler.js 的分工：本模块只产出字符串，不碰终端；cycler 只负责
// 轮播与写 OSC 0。两者都不做 I/O 密集的解析——标题在每个循环节拍都要重算，任何
// sqlite / ps / lsof 级别的开销都会变成可见的卡顿。
//
// 「当前模型」的取值顺序（从零成本到有成本，命中即返回）：
//   1. 转发参数里的 `--model` / `-m`（用户显式指定的就是当前模型）
//   2. provider 配置里的当前模型（codex 的 config.toml）
//   3. 账号的默认模型（服务端已持久化的模型快照，纯 JSON 读）
// 三者都拿不到就省略模型段，只显示 `provider:账号序号`。

const { getProviderMeta } = require('../../../provider-catalog');

const MODEL_FLAG_NAMES = new Set(['--model', '-m']);
const MODEL_FLAG_PREFIXES = ['--model=', '-m='];
const MODEL_LABEL_MAX_LENGTH = 48;

// 中断 / 上游错误在原生 CLI 的屏幕上的稳定文案。只认「明确表示这一回合失败了」的
// 短语，避免把模型正文里恰好出现的 "error" 当成故障。
const INTERRUPT_PATTERNS = [
  { pattern: /\binterrupted by user\b/i, label: '已中断' },
  { pattern: /\boperation (?:was )?(?:cancelled|canceled)\b/i, label: '已取消' },
  { pattern: /\bturn (?:was )?aborted\b/i, label: '已中断' },
  { pattern: /^\s*⎿\s*Interrupted\b/im, label: '已中断' }
];

const API_ERROR_PATTERNS = [
  { pattern: /\bAPI Error:\s*([45]\d{2})\b/i, label: (m) => `API ${m[1]}` },
  { pattern: /\b(\d{3})\s+(?:rate.?limit|too many requests)\b/i, label: () => '限流 429' },
  { pattern: /\brate limit(?:ed)?\b/i, label: () => '限流' },
  { pattern: /\b(?:overloaded|service unavailable)\b/i, label: () => '上游不可用' },
  { pattern: /\b(?:connection|network) error\b/i, label: () => '网络错误' },
  { pattern: /\bcontext (?:window )?(?:exceeded|overflow)\b/i, label: () => '上下文超限' }
];

function sanitizeLabel(value, maxLength = MODEL_LABEL_MAX_LENGTH) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// 从转发参数里取用户显式指定的模型：`--model x`、`--model=x`、`-m x`、`-m=x`。
function readModelFromArgs(args) {
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '').trim();
    if (!token) continue;
    const prefix = MODEL_FLAG_PREFIXES.find((candidate) => token.startsWith(candidate));
    if (prefix) {
      const value = sanitizeLabel(token.slice(prefix.length));
      if (value) return value;
      continue;
    }
    if (MODEL_FLAG_NAMES.has(token)) {
      const value = sanitizeLabel(list[index + 1]);
      if (value && !value.startsWith('-')) return value;
    }
  }
  return '';
}

// `provider:账号序号:模型`，与用户看到的账号列表口径一致。模型未知时退化成
// `provider:账号序号`——宁缺一段，也不要写一个假模型名。
function buildAccountLabel(input = {}) {
  const provider = sanitizeLabel(input.provider, 24);
  const accountId = sanitizeLabel(input.cliAccountId, 24);
  const model = sanitizeLabel(input.model);
  if (!provider && !accountId) return model;
  const head = accountId ? `${provider}:${accountId}` : provider;
  return model ? `${head}:${model}` : head;
}

// tmux 会话名是机器名，直接放进标题既长又不可读。结构是确定性的
// （见 lib/runtime/persistent-session.js 的 deriveSessionName / deriveFreshSessionName）：
//   命名会话   s-<label>
//   项目会话   p-<project>-<hash6>
//   裸启动     p-<project>-<hash6>-<now36>[-<pid36>]
// 所以这里按「去掉 p- 前缀 + 末尾的机器段」还原出项目名，命名会话保留 label。
const HASH_SEGMENT = /-[a-z0-9]{6}$/i;
const MACHINE_TAIL_SEGMENT = /-[a-z0-9]{1,9}$/i;

function humanizeSessionName(value) {
  const raw = sanitizeLabel(value, 60);
  if (!raw) return '';
  if (raw.startsWith('s-')) return sanitizeLabel(raw.slice(2), 60);
  if (!raw.startsWith('p-')) return raw;

  let body = raw.slice(2);
  // 裸启动：now36 与（可选的）pid36 都只有小写字母数字，且总在 hash 之后。
  // 逐个剥，直到末尾是 6 位的项目哈希段。
  while (!HASH_SEGMENT.test(body)) {
    const stripped = body.replace(MACHINE_TAIL_SEGMENT, '');
    if (!stripped || stripped === body) break;
    body = stripped;
  }
  // 去掉项目哈希，留下项目名本身。
  const project = body.replace(HASH_SEGMENT, '');
  return sanitizeLabel(project, 60) || sanitizeLabel(body, 60) || raw;
}

// 会话名对用户可读的形态：优先 provider 侧的可读标题（如 codex thread title），
// 其次 tmux 会话名（降噪后），最后项目目录名。
function buildSessionLabel(input = {}) {
  const title = sanitizeLabel(input.sessionTitle, 60);
  if (title) return title;
  const sessionName = humanizeSessionName(input.sessionName);
  if (sessionName) return sessionName;
  return sanitizeLabel(input.projectName, 60);
}

// 标题里的 provider 段用可读名（Cline / Codex / ChatGPT），与账号页同源。
// 少数 provider 的 label 是产品线名而非 CLI 名（agy → "Antigravity"），这类在标题
// 里改用 short，避免 `Antigravity:3` 既占宽又和用户敲的命令对不上。
const PROVIDER_TITLE_LABEL_OVERRIDES = Object.freeze({
  agy: 'AGY'
});

function resolveProviderShortLabel(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (PROVIDER_TITLE_LABEL_OVERRIDES[id]) return PROVIDER_TITLE_LABEL_OVERRIDES[id];
  const meta = getProviderMeta(id);
  return sanitizeLabel(meta.label || meta.short || id, 24);
}

// 从一段子进程输出里识别中断 / API 错误。返回 `''` 表示没有可展示的故障。
// 顺序：中断优先于上游错误——用户按 Esc 之后屏幕上的错误多是中断的副作用。
function detectFailureLabel(text) {
  const plain = String(text == null ? '' : text);
  if (!plain.trim()) return '';
  for (const entry of INTERRUPT_PATTERNS) {
    if (entry.pattern.test(plain)) return entry.label;
  }
  for (const entry of API_ERROR_PATTERNS) {
    const match = plain.match(entry.pattern);
    if (match) return typeof entry.label === 'function' ? entry.label(match) : entry.label;
  }
  return '';
}

module.exports = {
  buildAccountLabel,
  buildSessionLabel,
  detectFailureLabel,
  readModelFromArgs,
  resolveProviderShortLabel,
  sanitizeLabel,
  MODEL_LABEL_MAX_LENGTH
};
