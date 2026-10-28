'use strict';

/**
 * 历史候选：把用户**自己敲过的 aih 命令**变成补全候选（fish 式的「用过就记得」）。
 *
 * 数据来源刻意是 shell 的**活历史**（zsh `$history` / bash `history` 内建），而不是
 * `$HISTFILE`：zsh 默认只在退出时落盘，读文件会漏掉当前会话刚敲的命令。
 * shell 片段把历史按行喂进来（stdin 或 `--history-file`），这里只做解析与排序。
 *
 * 解析边界：zsh 扩展格式 `: <ts>:<dur>;<cmd>`、bash 内建的 `  <n>  <cmd>` 序号前缀、
 * `HISTTIMEFORMAT` 的 `#<ts>` 独立行，以及多行命令的 `\` 续行都会归一成一行命令。
 */

const HISTORY_SCAN_LIMIT = 2000;

/** 把一行历史归一成命令文本；解析不出内容时返回空串。 */
function normalizeHistoryLine(line) {
  let text = String(line == null ? '' : line).replace(/\r$/, '');
  if (!text.trim()) return '';
  if (/^#\d+$/.test(text.trim())) return '';
  text = text.replace(/^:\s*\d+:\d+;/, '');
  text = text.replace(/^\s*\d+\s+/, '');
  return text.trim();
}

/**
 * 解析历史文本。
 * 续行规则：以未转义的 `\` 结尾的行与下一行拼接（zsh/bash 都用这个约定存多行命令）。
 */
function parseHistoryText(text) {
  const rawLines = String(text == null ? '' : text).split('\n');
  const lines = rawLines.slice(Math.max(0, rawLines.length - HISTORY_SCAN_LIMIT));
  const commands = [];
  let pending = '';
  for (const raw of lines) {
    const normalized = normalizeHistoryLine(raw);
    if (!normalized) {
      if (!pending) continue;
      commands.push(pending);
      pending = '';
      continue;
    }
    if (normalized.endsWith('\\')) {
      pending = `${pending}${normalized.slice(0, -1)}`;
      continue;
    }
    commands.push(`${pending}${normalized}`);
    pending = '';
  }
  if (pending) commands.push(pending);
  return commands;
}

/** 判断一条命令是不是 aih 调用，是则返回 `aih` 之后的原文（含空格）。 */
function extractAihSuffix(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  const match = text.match(/^(\S+)(\s+[\s\S]*)?$/);
  if (!match) return null;
  const head = match[1];
  const tail = match[2] || '';
  const base = head.split('/').pop();
  if (base !== 'aih') return null;
  if (!tail.trim()) return null;
  if (/^\s*$/.test(tail)) return null;
  return tail.replace(/^\s+/, '');
}

/**
 * 从命令列表里汇总 aih 历史候选。
 * 越靠后（越新）的命令排名越高；同一后缀只保留最新一次。
 */
function collectAihHistory(commands) {
  const entries = new Map();
  const list = Array.isArray(commands) ? commands : [];
  for (let index = 0; index < list.length; index += 1) {
    const suffix = extractAihSuffix(list[index]);
    if (!suffix) continue;
    const existing = entries.get(suffix);
    if (existing) {
      existing.count += 1;
      existing.lastIndex = index;
      continue;
    }
    entries.set(suffix, { suffix, count: 1, lastIndex: index });
  }
  return [...entries.values()];
}

/** 按当前已输入片段挑历史候选（前缀优先、其次最新、再次最常用）。 */
function rankHistoryCandidates(entries, options = {}) {
  const prefix = String(options.prefix || '').trim();
  const limit = Math.max(1, Number(options.limit) || 30);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => !prefix || entry.suffix.startsWith(prefix))
    .sort((left, right) => {
      if (left.lastIndex !== right.lastIndex) return right.lastIndex - left.lastIndex;
      return right.count - left.count;
    })
    .slice(0, limit);
}

/**
 * 位置感知的历史候选：把历史命令里**当前还没敲的那一段**作为候选。
 *
 * - `aih <TAB>`（prior 为空）：候选 = 整条后缀（`codex 1 -p hi`），像 fish 一样一键补全整行。
 * - `aih codex <TAB>`（prior = `codex`）：只在「历史里确实以 codex 开头」的后缀里取剩余部分
 *   （`ls`、`1 -p hi`），而不是把别家 provider 的命令塞进来。
 */
function listHistoryRemainders(entries, priorText, options = {}) {
  const prior = String(priorText || '').trim();
  const limit = Math.max(1, Number(options.limit) || 30);
  const remainders = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const suffix = String(entry && entry.suffix || '');
    if (!suffix) continue;
    if (prior) {
      if (!suffix.startsWith(prior)) continue;
      const rest = suffix.slice(prior.length);
      if (!rest.trim()) continue;
      if (!/^\s/.test(rest)) continue;
      const value = rest.trim();
      if (seen.has(value)) continue;
      seen.add(value);
      remainders.push({ value, count: Number(entry.count) || 1, lastIndex: Number(entry.lastIndex) || 0 });
      continue;
    }
    if (seen.has(suffix)) continue;
    seen.add(suffix);
    remainders.push({ value: suffix, count: Number(entry.count) || 1, lastIndex: Number(entry.lastIndex) || 0 });
  }
  return rankHistoryCandidates(remainders.map((entry) => ({ suffix: entry.value, count: entry.count, lastIndex: entry.lastIndex })), {
    prefix: options.prefix,
    limit
  });
}

module.exports = {
  HISTORY_SCAN_LIMIT,
  collectAihHistory,
  extractAihSuffix,
  listHistoryRemainders,
  normalizeHistoryLine,
  parseHistoryText,
  rankHistoryCandidates
};
