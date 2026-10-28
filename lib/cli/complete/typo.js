'use strict';

/**
 * 拼写纠正引擎：输入一个**打错的命令**，输出「最可能想运行的那条命令」。
 *
 * 与 thefuck 的差别（这是刻意的）：
 * - 只给候选，不自己执行：命令原文、确认提示、可编辑回退都由 shell 片段负责，
 *   用户永远先看到「将要运行什么」。
 * - 保留用户其余参数：`ahi codex 1 -p hi` 修的是第一个 token，后面的原样带过去。
 * - 会学习：用户确认过的纠正记在 `<aiHomeDir>/run/shell/corrections.json`，
 *   同一个错法下次直接排第一（reason=learned）。
 * - 只在「命令确实不存在」时才被调用（shell 的 command_not_found 钩子），
 *   绝不在命令存在时抢跑。
 */

const { rankHistoryCandidates } = require('./history');

/** 相邻字符换位按 1 次编辑计（Damerau / OSA 距离）。 */
function damerauLevenshtein(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = new Array(rows);
  for (let i = 0; i < rows; i += 1) {
    matrix[i] = new Array(cols).fill(0);
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, matrix[i - 2][j - 2] + 1);
      }
      matrix[i][j] = value;
    }
  }
  return matrix[rows - 1][cols - 1];
}

function isAdjacentTransposition(left, right) {
  if (left.length !== right.length || left === right) return false;
  const diff = [];
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) diff.push(i);
  }
  if (diff.length !== 2) return false;
  const [first, second] = diff;
  return second === first + 1 && left[first] === right[second] && left[second] === right[first];
}

function isSubsequence(input, candidate) {
  let index = 0;
  for (const char of candidate) {
    if (char === input[index]) index += 1;
    if (index === input.length) return true;
  }
  return input.length === 0;
}

/** 距离阈值：短名字更不容忍编辑（避免把 ls 纠成 lsof 之类的噪声）。 */
function allowedDistance(length) {
  return length <= 3 ? 1 : 2;
}

/**
 * 纠错的最小长度门槛。1~2 个字符的输入与 PATH 里的短命令距离普遍 ≤1，
 * 匹配结果全是噪声（实测：`n` 会建议 `[`、`w`、`ln`）——短命令打错就让它照常报
 * command not found，比给一堆无意义候选更好。
 */
const MIN_CORRECTION_LENGTH = 3;

/**
 * 给单个候选打分。返回 null 表示「不够像」。
 * reason 是给用户看的判据，不是内部枚举：它同时决定提示文案。
 */
function scoreCandidate(input, candidate) {
  const source = String(input || '');
  const target = String(candidate || '');
  if (!source || !target || source === target) return null;
  if (source.toLowerCase() === target.toLowerCase()) return { distance: 0, reason: 'case' };
  if (target.startsWith(source)) return { distance: target.length - source.length, reason: 'prefix' };
  const distance = damerauLevenshtein(source, target);
  if (distance === 0) return null;
  if (distance > allowedDistance(source.length)) return null;
  if (isAdjacentTransposition(source, target)) return { distance, reason: 'transposition' };
  if (distance === 1) return { distance, reason: 'typo' };
  if (source.length >= 5 && isSubsequence(source, target)) return { distance, reason: 'abbrev' };
  if (source.length >= 5) return { distance, reason: 'typo' };
  return null;
}

/**
 * 判据权重（越小越靠前）。
 * 关键取舍：**相邻换位与一位错打优先于「前缀更长」**——`gti` 更可能是 `git` 而不是 `gtimeout`，
 * `codx` 更可能是 `codex` 而不是 `code`；前缀匹配只在没有更近的候选时才上位。
 */
const REASON_WEIGHT = Object.freeze({
  learned: -100,
  case: 0,
  transposition: 1,
  typo: 2,
  abbrev: 3,
  prefix: 4
});

