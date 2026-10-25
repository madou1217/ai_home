'use strict';

const { DEFAULT_STRATEGY, clientReady, parsePastedCode, createPromptResponder } = require('./base');
const { createNativeOauthStrategy } = require('./native-oauth');
const { createCodePasteStrategy } = require('./code-paste');
const { CODEX_STRATEGY } = require('./codex');
const { CLAUDE_STRATEGY } = require('./claude');
const { AGY_STRATEGY, AGY_DIRECT_OAUTH_STRATEGY, AGY_STRATEGIES } = require('./agy');
const { GEMINI_STRATEGY } = require('./gemini');
const { ZCODE_STRATEGIES } = require('./zcode');
const { OPENCODE_STRATEGY } = require('./opencode');

const STRATEGIES = Object.freeze({
  codex: CODEX_STRATEGY,
  claude: CLAUDE_STRATEGY,
  agy: AGY_STRATEGIES,
  gemini: GEMINI_STRATEGY,
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
