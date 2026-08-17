'use strict';

// Headless invocation detection: the single authority for "is this `aih
// <provider> <id> …` call non-interactive?".
//
// The per-provider trigger table is NOT defined here — it lives in the Go
// provider contract (core/providers/builtins.go → contracts/providers/manifest.json)
// and is read through lib/provider-catalog.js, so CLI, server and web all answer
// this question from one source of truth.
//
// A headless call must never get a PTY, a tmux wrapper, or any interactive
// terminal chrome: it prints to stdout, exits, and its output has to survive
// being piped, captured or redirected.

const { getProviderHeadlessConfig } = require('../../../provider-catalog');

const DISABLE_ENV_KEY = 'AIH_HEADLESS_DIRECT_SPAWN';

function normalizeArgList(args) {
  return (Array.isArray(args) ? args : [])
    .map((arg) => String(arg == null ? '' : arg).trim());
}

// `--flag`, `--flag=value` and short `-p` all count as "this flag is present".
function matchesFlagToken(token, flag) {
  if (!token || !flag) return false;
  if (token === flag) return true;
  return flag.startsWith('--') && token.startsWith(`${flag}=`);
}

function hasTriggerFlag(tokens, flags) {
  const list = Array.isArray(flags) ? flags : [];
  return list.some((flag) => tokens.some((token) => matchesFlagToken(token, flag)));
}

// Only the first positional argument can be a subcommand (`codex exec …`,
// `opencode run …`); a prompt that merely contains the word does not count.
function hasTriggerSubcommand(tokens, subcommands) {
  const list = Array.isArray(subcommands) ? subcommands : [];
  if (list.length === 0) return false;
  const firstPositional = tokens.find((token) => token && !token.startsWith('-'));
  return Boolean(firstPositional && list.includes(firstPositional));
}

// Declared as "--name=value"; matches both `--name value` and `--name=value`.
function matchesStdinFlag(tokens, declaration) {
  const raw = String(declaration || '').trim();
  const separator = raw.indexOf('=');
  if (separator <= 0) return false;
  const name = raw.slice(0, separator);
  const value = raw.slice(separator + 1);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === `${name}=${value}`) return true;
    if (token === name && tokens[index + 1] === value) return true;
  }
  return false;
}

function wantsStdinForwarding(tokens, stdinFlags) {
  const list = Array.isArray(stdinFlags) ? stdinFlags : [];
  return list.some((declaration) => matchesStdinFlag(tokens, declaration));
}

// detectHeadlessInvocation is pure: no spawning, no terminal writes, no env
// mutation. `reason` exists so callers can log why a run stayed interactive.
function detectHeadlessInvocation(provider, args, options = {}) {
  const env = options.env || {};
  const readConfig = typeof options.getHeadlessConfig === 'function'
    ? options.getHeadlessConfig
    : getProviderHeadlessConfig;

  if (options.isLogin) {
    return { headless: false, wantsStdin: false, reason: 'login_flow' };
  }
  if (String(env[DISABLE_ENV_KEY] || '1') === '0') {
    return { headless: false, wantsStdin: false, reason: 'disabled_by_env' };
  }

  const config = readConfig(provider);
  if (!config) {
    return { headless: false, wantsStdin: false, reason: 'provider_has_no_headless_mode' };
  }

  const tokens = normalizeArgList(args);
  if (hasTriggerFlag(tokens, config.triggerFlags)) {
    return {
      headless: true,
      wantsStdin: wantsStdinForwarding(tokens, config.stdinFlags),
      reason: 'trigger_flag'
    };
  }
  if (hasTriggerSubcommand(tokens, config.triggerSubcommands)) {
    return {
      headless: true,
      wantsStdin: wantsStdinForwarding(tokens, config.stdinFlags),
      reason: 'trigger_subcommand'
    };
  }
  return { headless: false, wantsStdin: false, reason: 'interactive_args' };
}

module.exports = {
  DISABLE_ENV_KEY,
  detectHeadlessInvocation
};
