#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BASE_URL = 'http://127.0.0.1:9527';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ACCOUNT_REF = /^acct_[a-f0-9]{20}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROMPT = 'Reply exactly OK.';

const PLAN_KEYS = Object.freeze([
  'sequence',
  'provider',
  'accountRef',
  'authKind',
  'model',
  'path',
  'outputTokenCap',
]);

const RESULT_KEYS = Object.freeze([
  'sequence',
  'provider',
  'accountRef',
  'authKind',
  'model',
  'path',
  'httpStatus',
  'requestId',
  'selectedAccountRef',
  'accountRefMatched',
  'effectiveModel',
  'effectiveModelMatched',
  'responseShape',
  'responseShapeValid',
  'assistantTextPresent',
  'outcome',
  'errorCode',
  'availabilityReasonCodes',
  'retryAfterSeconds',
  'usage',
  'durationMs',
]);

const SAFE_ERROR_CODES = new Set([
  'auth_invalid_reauth_required',
  'unauthorized_client',
  'upstream_rate_limited',
  'rate_limited',
  'no_available_account',
  'model_not_found',
  'invalid_model',
  'unsupported_model',
  'safety_rejected',
  'unsupported_location',
  'upstream_error',
  'bad_request',
]);

const SAFE_AVAILABILITY_CODES = new Set([
  'blocked_by_quota',
  'quota_exhausted',
  'blocked_by_policy',
  'rate_limited',
  'model_unavailable',
  'credential_invalid',
  'unconfigured',
  'disabled',
  'cooldown_active',
]);

const PROVIDER_SPECS = Object.freeze({
  kimi: Object.freeze({
    order: 0,
    authKind: 'oauth',
    model: 'k3',
    path: '/v1/chat/completions',
    outputTokenCap: 128,
    responseShape: 'openai.chat_completion',
    body: () => ({
      model: 'k3',
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: 128,
      stream: false,
    }),
  }),
  grok: Object.freeze({
    order: 1,
    authKind: 'oauth',
    model: 'grok-4.6',
    path: '/v1/chat/completions',
    outputTokenCap: 8,
    responseShape: 'openai.chat_completion',
    body: () => ({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: 8,
      stream: false,
    }),
  }),
  agy: Object.freeze({
    order: 2,
    authKind: 'oauth',
    model: 'gemini-2.5-flash',
    path: '/v1beta/models/gemini-2.5-flash:generateContent',
    outputTokenCap: 8,
    responseShape: 'gemini.generateContent',
    body: () => ({
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      generationConfig: {
        maxOutputTokens: 8,
        temperature: 0,
        thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
      },
    }),
  }),
  codex: Object.freeze({
    order: 3,
    authKind: 'oauth',
    model: 'gpt-5.4-mini',
    path: '/v1/responses',
    outputTokenCap: 32,
    responseShape: 'openai.response',
    body: () => ({
      model: 'gpt-5.4-mini',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: PROMPT }],
      }],
      store: false,
      reasoning: { effort: 'low' },
      stream: false,
    }),
  }),
  opencode: Object.freeze({
    order: 4,
    authKind: 'opencode-auth',
    model: 'opencode-go/deepseek-v4-flash',
    path: '/v1/chat/completions',
    outputTokenCap: 8,
    responseShape: 'openai.chat_completion',
    body: () => ({
      model: 'opencode-go/deepseek-v4-flash',
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: 8,
      stream: false,
    }),
  }),
  claude: Object.freeze({
    order: 5,
    authKind: 'oauth',
    model: 'claude-haiku-4-5-20251001',
    path: '/v1/messages',
    outputTokenCap: 8,
    responseShape: 'anthropic.message',
    body: () => ({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{ role: 'user', content: PROMPT }],
      stream: false,
    }),
  }),
});

class SmokeFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'SmokeFailure';
    this.code = code;
  }
}

function fail(code) {
  throw new SmokeFailure(code);
}

function defaultDbPath(env = process.env) {
  const aihHome = typeof env.AIH_HOME === 'string' && env.AIH_HOME.trim()
    ? env.AIH_HOME.trim()
    : path.join(os.homedir(), '.ai_home');
  return path.join(aihHome, 'app-state.db');
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`missing_${flag.slice(2).replaceAll('-', '_')}`);
  }
  return value;
}

