'use strict';

// MAX_TURN_INPUT_CHARS / MAX_INJECT_ITEM_CHARS 守的是 codex app-server 的**传输**
// 上限(字符数);它们对上游模型的**token 窗口**一无所知。两者必须分开守:
// 一个 80 万字符的中文文档能通过 95 万字符检查,却是约 80 万 token,照样被
// `input token count exceeds the maximum number of tokens allowed` 拒掉。
// 本模块是那道独立的 token 兜底闸:先按真实窗口算预算,超了就截断并如实披露,
// 绝不构造一个必然被上游拒绝的请求。

// 保守估算,不依赖具体 tokenizer:CJK 按 1 token/字符(上界),
// base64 长串按 3 字符/token(实测量级),其余文本按 4 字符/token。
// 估高不估低——宁可少装一点,也不要算出"装得下"然后被上游 400。
const CJK = /[一-鿿　-〿＀-￯]/g;
const BASE64_RUN = /base64,[A-Za-z0-9+/=]{256,}/g;

function estimateTextTokens(text) {
  const source = text === undefined || text === null ? '' : String(text);
  if (!source) return 0;
  const cjk = (source.match(CJK) || []).length;
  const base64 = (source.match(BASE64_RUN) || []).join('').length;
  const rest = Math.max(0, source.length - cjk - base64);
  return Math.round(cjk + base64 / 3 + rest / 4);
}

// 整轮输入只能占窗口的一部分:既有对话历史与本轮回答都要留地方。
const DEFAULT_BUDGET_PERCENT = 60;

function resolveBudgetTokens(contextWindow, percent) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return 0;
  const share = Number.isFinite(percent) && percent > 0 && percent <= 100
    ? percent : DEFAULT_BUDGET_PERCENT;
  return Math.floor(contextWindow * share / 100);
}

// 预算内尽量多装:整块装不下的先整块让位,最后一块按预算截头部留用。
// 截断一律留在块尾追加披露语,让模型知道自己看到的不是全文。
function applyDocumentTokenBudget(input = {}) {
  const blocks = Array.isArray(input.documentBlocks) ? input.documentBlocks : [];
  const budgetTokens = resolveBudgetTokens(input.contextWindow, input.percent);
  const fixedTokens = estimateTextTokens(input.content) + estimateTextTokens(input.videoBlock);
  const originalTokens = fixedTokens + blocks.reduce((sum, b) => sum + estimateTextTokens(b), 0);
  // 窗口未知时不猜:保持原样,由传输层上限兜着。
  if (budgetTokens <= 0 || originalTokens <= budgetTokens) {
    return { documentBlocks: blocks, truncatedBlocks: 0, droppedBlocks: 0,
      budgetTokens, originalTokens, appliedTokens: originalTokens };
  }
  let remaining = Math.max(0, budgetTokens - fixedTokens);
  const kept = [];
  let truncatedBlocks = 0;
  let droppedBlocks = 0;
  for (const block of blocks) {
    const tokens = estimateTextTokens(block);
    if (tokens <= remaining) { kept.push(block); remaining -= tokens; continue; }
    if (remaining <= 0) { droppedBlocks += 1; continue; }
    kept.push(truncateBlockToTokens(block, remaining, tokens));
    truncatedBlocks += 1;
    remaining = 0;
  }
  return { documentBlocks: kept, truncatedBlocks, droppedBlocks, budgetTokens, originalTokens,
    appliedTokens: fixedTokens + kept.reduce((sum, b) => sum + estimateTextTokens(b), 0) };
}

function truncateBlockToTokens(block, allowedTokens, blockTokens) {
  const text = String(block);
  // 按该块自己的 token 密度换算可保留字符数,再留一成安全边际。
  const ratio = Math.max(0, Math.min(1, allowedTokens / Math.max(1, blockTokens))) * 0.9;
  const keepChars = Math.max(0, Math.floor(text.length * ratio));
  const dropped = text.length - keepChars;
  return `${text.slice(0, keepChars)}\n（本附件超出本轮上下文预算,已装载前 ${keepChars} 字符,`
    + `其余 ${dropped} 字符未装载——请据此回答,不要假设你已看过全文。）`;
}

module.exports = {
  DEFAULT_BUDGET_PERCENT, applyDocumentTokenBudget, estimateTextTokens, resolveBudgetTokens
};
