'use strict';

// 终端标题的**内容来源**：会话名、账号标签（provider:账号序号:模型）、以及从子进程
// 输出里识别出的中断 / API 错误。
//
// 与 terminal-title.js 的分工：本模块只产出字符串，不碰终端；terminal-title 只负责
// 与 terminal-title.js 的分工：本模块只产出字符串，不碰终端；后者只负责写
// OSC 0。两者都不做 I/O 密集的解析——标题在每次状态变化时都要重算，任何
//
// 「当前模型」的取值顺序（从零成本到有成本，命中即返回）：
//   1. 转发参数里的 `--model` / `-m`（用户显式指定的就是当前模型）
//   2. provider 配置里的当前模型（codex 的 config.toml）
//   3. 账号的默认模型（服务端已持久化的模型快照，纯 JSON 读）
// 三者都拿不到就省略模型段，只显示 `provider:账号序号`。

const MODEL_FLAG_NAMES = new Set(['--model', '-m']);
const MODEL_FLAG_PREFIXES = ['--model=', '-m='];
const MODEL_LABEL_MAX_LENGTH = 48;

// 中断 / 上游错误在原生 CLI 屏幕上的稳定特征。这里只回答「这一回合是不是失败了」
// ——标题里不写具体文案（图标就够，见 terminal-title.js），所以模式只做识别。
const FAILURE_PATTERNS = [
  /\binterrupted by user\b/i,
  /\boperation (?:was )?(?:cancelled|canceled)\b/i,
  /\bturn (?:was )?aborted\b/i,
  /^\s*\u23bf\s*Interrupted\b/im,
  /\bAPI Error:\s*[45]\d{2}\b/i,
  /\b(?:\d{3}\s+)?(?:rate.?limit|too many requests)\b/i,
  /\b(?:overloaded|service unavailable)\b/i,
  /\b(?:connection|network) error\b/i,
  /\bcontext (?:window )?(?:exceeded|overflow)\b/i
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

function humanizeSessionName(value, options = {}) {
  const raw = sanitizeLabel(value, 60);
  if (!raw) return '';
  if (raw.startsWith('s-')) return sanitizeLabel(raw.slice(2), 60);
  // 非 `s-`/`p-` 的裸名字（例如 'default'）不是用户给会话起的名字，标题里不要。
  if (!raw.startsWith('p-')) return options.namedOnly ? '' : raw;
  if (options.namedOnly) return '';

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

// 会话段只在**有真名字**时出现：provider 侧的可读标题（codex thread title 之类），
// 或者用户显式命名的会话（`s-<label>`）。刻意不用「推导出来的项目目录名」——同一
// 项目的多个会话挂着同一个目录名，既占宽又区分不了谁是谁，账号段才是区分符。
function buildSessionLabel(input = {}) {
  const title = sanitizeLabel(input.sessionTitle, 60);
  if (title) return title;
  return humanizeSessionName(input.sessionName, { namedOnly: true });
}

// 标题里的 provider 段用**用户敲的那个 CLI 名**（`aih codex` → Codex），而不是
// 账号页的产品线名。账号页的 label 有时是订阅/产品线（codex → "ChatGPT"、
// agy → "Antigravity"），放进标题会让人对不上自己敲的命令。
//
// 规则：默认用 id 的首字母大写形式；下表只登记「用户更习惯别的写法」的例外。
const PROVIDER_TITLE_LABEL_OVERRIDES = Object.freeze({
  agy: 'AGY',
  opencode: 'OpenCode',
  qodercn: 'Qoder CN',
  codebuddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  workbuddycn: 'WorkBuddy CN',
  zcode: 'ZCode',
  qoder: 'Qoder'
});

function resolveProviderShortLabel(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (!id) return '';
  if (PROVIDER_TITLE_LABEL_OVERRIDES[id]) return PROVIDER_TITLE_LABEL_OVERRIDES[id];
  return sanitizeLabel(id.charAt(0).toUpperCase() + id.slice(1), 24);
}

// 从一段子进程输出里判断这一回合是否失败（中断 / 上游错误）。返回布尔：标题里
// 用图标表达状态，不需要具体文案。
function detectFailure(text) {
  const plain = String(text == null ? '' : text);
  if (!plain.trim()) return false;
  return FAILURE_PATTERNS.some((pattern) => pattern.test(plain));
}

module.exports = {
  buildAccountLabel,
  buildSessionLabel,
  detectFailure,
  readModelFromArgs,
  resolveProviderShortLabel,
  sanitizeLabel,
  MODEL_LABEL_MAX_LENGTH
};