function parsePositiveInteger(value, code, maximum) {
  if (!/^\d+$/.test(String(value))) {
    fail(code);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    fail(code);
  }
  return parsed;
}

function parseArgs(argv) {
  const result = {
    mode: 'dry-run',
    baseUrl: DEFAULT_BASE_URL,
    confirmedPlan: undefined,
    accountRefs: [],
    json: false,
    dbPath: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  };
  let explicitMode;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (/^--(?:key|api-key|client-key)(?:=|$)/.test(argument)) {
      fail('argv_key_forbidden');
    }
    if (argument === '--dry-run' || argument === '--execute') {
      const mode = argument === '--execute' ? 'execute' : 'dry-run';
      if (explicitMode && explicitMode !== mode) {
        fail('conflicting_mode');
      }
      explicitMode = mode;
      result.mode = mode;
      continue;
    }
    if (argument === '--json') {
      result.json = true;
      continue;
    }

    const [flag, inlineValue] = argument.split('=', 2);
    if (['--confirmed-plan', '--base-url', '--account-ref', '--db-path', '--timeout-ms', '--max-response-bytes'].includes(flag)) {
      const value = inlineValue === undefined ? requireValue(argv, index, flag) : inlineValue;
      if (inlineValue === undefined) {
        index += 1;
      }
      if (!value) {
        fail(`missing_${flag.slice(2).replaceAll('-', '_')}`);
      }
      if (flag === '--confirmed-plan') {
        result.confirmedPlan = value;
      } else if (flag === '--base-url') {
        result.baseUrl = validateBaseUrl(value);
      } else if (flag === '--account-ref') {
        if (!ACCOUNT_REF.test(value)) {
          fail('invalid_account_ref');
        }
        result.accountRefs.push(value);
      } else if (flag === '--db-path') {
        result.dbPath = value;
      } else if (flag === '--timeout-ms') {
        result.timeoutMs = parsePositiveInteger(value, 'invalid_timeout_ms', 300_000);
      } else {
        result.maxResponseBytes = parsePositiveInteger(
          value,
          'invalid_max_response_bytes',
          16 * 1024 * 1024,
        );
      }
      continue;
    }
    fail('invalid_argument');
  }

  result.baseUrl = validateBaseUrl(result.baseUrl);
  result.accountRefs = [...new Set(result.accountRefs)];
  return result;
}

function validateBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid_base_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail('invalid_base_url');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('invalid_base_url');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    fail('non_loopback_base_url');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    fail('invalid_base_url');
  }
  return parsed.origin;
}

