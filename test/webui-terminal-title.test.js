'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWebUiTerminalTitle } = require('../lib/server/webui-terminal-title');

test('WebUI session title uses the CLI title source priority', () => {
  assert.equal(buildWebUiTerminalTitle({
    provider: 'codex', accountId: '7', model: 'gpt-5'
  }), 'Codex:7:gpt-5');
  assert.equal(buildWebUiTerminalTitle({
    provider: 'agy', accountId: 'acct_123', model: 'gemini-3'
  }), 'AGY:acct_123:gemini-3');
});

test('a real session label wins over the identity frame', () => {
  assert.equal(buildWebUiTerminalTitle({
    provider: 'codex', accountId: '7', model: 'gpt-5', sessionLabel: 'Deploy API'
  }), 'Deploy API');
});

test('title strategy has a safe fallback for shell sessions', () => {
  assert.equal(buildWebUiTerminalTitle({}), 'Web Terminal');
});