/**
 * 对候选集合排序。
 * candidates: [{ value, historyCount }]；learned: Map<typo, argv>（已确认的纠正）。
 */
function rankSuggestions(input, candidates, options = {}) {
  const learnedArgv = options.learned instanceof Map ? options.learned.get(String(input || '')) : null;
  const limit = Math.max(1, Number(options.limit) || 5);
  const priorityNames = new Set((options.priorityCommands || []).map((name) => String(name || '')));
  const scored = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const value = String((candidate && candidate.value) || candidate || '').trim();
    if (!value) continue;
    const match = scoreCandidate(input, value);
    if (!match) continue;
    scored.push({
      value,
      reason: match.reason,
      distance: match.distance,
      historyCount: Number((candidate && candidate.historyCount) || 0),
      // priority 用于「同等像度时，aih 自己的命令面优先于 PATH 里的同名近似项」。
      priority: priorityNames.has(value) ? 1 : 0,
      weight: REASON_WEIGHT[match.reason] === undefined ? 9 : REASON_WEIGHT[match.reason]
    });
  }
  scored.sort((left, right) => {
    if (left.weight !== right.weight) return left.weight - right.weight;
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.historyCount !== right.historyCount) return right.historyCount - left.historyCount;
    if (left.value.length !== right.value.length) return left.value.length - right.value.length;
    return left.value.localeCompare(right.value);
  });
  const unique = [];
  const seen = new Set();
  for (const entry of scored) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    unique.push(entry);
    if (unique.length >= limit) break;
  }
  if (learnedArgv && Array.isArray(learnedArgv) && learnedArgv.length > 0) {
    unique.unshift({
      value: learnedArgv.join(' '),
      reason: 'learned',
      distance: 0,
      historyCount: 0,
      weight: REASON_WEIGHT.learned,
      argv: learnedArgv.slice()
    });
  }
  return unique.slice(0, limit);
}

/**
 * 扫 PATH 里的可执行名（只读目录项，不做 stat：几百次 stat 会拖慢错误路径）。
 * 目的是「全局命令打错」的候选集合；最终是否真能执行由用户确认后交给 shell 判断。
 */
function listPathCommands(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || require('node:path');
  const env = options.env || process.env;
  const names = new Set();
  const dirs = String(env.PATH || '').split(pathImpl.delimiter).filter(Boolean);
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const name = String((entry && entry.name) || '');
      // 单字符条目（`[` 之类）不参与纠错候选：它们只会制造噪声。
      if (name.length < 2 || name.startsWith('.')) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      names.add(name);
    }
  }
  return [...names];
}

/**
 * 修正一条打错的命令。
 * 返回 [{ argv, value, reason }]：argv 是**完整命令词数组**（不含 shell 引号，可直接 exec）。
 */