function getDatabaseSync(DatabaseSyncImpl) {
  if (DatabaseSyncImpl) {
    return DatabaseSyncImpl;
  }
  return require('node:sqlite').DatabaseSync;
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractModelId(model) {
  if (typeof model === 'string') {
    return MODEL_IDENTIFIER.test(model) ? model : null;
  }
  if (!model || typeof model !== 'object') {
    return null;
  }
  for (const candidate of [model.id, model.model, model.name]) {
    if (typeof candidate === 'string' && MODEL_IDENTIFIER.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractModelsByAccount(snapshot) {
  const byAccount = snapshot?.byAccount;
  if (!byAccount || typeof byAccount !== 'object' || Array.isArray(byAccount)) {
    return {};
  }
  const modelsByAccount = {};
  for (const [accountRef, entry] of Object.entries(byAccount)) {
    if (!ACCOUNT_REF.test(accountRef)) {
      continue;
    }
    const candidates = Array.isArray(entry)
      ? entry
      : Array.isArray(entry?.models)
        ? entry.models
        : [];
    modelsByAccount[accountRef] = [
      ...new Set(candidates.map(extractModelId).filter(Boolean)),
    ];
  }
  return modelsByAccount;
}

function loadStateFromDb({ dbPath, DatabaseSyncImpl } = {}) {
  const DatabaseSync = getDatabaseSync(DatabaseSyncImpl);
  const database = new DatabaseSync(dbPath || defaultDbPath(), { readOnly: true });
  try {
    const accountRows = database.prepare(`
      SELECT provider, account_ref, auth_mode, status, configured, api_key_mode
      FROM account_state
      WHERE status = 'up' AND configured = 1 AND api_key_mode = 0
    `).all();
    const snapshotRow = database.prepare(
      'SELECT value FROM app_kv WHERE key = ?',
    ).get('cache:webui-models-snapshot.json');
    const snapshot = parseJsonObject(snapshotRow?.value) || {};
    return {
      accounts: accountRows.map((row) => ({
        provider: row.provider,
        accountRef: row.account_ref,
        authMode: row.auth_mode,
        status: row.status,
        configured: row.configured,
        apiKeyMode: row.api_key_mode,
      })),
      modelsByAccount: extractModelsByAccount(snapshot),
    };
  } finally {
    database.close();
  }
}

function loadClientKey({ env = process.env, dbPath, DatabaseSyncImpl } = {}) {
  const environmentKey = env.AIH_ACCOUNT_SMOKE_CLIENT_KEY;
  if (typeof environmentKey === 'string' && environmentKey.trim()) {
    return environmentKey.trim();
  }

  const DatabaseSync = getDatabaseSync(DatabaseSyncImpl);
  const database = new DatabaseSync(dbPath || defaultDbPath(env), { readOnly: true });
  try {
    const row = database.prepare(
      'SELECT value FROM app_kv WHERE key = ?',
    ).get('config:server');
    const config = parseJsonObject(row?.value);
    for (const key of ['apiKey', 'clientKey', 'api_key', 'client_key']) {
      const candidate = config?.[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    fail('client_key_unavailable');
  } finally {
    database.close();
  }
}

function normalizeModels(modelsByAccount, accountRef) {
  const entry = modelsByAccount?.[accountRef];
  const candidates = Array.isArray(entry)
    ? entry
    : Array.isArray(entry?.models)
      ? entry.models
      : [];
  return new Set(candidates.map(extractModelId).filter(Boolean));
}

function isEligibleAccount(account) {
  if (!account || typeof account !== 'object') {
    return false;
  }
  if (account.status !== undefined && account.status !== 'up') {
    return false;
  }
  if (account.configured !== undefined && Number(account.configured) !== 1) {
    return false;
  }
  if (account.apiKeyMode !== undefined && Number(account.apiKeyMode) !== 0) {
    return false;
  }
  const authMode = String(account.authMode || '').trim().toLowerCase().replaceAll('_', '-');
  if (account.provider === 'opencode') {
    return authMode === 'opencode-auth';
  }
  return authMode.startsWith('oauth') || (account.provider === 'codex' && authMode === 'chatgpt');
}

function buildPlan(state, { accountRefs = [] } = {}) {
  if (!state || !Array.isArray(state.accounts)) {
    fail('invalid_account_state');
  }
  const requestedRefs = new Set(accountRefs);
  for (const ref of requestedRefs) {
    if (!ACCOUNT_REF.test(ref)) {
      fail('invalid_account_ref');
    }
  }

  const seenRefs = new Set();
  const candidates = [];
  for (const account of state.accounts) {
    if (!isEligibleAccount(account)) {
      continue;
    }
    if (!ACCOUNT_REF.test(account.accountRef)) {
      fail('invalid_account_ref');
    }
    if (seenRefs.has(account.accountRef)) {
      fail('duplicate_account_ref');
    }
    seenRefs.add(account.accountRef);
    if (requestedRefs.size > 0 && !requestedRefs.has(account.accountRef)) {
      continue;
    }

    const spec = PROVIDER_SPECS[account.provider];
    if (!spec) {
      fail('unsupported_provider');
    }
    const models = normalizeModels(state.modelsByAccount, account.accountRef);
    if (!models.has(spec.model)) {
      fail('required_model_unavailable');
    }
    candidates.push({ account, spec });
  }

  for (const requestedRef of requestedRefs) {
    if (!candidates.some(({ account }) => account.accountRef === requestedRef)) {
      fail('unknown_account_ref');
    }
  }
  if (candidates.length === 0) {
    fail('empty_plan');
  }

  candidates.sort((left, right) => (
    left.spec.order - right.spec.order
    || left.account.accountRef.localeCompare(right.account.accountRef)
  ));
  return candidates.map(({ account, spec }, index) => ({
    sequence: index + 1,
    provider: account.provider,
    accountRef: account.accountRef,
    authKind: spec.authKind,
    model: spec.model,
    path: spec.path,
    outputTokenCap: spec.outputTokenCap,
  }));
}

function computePlanDigest(plan) {
  if (!Array.isArray(plan)) {
    fail('invalid_plan');
  }
  const canonical = plan.map((item) => Object.fromEntries(
    PLAN_KEYS.map((key) => [key, item[key]]),
  ));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function planSummary(plan) {
  return {
    total: plan.length,
    oauth: plan.filter((item) => item.authKind === 'oauth').length,
    openCodeAuth: plan.filter((item) => item.authKind === 'opencode-auth').length,
  };
}

function buildRequestBody(item) {
  const spec = PROVIDER_SPECS[item.provider];
  if (!spec || spec.model !== item.model || spec.path !== item.path) {
    fail('invalid_plan');
  }
  return spec.body();
}

function safeRequestId(value) {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value) ? value : null;
}

function safeAccountRef(value) {
  return typeof value === 'string' && ACCOUNT_REF.test(value) ? value : null;
}

function safeErrorCode(value) {
  return typeof value === 'string' && SAFE_ERROR_CODES.has(value) ? value : null;
}

function safeAvailabilityCodes(reasons) {
  if (!Array.isArray(reasons)) {
    return [];
  }
  const codes = [];
  for (const entry of reasons) {
    const explicitCode = typeof entry === 'string' ? entry : entry?.code;
    if (SAFE_AVAILABILITY_CODES.has(explicitCode)) {
      codes.push(explicitCode);
      continue;
    }
    const reason = String(entry?.reason || '').trim().toLowerCase();
    if (reason.startsWith('blocked_by_quota:')) {
      codes.push('blocked_by_quota');
    } else if (reason === 'quota_exhausted' || reason.includes('model_quota_exhausted')) {
      codes.push('quota_exhausted');
    } else if (reason.startsWith('blocked_by_policy:')) {
      codes.push('blocked_by_policy');
    } else if (reason.includes('auth_invalid_reauth_required')) {
      codes.push('credential_invalid');
    } else if (
      reason.includes('rate_limit')
      || reason.includes('rate limited')
      || reason.includes('upstream_429')
      || reason.includes('http_429')
      || reason.includes('too_many_requests')
    ) {
      codes.push('rate_limited');
    } else if (reason.startsWith('model_cooldown:')) {
      codes.push('model_unavailable');
    } else if (reason.startsWith('cooldown:') || reason === 'cooldown') {
      codes.push('cooldown_active');
    }
  }
  return [...new Set(codes)].sort();
}

function safeRetryAfter(value) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return seconds <= 86_400 ? seconds : null;
}

function classifyHttpFailure(httpStatus, errorCode, availabilityReasonCodes) {
  const reasons = new Set(availabilityReasonCodes);
  if (httpStatus === 401 && errorCode === 'auth_invalid_reauth_required') {
    return 'credential_invalid';
  }
  if (httpStatus === 401 && errorCode === 'unauthorized_client') {
    return 'client_key_source_mismatch';
  }
  if (httpStatus === 402) {
    return 'quota_blocked';
  }
  if (reasons.has('blocked_by_quota') || reasons.has('quota_exhausted')) {
    return 'quota_blocked';
  }
  if (reasons.has('blocked_by_policy')) {
    return 'policy_blocked';
  }
  if (reasons.size === 1 && reasons.has('credential_invalid')) {
    return 'credential_invalid';
  }
  if (
    httpStatus === 429
    || errorCode === 'upstream_rate_limited'
    || errorCode === 'rate_limited'
    || reasons.has('rate_limited')
  ) {
    return 'rate_limited';
  }
  if (
    [400, 404].includes(httpStatus)
    && ['model_not_found', 'invalid_model', 'unsupported_model'].includes(errorCode)
  ) {
    return 'catalog_or_model_drift';
  }
  if (httpStatus === 403 && errorCode === 'safety_rejected') {
    return 'safety_rejected';
  }
  if (httpStatus === 403 && errorCode === 'unsupported_location') {
    return 'unsupported_location';
  }
  if (httpStatus >= 500) {
    return 'upstream_or_transport_failure';
  }
  return 'upstream_rejected';
}

function numericUsage(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function normalizeAgyPayload(payload) {
  if (
    payload
    && typeof payload === 'object'
    && payload.response
    && typeof payload.response === 'object'
    && !Array.isArray(payload.response)
  ) {
    return payload.response;
  }
  return payload;
}

function usageFromPayload(provider, payload) {
  if (provider === 'agy') {
    const normalizedPayload = normalizeAgyPayload(payload);
    return {
      inputTokens: numericUsage(normalizedPayload?.usageMetadata?.promptTokenCount),
      outputTokens: numericUsage(normalizedPayload?.usageMetadata?.candidatesTokenCount),
      totalTokens: numericUsage(normalizedPayload?.usageMetadata?.totalTokenCount),
    };
  }
  const usage = payload?.usage;
  const inputTokens = numericUsage(usage?.input_tokens ?? usage?.prompt_tokens);
  const outputTokens = numericUsage(usage?.output_tokens ?? usage?.completion_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: numericUsage(usage?.total_tokens)
      ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
  };
}

function hasNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function matchesProbeModel(provider, requestedModel, observedModel) {
  const requested = String(requestedModel || '').trim();
  const observed = String(observedModel || '').trim();
  if (!requested || !observed) return false;
  if (observed === requested) return true;
  if (provider !== 'codex' || !observed.startsWith(`${requested}-`)) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(observed.slice(requested.length + 1));
}

function validateResponsePayload(provider, payload) {
  const spec = PROVIDER_SPECS[provider];
  const usage = usageFromPayload(provider, payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, textPresent: false, effectiveModelRaw: null, usage };
  }

  if (provider === 'agy') {
    const normalizedPayload = normalizeAgyPayload(payload);
    const valid = Array.isArray(normalizedPayload?.candidates)
      && normalizedPayload.candidates.length > 0;
    const textPresent = valid && normalizedPayload.candidates.some((candidate) => (
      Array.isArray(candidate?.content?.parts)
      && candidate.content.parts.some((part) => hasNonEmptyText(part?.text))
    ));
    return { valid, textPresent, effectiveModelRaw: normalizedPayload.modelVersion, usage };
  }
  if (provider === 'claude') {
    const valid = payload.type === 'message' && Array.isArray(payload.content);
    const textPresent = valid && payload.content.some((part) => hasNonEmptyText(part?.text));
    return { valid, textPresent, effectiveModelRaw: payload.model, usage };
  }
  if (provider === 'codex') {
    const valid = payload.object === 'response'
      && payload.status === 'completed'
      && Array.isArray(payload.output);
    const textPresent = valid && payload.output.some((item) => (
      item?.type === 'message'
      && Array.isArray(item.content)
      && item.content.some((part) => hasNonEmptyText(part?.text))
    ));
    return { valid, textPresent, effectiveModelRaw: payload.model, usage };
  }

  const valid = Array.isArray(payload.choices) && payload.choices.length > 0;
  const textPresent = valid && payload.choices.some((choice) => {
    const content = choice?.message?.content;
    if (hasNonEmptyText(content)) {
      return true;
    }
    return Array.isArray(content) && content.some((part) => hasNonEmptyText(part?.text));
  });
  return { valid, textPresent, effectiveModelRaw: payload.model, usage };
}

async function readResponseBodyLimited(response, maxResponseBytes) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // The body is already rejected; cancellation is best-effort only.
        }
        fail('response_too_large');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }
  if (!response || typeof response.text !== 'function') {
    fail('invalid_response_shape');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
    fail('response_too_large');
  }
  return text;
}

function parseResponseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function emptyUsage() {
  return { inputTokens: null, outputTokens: null, totalTokens: null };
}

function baseResult(item, durationMs) {
  return {
    sequence: item.sequence,
    provider: item.provider,
    accountRef: item.accountRef,
    authKind: item.authKind,
    model: item.model,
    path: item.path,
    httpStatus: null,
    requestId: null,
    selectedAccountRef: null,
    accountRefMatched: false,
    effectiveModel: null,
    effectiveModelMatched: false,
    responseShape: PROVIDER_SPECS[item.provider].responseShape,
    responseShapeValid: false,
    assistantTextPresent: false,
    outcome: 'transport_failure',
    errorCode: null,
    availabilityReasonCodes: [],
    retryAfterSeconds: null,
    usage: emptyUsage(),
    durationMs,
  };
}

function failureResultFromException(item, error, durationMs) {
  const result = baseResult(item, durationMs);
  if (error?.code === 'response_too_large') {
    result.outcome = 'response_too_large';
  } else if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    result.outcome = 'timeout';
  } else if (error?.code === 'invalid_response_shape') {
    result.outcome = 'invalid_response_shape';
  }
  return result;
}

function explicitAccountEvidence(payload) {
  const availability = payload?.availability;
  const requestedAccountRef = safeAccountRef(availability?.requestedAccountRef);
  const sampleRefs = [];
  if (Array.isArray(availability?.reasons)) {
    for (const reason of availability.reasons) {
      if (!Array.isArray(reason?.sampleAccountRefs)) {
        continue;
      }
      for (const candidate of reason.sampleAccountRefs) {
        const ref = safeAccountRef(candidate);
        if (ref) {
          sampleRefs.push(ref);
        }
      }
    }
  }
  return { requestedAccountRef, sampleRefs: [...new Set(sampleRefs)] };
}

function resultFromHttpFailure(item, response, payload, durationMs) {
  const result = baseResult(item, durationMs);
  result.httpStatus = Number.isInteger(response.status) ? response.status : null;
  result.requestId = safeRequestId(response.headers?.get?.('x-aih-request-id'));
  const headerAccountRef = safeAccountRef(response.headers?.get?.('x-aih-server-account-ref'));
  const evidence = explicitAccountEvidence(payload);
  const soleSampleAccountRef = evidence.sampleRefs.length === 1 ? evidence.sampleRefs[0] : null;
  result.selectedAccountRef = headerAccountRef || evidence.requestedAccountRef || soleSampleAccountRef;
  result.accountRefMatched = result.selectedAccountRef === item.accountRef;
  result.errorCode = safeErrorCode(payload?.error);
  result.availabilityReasonCodes = safeAvailabilityCodes(payload?.availability?.reasons);
  result.retryAfterSeconds = safeRetryAfter(response.headers?.get?.('retry-after'));

  const mismatchedSample = evidence.sampleRefs.some((ref) => ref !== item.accountRef);
  if ((result.selectedAccountRef && !result.accountRefMatched) || mismatchedSample) {
    result.outcome = 'routing_fallback_violation';
  } else {
    result.outcome = classifyHttpFailure(
      result.httpStatus,
      result.errorCode,
      result.availabilityReasonCodes,
    );
  }
  return result;
}

function resultFromSuccess(item, response, payload, durationMs) {
  const validation = validateResponsePayload(item.provider, payload);
  const result = baseResult(item, durationMs);
  result.httpStatus = response.status;
  result.requestId = safeRequestId(response.headers?.get?.('x-aih-request-id'));
  result.selectedAccountRef = safeAccountRef(
    response.headers?.get?.('x-aih-server-account-ref'),
  );
  result.accountRefMatched = result.selectedAccountRef === item.accountRef;
  result.responseShapeValid = validation.valid;
  result.assistantTextPresent = validation.textPresent;
  result.usage = validation.usage;

  const effectiveModelRaw = item.provider === 'codex'
    ? response.headers?.get?.('x-aih-effective-model')
    : validation.effectiveModelRaw;
  const effectiveModelPresent = typeof effectiveModelRaw === 'string'
    && MODEL_IDENTIFIER.test(effectiveModelRaw);
  const codexBodyModelValid = item.provider !== 'codex'
    || validation.effectiveModelRaw === undefined
    || validation.effectiveModelRaw === null
    || matchesProbeModel(item.provider, item.model, validation.effectiveModelRaw);
  result.effectiveModelMatched = effectiveModelPresent
    && matchesProbeModel(item.provider, item.model, effectiveModelRaw)
    && codexBodyModelValid;
  result.effectiveModel = result.effectiveModelMatched ? item.model : null;

  if (!result.requestId) {
    result.outcome = 'missing_request_id_evidence';
  } else if (!result.selectedAccountRef) {
    result.outcome = 'missing_account_ref_evidence';
  } else if (!result.accountRefMatched) {
    result.outcome = 'routing_fallback_violation';
  } else if (!effectiveModelPresent) {
    result.outcome = 'missing_effective_model';
  } else if (!result.effectiveModelMatched) {
    result.outcome = 'effective_model_mismatch';
  } else if (!result.responseShapeValid) {
    result.outcome = 'invalid_response_shape';
  } else if (!result.assistantTextPresent) {
    result.outcome = 'missing_assistant_content';
  } else {
    result.outcome = 'usable';
  }
  return result;
}

function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

async function preflightGateway({
  baseUrl,
  clientKey,
  fetchImpl,
  timeoutMs,
  maxResponseBytes,
  timeoutSignalFactory,
}) {
  let response;
  let text;
  try {
    response = await fetchImpl(new URL('/v1/models', `${baseUrl}/`).toString(), {
      method: 'GET',
      redirect: 'error',
      signal: timeoutSignalFactory(timeoutMs),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${clientKey}`,
      },
    });
    text = await readResponseBodyLimited(response, maxResponseBytes);
  } catch (error) {
    if (error?.code === 'response_too_large') throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      fail('gateway_preflight_timeout');
    }
    fail('gateway_preflight_failed');
  }

  const payload = parseResponseJson(text);
  if (response.status === 401) {
    fail('client_key_source_mismatch');
  }
  if (!isSuccessStatus(response.status)) {
    fail('gateway_preflight_failed');
  }
  if (!payload || payload.object !== 'list' || !Array.isArray(payload.data)) {
    fail('gateway_preflight_failed');
  }
}

async function executeProbe({
  item,
  baseUrl,
  clientKey,
  fetchImpl,
  timeoutMs,
  maxResponseBytes,
  timeoutSignalFactory,
  now,
}) {
  const startedAt = now();
  let response;
  let text;
  try {
    response = await fetchImpl(new URL(item.path, `${baseUrl}/`).toString(), {
      method: 'POST',
      redirect: 'error',
      signal: timeoutSignalFactory(timeoutMs),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${clientKey}`,
        'x-provider': item.provider,
        'x-account-ref': item.accountRef,
      },
      body: JSON.stringify(buildRequestBody(item)),
    });
    text = await readResponseBodyLimited(response, maxResponseBytes);
  } catch (error) {
    return failureResultFromException(item, error, Math.max(0, now() - startedAt));
  }

  const payload = parseResponseJson(text);
  const durationMs = Math.max(0, now() - startedAt);
  if (!isSuccessStatus(response.status)) {
    return resultFromHttpFailure(item, response, payload, durationMs);
  }
  if (!payload) {
    const result = baseResult(item, durationMs);
    result.httpStatus = response.status;
    result.requestId = safeRequestId(response.headers?.get?.('x-aih-request-id'));
    result.selectedAccountRef = safeAccountRef(response.headers?.get?.('x-aih-server-account-ref'));
    result.accountRefMatched = result.selectedAccountRef === item.accountRef;
    result.outcome = 'invalid_response_shape';
    return result;
  }
  return resultFromSuccess(item, response, payload, durationMs);
}

function assertExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('unsafe_report');
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('unsafe_report');
  }
}

function assertSafeReport(report, clientKey) {
  if (report.mode === 'dry-run') {
    assertExactKeys(report, ['mode', 'planDigest', 'summary', 'plan']);
    assertExactKeys(report.summary, ['total', 'oauth', 'openCodeAuth']);
    for (const item of report.plan) {
      assertExactKeys(item, PLAN_KEYS);
    }
  } else {
    assertExactKeys(report, ['mode', 'planDigest', 'summary', 'results']);
    assertExactKeys(report.summary, ['total', 'oauth', 'openCodeAuth', 'usable', 'failed']);
    for (const result of report.results) {
      assertExactKeys(result, RESULT_KEYS);
      assertExactKeys(result.usage, ['inputTokens', 'outputTokens', 'totalTokens']);
    }
  }
  if (typeof clientKey === 'string' && clientKey.length >= 8) {
    if (JSON.stringify(report).includes(clientKey)) {
      fail('unsafe_report');
    }
  }
}

async function runHarness({
  mode = 'dry-run',
  confirmedPlan,
  accountRefs = [],
  baseUrl = DEFAULT_BASE_URL,
  dbPath,
  env = process.env,
  inventoryLoader,
  keyLoader,
  fetchImpl = globalThis.fetch,
  DatabaseSyncImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  timeoutSignalFactory = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = Date.now,
} = {}) {
  if (!['dry-run', 'execute'].includes(mode)) {
    fail('invalid_mode');
  }
  const safeBaseUrl = validateBaseUrl(baseUrl);
  const resolvedDbPath = dbPath || defaultDbPath(env);
  let state;
  try {
    state = await (inventoryLoader
      ? inventoryLoader({ dbPath: resolvedDbPath })
      : loadStateFromDb({ dbPath: resolvedDbPath, DatabaseSyncImpl }));
  } catch (error) {
    if (error?.code) {
      throw error;
    }
    fail('state_read_failed');
  }
  const plan = buildPlan(state, { accountRefs });
  const planDigest = computePlanDigest(plan);
  const summary = planSummary(plan);

  if (mode === 'dry-run') {
    const report = { mode, planDigest, summary, plan };
    assertSafeReport(report);
    return report;
  }
  if (!confirmedPlan) {
    fail('confirmed_plan_required');
  }
  if (!/^[a-f0-9]{64}$/.test(confirmedPlan) || confirmedPlan !== planDigest) {
    fail('confirmed_plan_mismatch');
  }

  let clientKey;
  try {
    clientKey = await (keyLoader
      ? keyLoader({ env, dbPath: resolvedDbPath })
      : loadClientKey({ env, dbPath: resolvedDbPath, DatabaseSyncImpl }));
  } catch (error) {
    if (error?.code === 'client_key_unavailable') {
      throw error;
    }
    fail('client_key_unavailable');
  }
  if (typeof clientKey !== 'string' || !clientKey.trim()) {
    fail('client_key_unavailable');
  }
  if (typeof fetchImpl !== 'function') {
    fail('fetch_unavailable');
  }

  await preflightGateway({
    baseUrl: safeBaseUrl,
    clientKey,
    fetchImpl,
    timeoutMs,
    maxResponseBytes,
    timeoutSignalFactory,
  });

  const results = [];
  for (const item of plan) {
    results.push(await executeProbe({
      item,
      baseUrl: safeBaseUrl,
      clientKey,
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
      timeoutSignalFactory,
      now,
    }));
  }
  const usable = results.filter((result) => result.outcome === 'usable').length;
  const report = {
    mode,
    planDigest,
    summary: { ...summary, usable, failed: results.length - usable },
    results,
  };
  assertSafeReport(report, clientKey);
  return report;
}

function safeTopLevelErrorCode(error) {
  if (error instanceof SmokeFailure && /^[a-z0-9_]+$/.test(error.code)) {
    return error.code;
  }
  return 'smoke_harness_failed';
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseArgs(argv);
    const report = await runHarness({ ...options, ...dependencies });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.exitCode = 2;
    process.stdout.write(`${JSON.stringify({
      mode: 'error',
      errorCode: safeTopLevelErrorCode(error),
    })}\n`);
  }
}

module.exports = {
  PLAN_KEYS,
  RESULT_KEYS,
  buildPlan,
  classifyHttpFailure,
  computePlanDigest,
  loadClientKey,
  loadStateFromDb,
  main,
  parseArgs,
  readResponseBodyLimited,
  runHarness,
  validateBaseUrl,
};

if (require.main === module) {
  void main();
}
