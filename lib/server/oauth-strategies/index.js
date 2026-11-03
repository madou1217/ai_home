'use strict';

const { DEFAULT_STRATEGY, clientReady, parsePastedCode, createPromptResponder } = require('./base');
const { createNativeOauthStrategy } = require('./native-oauth');
const { createCodePasteStrategy } = require('./code-paste');
const { CODEX_STRATEGY } = require('./codex');
const { CLAUDE_STRATEGY } = require('./claude');
const { AGY_STRATEGY, AGY_DIRECT_OAUTH_STRATEGY, AGY_STRATEGIES } = require('./agy');
const { GEMINI_STRATEGY } = require('./gemini');
const { CODEBUDDY_LOGIN_STRATEGY } = require('./codebuddy');
const { ZCODE_STRATEGIES } = require('./zcode');
const { OPENCODE_STRATEGY } = require('./opencode');

// 复合策略（zcode / agy）自带 resolve；单一策略必须包成 { default } —— 否则
// resolveLoginStrategy 取不到它（entry[''] || entry.default || DEFAULT_STRATEGY），
// 策略里的 handlePrompt 会变成死代码。gemini 的文件夹信任自动确认曾因此从未生效。
const STRATEGIES = Object.freeze({
  codex: CODEX_STRATEGY,
  claude: CLAUDE_STRATEGY,
  agy: AGY_STRATEGIES,
  gemini: Object.freeze({ default: GEMINI_STRATEGY }),
  // CodeBuddy Code 家族：登录工作目录的信任预置 + 信任框兜底（见 ./codebuddy.js）。
  codebuddy: Object.freeze({ default: CODEBUDDY_LOGIN_STRATEGY }),
  codebuddycn: Object.freeze({ default: CODEBUDDY_LOGIN_STRATEGY }),
  zcode: ZCODE_STRATEGIES,
  opencode: OPENCODE_STRATEGY
});

function resolveLoginStrategy(provider, strategy = '') {
  const entry = STRATEGIES[String(provider || '').trim().toLowerCase()];
  if (!entry) return DEFAULT_STRATEGY;
  if (entry.nativeOauth) return entry;
  const requested = String(strategy || '').trim();
  // 策略表可自带 resolve（复合策略名需要按维度分解，如 zcode 的 `<区域>:<流程>`）。
  if (typeof entry.resolve === 'function') return entry.resolve(requested) || entry.default || DEFAULT_STRATEGY;
  return entry[requested] || entry.default || DEFAULT_STRATEGY;
}

module.exports = {
  resolveLoginStrategy,
  clientReady,
  parsePastedCode,
  createPromptResponder,
  createNativeOauthStrategy,
  createCodePasteStrategy,
  DEFAULT_STRATEGY,
  CODEX_STRATEGY,
  CLAUDE_STRATEGY,
  AGY_STRATEGY,
  AGY_DIRECT_OAUTH_STRATEGY,
  GEMINI_STRATEGY,
  ZCODE_STRATEGIES,
  OPENCODE_STRATEGY
};