function suggestCommand(tokens, options = {}) {
  const list = (Array.isArray(tokens) ? tokens : []).map((token) => String(token == null ? '' : token));
  if (!list.length) return [];
  const head = list[0];
  const rest = list.slice(1);
  if (head.length < MIN_CORRECTION_LENGTH) return [];
  const aihNames = Array.isArray(options.aihNames) ? options.aihNames : [];
  const historyEntries = Array.isArray(options.historyEntries) ? options.historyEntries : [];
  const limit = Math.max(1, Number(options.limit) || 5);
  const suggestions = [];
  const pushUnique = (argv, reason, value) => {
    const text = value || argv.join(' ');
    if (!text || suggestions.some((entry) => entry.value === text)) return;
    suggestions.push({ argv, value: text, reason });
  };

  // 1) `aih` 自己打错（ahi 之类）：默认只修第一个词、其余参数原样保留
  //    （`ahi codex 1` → `aih codex 1`）。只有在用户**没带任何参数**时，
  //    才用历史里真正跑过的整条命令作为候选——那才是「我本来想跑什么」的证据。
  if (aihNames.includes('aih')) {
    const aihMatch = scoreCandidate(head, 'aih');
    if (aihMatch) {
      // 用户确认过一次的纠正是最强证据，排在最前。
      const learnedArgv = options.learned instanceof Map ? options.learned.get(head) : null;
      if (Array.isArray(learnedArgv) && learnedArgv.length) {
        pushUnique(learnedArgv.map((token) => String(token)), 'learned');
      }
      pushUnique(['aih', ...rest], aihMatch.reason);
      if (!rest.length) {
        for (const entry of rankHistoryCandidates(historyEntries, { limit: 3 })) {
          const suffixTokens = entry.suffix.split(/\s+/).filter(Boolean);
          pushUnique(['aih', ...suffixTokens], 'history', `aih ${entry.suffix}`);
        }
      }
      return suggestions.slice(0, limit);
    }
  }

  // 2) 全局命令打错：候选来自 PATH + 历史里出现过的首词。
  const pathCommands = Array.isArray(options.pathCommands)
    ? options.pathCommands
    : listPathCommands(options);
  const historyCommands = historyEntries
    .map((entry) => ({ value: String(entry.suffix || '').split(/\s+/)[0] || '', historyCount: entry.count }))
    .filter((entry) => entry.value);
  const candidates = [
    ...pathCommands.map((value) => ({ value })),
    ...historyCommands
  ];
  for (const entry of rankSuggestions(head, candidates, {
    limit,
    learned: options.learned,
    priorityCommands: aihNames
  })) {
    if (entry.argv) {
      pushUnique(entry.argv, entry.reason, entry.value);
      continue;
    }
    pushUnique([entry.value, ...rest], entry.reason);
  }
  return suggestions.slice(0, limit);
}

/**
 * 命令名本身没错、但紧接着的那个词写错了（`aih codx`）：只改那一个词，其余原样保留。
 * 与 suggestCommand 的区别是「谁被怀疑」——这里第 0 个词可信，怀疑第 1 个词。
 */
function suggestInsideArgv(tokens, options = {}) {
  const list = (Array.isArray(tokens) ? tokens : []).map((token) => String(token == null ? '' : token));
  if (list.length < 2) return [];
  const head = list[0];
  const target = list[1];
  const rest = list.slice(2);
  if (target.length < MIN_CORRECTION_LENGTH) return [];
  const universe = (Array.isArray(options.universe) ? options.universe : [])
    .map((value) => String(value || ''))
    .filter(Boolean);
  // 第二个词本身合法就没什么可纠的：真正的错字在更后面（那是原生参数，aih 一律透传，不猜）。
  if (universe.includes(target)) return [];
  const limit = Math.max(1, Number(options.limit) || 5);
  const matches = rankSuggestions(target, universe.map((value) => ({ value })), {
    limit,
    priorityCommands: universe
  }).map((entry) => {
    const argv = [head, entry.value, ...rest];
    return { argv, value: argv.join(' '), reason: entry.reason, typo: target };
  });
  // 已确认过的纠正记的是**完整命令**（`__learn` 存的就是 shell 实际执行的那串），
  // 因此这里原样使用，不能再补一次 head（否则会变成 `aih aih shell`）。
  const learnedArgv = options.learned instanceof Map ? options.learned.get(target) : null;
  if (Array.isArray(learnedArgv) && learnedArgv.length) {
    const value = learnedArgv.join(' ');
    return [{ argv: learnedArgv.map((token) => String(token)), value, reason: 'learned', typo: target }]
      .concat(matches.filter((entry) => entry.value !== value))
      .slice(0, limit);
  }
  return matches;
}

module.exports = {
  MIN_CORRECTION_LENGTH,
  REASON_WEIGHT,
  allowedDistance,
  damerauLevenshtein,
  isAdjacentTransposition,
  isSubsequence,
  listPathCommands,
  rankSuggestions,
  scoreCandidate,
  suggestCommand,
  suggestInsideArgv
};
