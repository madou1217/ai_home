'use strict';

const { DEFAULT_STRATEGY, clientReady, parsePastedCode, createPromptResponder } = require('./base');
const { createNativeOauthStrategy } = require('./native-oauth');
const { createCodePasteStrategy } = require('./code-paste');
const { CODEX_STRATEGY } = require('./codex');
const { CLAUDE_STRATEGY } = require('./claude');
const { AGY_STRATEGY } = require('./agy');
const { GEMINI_STRATEGY } = require('./gemini');
const { ZCODE_STRATEGY } = require('./zcode');
const { OPENCODE_STRATEGY } = require('./opencode');

const STRATEGIES = Object.freeze({
  codex: CODEX_STRATEGY,
  claude: CLAUDE_STRATEGY,
  agy: AGY_STRATEGY,
  gemini: GEMINI_STRATEGY,
  zcode: ZCODE_STRATEGY,
  opencode: OPENCODE_STRATEGY
});

function resolveLoginStrategy(provider) {
  return STRATEGIES[String(provider || '').trim().toLowerCase()] || DEFAULT_STRATEGY;
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
  GEMINI_STRATEGY,
  ZCODE_STRATEGY,
  OPENCODE_STRATEGY
};
