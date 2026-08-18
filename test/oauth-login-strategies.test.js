'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveLoginStrategy,
  DEFAULT_STRATEGY,
  CODEX_STRATEGY,
  CLAUDE_STRATEGY,
  AGY_STRATEGY,
  GEMINI_STRATEGY,
  ZCODE_STRATEGY,
  OPENCODE_STRATEGY,
  createPromptResponder
} = require('../lib/server/oauth-login-strategies');

test('resolveLoginStrategy resolves registered strategies and falls back to default', () => {
  assert.equal(resolveLoginStrategy('codex'), CODEX_STRATEGY);
  assert.equal(resolveLoginStrategy('claude'), CLAUDE_STRATEGY);
  assert.equal(resolveLoginStrategy('agy'), AGY_STRATEGY);
  assert.equal(resolveLoginStrategy('gemini'), GEMINI_STRATEGY);
  assert.equal(resolveLoginStrategy('zcode'), ZCODE_STRATEGY);
  assert.equal(resolveLoginStrategy('opencode'), OPENCODE_STRATEGY);
  assert.equal(resolveLoginStrategy('unknown_provider'), DEFAULT_STRATEGY);
});

test('CODEX_STRATEGY injects --device-auth when authMode is oauth-device', () => {
  const browserArgs = CODEX_STRATEGY.buildLoginArgs({
    provider: 'codex',
    authMode: 'oauth-browser',
    baseArgs: ['auth', 'login']
  });
  assert.deepEqual(browserArgs, ['auth', 'login']);

  const deviceArgs = CODEX_STRATEGY.buildLoginArgs({
    provider: 'codex',
    authMode: 'oauth-device',
    baseArgs: ['auth', 'login']
  });
  assert.deepEqual(deviceArgs, ['auth', 'login', '--device-auth']);
});

test('OPENCODE_STRATEGY injects -p opencode for CLI login args', () => {
  const loginArgs = OPENCODE_STRATEGY.buildLoginArgs({
    provider: 'opencode',
    authMode: 'oauth-browser',
    baseArgs: ['auth', 'login']
  });
  assert.deepEqual(loginArgs, ['auth', 'login', '-p', 'opencode']);

  // If already present, does not duplicate
  const customArgs = OPENCODE_STRATEGY.buildLoginArgs({
    provider: 'opencode',
    authMode: 'oauth-browser',
    baseArgs: ['auth', 'login', '-p', 'zen']
  });
  assert.deepEqual(customArgs, ['auth', 'login', '-p', 'zen']);
});

test('OPENCODE_STRATEGY handlePrompt automatically writes return on Select provider prompt', () => {
  const writes = [];
  const logs = [];
  const job = {
    status: 'running',
    provider: 'opencode',
    logs: '┌  Add credential\n│\n◆  Select provider\n│  ● OpenCode Zen (recommended)',
    _ptyProcess: {
      write(chunk) {
        writes.push(chunk);
      }
    }
  };
  const deps = {
    stripAnsi: (str) => str,
    appendJobLog: (j, msg) => logs.push(msg),
    setAuthProgressState: () => {},
    states: {}
  };

  const handled = OPENCODE_STRATEGY.handlePrompt({ job, deps });
  assert.equal(handled, true);
  assert.deepEqual(writes, ['\r']);
  assert.equal(job._opencodeProviderSelected, true);
  assert.match(logs[0], /自动选择 OpenCode Zen/);

  // Idempotent: subsequent calls do nothing
  const secondHandled = OPENCODE_STRATEGY.handlePrompt({ job, deps });
  assert.equal(secondHandled, false);
  assert.deepEqual(writes, ['\r']);
});

test('AGY_STRATEGY handlePrompt auto-selects Google OAuth and reports initial progress state', () => {
  assert.equal(
    AGY_STRATEGY.getInitialAuthProgressState({ states: { AWAITING_LOGIN_METHOD: 'awaiting_login_method' } }),
    'awaiting_login_method'
  );

  const writes = [];
  const logs = [];
  let stateSet = '';
  const job = {
    status: 'running',
    provider: 'agy',
    logs: 'Select login method:\n> 1. Google OAuth\n2. Use a Google Cloud project',
    _ptyProcess: {
      write(chunk) {
        writes.push(chunk);
      }
    }
  };
  const deps = {
    stripAnsi: (str) => str,
    appendJobLog: (j, msg) => logs.push(msg),
    setAuthProgressState: (j, s) => { stateSet = s; },
    states: {
      AWAITING_LOGIN_METHOD: 'awaiting_login_method',
      LOGIN_METHOD_SELECTED: 'login_method_selected'
    }
  };

  const handled = AGY_STRATEGY.handlePrompt({ job, deps });
  assert.equal(handled, true);
  assert.deepEqual(writes, ['1\r']);
  assert.equal(job._agyGoogleOAuthSelected, true);
  assert.equal(stateSet, 'login_method_selected');
  assert.match(logs[0], /自动选择 1\. Google OAuth/);
});

test('GEMINI_STRATEGY handlePrompt auto-selects parent folder trust', () => {
  const writes = [];
  const logs = [];
  let stateSet = '';
  const job = {
    status: 'running',
    provider: 'gemini',
    logs: 'Do you trust the files in this folder?\n2. Trust parent folder',
    _ptyProcess: {
      write(chunk) {
        writes.push(chunk);
      }
    }
  };
  const deps = {
    stripAnsi: (str) => str,
    appendJobLog: (j, msg) => logs.push(msg),
    setAuthProgressState: (j, s) => { stateSet = s; },
    states: {
      AWAITING_FOLDER_TRUST: 'awaiting_folder_trust',
      FOLDER_TRUST_SELECTED: 'folder_trust_selected'
    }
  };

  const handled = GEMINI_STRATEGY.handlePrompt({ job, deps });
  assert.equal(handled, true);
  assert.deepEqual(writes, ['2\r']);
  assert.equal(job._geminiFolderTrustSelected, true);
  assert.equal(stateSet, 'folder_trust_selected');
});

test('createPromptResponder gracefully logs when PTY cannot write', () => {
  const logs = [];
  const responder = createPromptResponder({
    pattern: /Confirm\?/i,
    response: 'y\r',
    stateFlag: '_confirmed',
    unavailableMessage: 'PTY unwriteable'
  });

  const job = {
    status: 'running',
    logs: 'Confirm?',
    _ptyProcess: null
  };
  const deps = {
    stripAnsi: (s) => s,
    appendJobLog: (j, msg) => logs.push(msg),
    states: {}
  };

  const result = responder({ job, deps });
  assert.equal(result, true);
  assert.equal(job._confirmed, true);
  assert.deepEqual(logs, ['PTY unwriteable']);
});
