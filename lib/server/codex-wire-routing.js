'use strict';

// Routing decision for the codex family: which upstream wire API serves this
// request.
//
// The codex adapter translates `/v1/chat/completions` into an OpenAI Responses
// call against `<base>/responses`. Relay endpoints that only expose
// `<base>/chat/completions` cannot answer that, so requests bound for such an
// account must take the generic passthrough path instead — it already speaks
// plain chat/completions and owns retry, circuit-breaking, streaming, and usage
// accounting.
//
// The decision is made before an account is picked, so it mirrors the pool
// filtering the downstream handlers perform: narrow by explicit account
// pin, then by the model inverted index. Anything ambiguous falls back to the
// existing Responses behaviour, keeping this change additive.

const { findRoutableAccountsForModel } = require('./model-account-index');
const { listManualModelSettings } = require('./model-catalog-settings-store');
const { modelIdsMatch } = require('./model-id');
const { usesChatCompletionsWireApi } = require('./upstream-account-profile');

function listCodexPool(state) {
  const pool = state && state.accounts && state.accounts.codex;
  return Array.isArray(pool) ? pool.filter(Boolean) : [];
}

function filterPoolByAccountRef(pool, accountRef) {
  const target = String(accountRef || '').trim();
  if (!target) return pool;
  return pool.filter((account) => String(account && account.accountRef || '') === target);
}

// A manual catalog entry is an operator-declared binding, so it outranks the
// probe-derived index. It is also the only signal available for relays that
// expose no /models endpoint and therefore never get probed.
function filterPoolByManualBinding(pool, state, modelId) {
  const bindings = listManualModelSettings(state && state.modelCatalogSettings, {
    enabledOnly: true
  }).filter((record) => (
    (!record.provider || record.provider === 'codex')
    && modelIdsMatch(record.id, modelId)
    && String(record.accountRef || '').trim()
  ));
  if (bindings.length < 1) return { pool, filtered: false };
  const allowed = new Set(bindings.map((record) => String(record.accountRef).trim()));
  const narrowed = pool.filter((account) => allowed.has(String(account && account.accountRef || '')));
  return narrowed.length > 0 ? { pool: narrowed, filtered: true } : { pool, filtered: false };
}

// Mirrors selectAccountsForRequestModel: use the inverted index when it is
// warm, and treat a cold or model-less index as "cannot narrow".
function filterPoolByModel(pool, state, model) {
  const modelId = String(model || '').trim();
  if (!modelId) return { pool, filtered: false };
  const manual = filterPoolByManualBinding(pool, state, modelId);
  if (manual.filtered) return manual;
  const index = state && state.modelAccountIndex;
  if (!index || !(index.builtAt > 0)) return { pool, filtered: false };
  const accountRefs = findRoutableAccountsForModel(index, modelId, 'codex');
  if (accountRefs.length < 1) return { pool, filtered: false };
  const allowed = new Set(accountRefs);
  return {
    pool: pool.filter((account) => allowed.has(String(account && account.accountRef || ''))),
    filtered: true
  };
}

function resolveCodexWireApiCandidates(params) {
  const { state, requestJson, requestedAccountRef } = params || {};
  const pinned = filterPoolByAccountRef(listCodexPool(state), requestedAccountRef);
  if (pinned.length < 1) return [];
  // An explicit account pin is already unambiguous; no model narrowing needed.
  if (String(requestedAccountRef || '').trim()) return pinned;
  return filterPoolByModel(pinned, state, requestJson && requestJson.model).pool;
}

// Only route away from the adapter when every candidate agrees, so a mixed pool
// keeps its current behaviour rather than silently changing protocol.
function shouldRouteCodexViaChatCompletions(params) {
  const candidates = resolveCodexWireApiCandidates(params);
  if (candidates.length < 1) return false;
  return candidates.every((account) => usesChatCompletionsWireApi(account));
}

module.exports = {
  resolveCodexWireApiCandidates,
  shouldRouteCodexViaChatCompletions
};
