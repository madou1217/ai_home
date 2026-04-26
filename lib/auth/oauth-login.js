'use strict';

const OAUTH_PROVIDER_SPECS = Object.freeze({
  codex: Object.freeze({ cli: 'codex', oauthAction: 'login' }),
  claude: Object.freeze({ cli: 'claude', oauthAction: 'login' }),
  gemini: Object.freeze({ cli: 'gemini', oauthAction: 'auth' })
});

const OAUTH_PROVIDER_ALIASES = Object.freeze({
  google: 'gemini'
});

const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'invalid_input',
  UNKNOWN_PROVIDER: 'unknown_provider',
  INVALID_ACCOUNT_ID: 'invalid_account_id',
  OAUTH_EXECUTOR_REQUIRED: 'oauth_executor_required',
  OAUTH_EXECUTION_FAILED: 'oauth_execution_failed',
  OAUTH_EXECUTION_THROWN: 'oauth_execution_thrown',
  UNKNOWN_CLI: 'unknown_provider',
  EXECUTION_FAILED: 'oauth_execution_failed',
  EXECUTOR_FAILED: 'oauth_execution_thrown'
});

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCli(value) {
  return normalizeString(value).toLowerCase();
}

function resultOk(value) {
  return { ok: true, value };
}

function resultError(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      details: details && typeof details === 'object' ? details : {}
    }
  };
}

function getOAuthProviderSpec(cliName) {
  const rawCli = normalizeCli(cliName);
  if (!rawCli) {
    return resultError(ERROR_CODES.INVALID_INPUT, 'cli is required');
  }
  const cli = OAUTH_PROVIDER_ALIASES[rawCli] || rawCli;
  const spec = OAUTH_PROVIDER_SPECS[cli];
  if (!spec) {
    return resultError(ERROR_CODES.UNKNOWN_PROVIDER, 'Unsupported cli for OAuth login', { cli: rawCli });
  }
  return resultOk(spec);
}

function normalizeAccountId(accountId) {
  const normalized = normalizeString(accountId);
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return resultError(ERROR_CODES.INVALID_ACCOUNT_ID, 'account_id must match [A-Za-z0-9_-]+', { account_id: normalized });
  }
  return resultOk(normalized);
}

function resolveOAuthFlow(input) {
  if (!input || typeof input !== 'object') {
    return resultError(ERROR_CODES.INVALID_INPUT, 'input must be an object');
  }

  const specResult = getOAuthProviderSpec(input.cli);
  if (!specResult.ok) {
    return specResult;
  }

  const accountResult = normalizeAccountId(input.account_id || input.accountId);
  if (!accountResult.ok) {
    return accountResult;
  }

  const spec = specResult.value;
  const args = [spec.cli, accountResult.value, spec.oauthAction];

  return resultOk({
    type: 'oauth_flow',
    cli: spec.cli,
    account_id: accountResult.value,
    oauth_action: spec.oauthAction,
    args
  });
}

function toExecutionFailure(flow, code, message, details) {
  return resultError(code, message, {
    cli: flow && flow.cli ? flow.cli : '',
    account_id: flow && flow.account_id ? flow.account_id : '',
    ...(details && typeof details === 'object' ? details : {})
  });
}

async function executeOAuthFlow(input, executor) {
  const flowResult = resolveOAuthFlow(input);
  if (!flowResult.ok) {
    return flowResult;
  }
  const flow = flowResult.value;

  if (typeof executor !== 'function') {
    return toExecutionFailure(flow, ERROR_CODES.OAUTH_EXECUTOR_REQUIRED, 'executor function is required');
  }

  let execution;
  try {
    execution = await executor(flow);
  } catch (error) {
    return toExecutionFailure(flow, ERROR_CODES.OAUTH_EXECUTION_THROWN, 'OAuth executor threw an exception', {
      reason: normalizeString(error && error.message)
    });
  }

  const exitCode = Number.isInteger(execution && execution.exitCode) ? execution.exitCode : 1;
  if (exitCode !== 0) {
    return toExecutionFailure(flow, ERROR_CODES.OAUTH_EXECUTION_FAILED, 'OAuth login command failed', {
      exit_code: exitCode,
      signal: normalizeString(execution && execution.signal),
      stderr: normalizeString(execution && execution.stderr)
    });
  }

  return resultOk({
    type: 'oauth_login_result',
    status: 'success',
    cli: flow.cli,
    account_id: flow.account_id,
    oauth_action: flow.oauth_action,
    args: flow.args.slice(),
    exit_code: 0
  });
}

function buildOAuthLoginPlan(input) {
  return resolveOAuthFlow(input);
}

async function executeOAuthLogin(input, executor) {
  return executeOAuthFlow(input, executor);
}

module.exports = {
  OAUTH_PROVIDER_ALIASES,
  OAUTH_PROVIDER_SPECS,
  ERROR_CODES,
  resolveOAuthFlow,
  executeOAuthFlow,
  buildOAuthLoginPlan,
  executeOAuthLogin,
  getOAuthProviderSpec
};
