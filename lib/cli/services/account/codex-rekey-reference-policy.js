'use strict';

const { transformJsonStrings } = require('./rekey-json');

const ACCOUNT_REF_PATTERN = /^acct_[a-f0-9]{20}$/;
const OPAQUE_HISTORY_KEYS = new Set([
  'content', 'input', 'instructions', 'message', 'output', 'reasoning', 'summary', 'text', 'prompt',
  'arguments', 'argumentText', 'commandText', 'stdout', 'stderr'
]);
// Human-facing diagnostics are not addresses. Rewriting an old accountRef
// quoted in an error would falsify the failure evidence. Objects under `error`
// are still traversed, so their typed account/path fields remain migratable.
// timeline-detail-contract.js validates shell/command.detail.command as the
// original command text. It is historical evidence, not a future launch spec.
const HISTORICAL_COMMAND_FIELDS = new Set(['command', 'args', 'patch', 'diff']);
const DISPLAY_TEXT_KEYS = new Set(['error', 'errorMessage', 'message', 'description', 'label', 'title', 'note', 'reason']);
const ACCOUNT_REF_KEYS = new Set([
  'account_ref', 'accountRef', 'desktopAccountRef', 'execution_account_ref',
  'executionAccountRef', 'gatewayAccountRef', 'runtimeScope', 'targetAccountRef',
  'sourceAccountRef', 'selectedAccountRef', 'defaultAccountRef', 'X-Account-Ref', 'x-account-ref',
  'AIH_PROVIDER_ACCOUNT_REF', 'AIH_CODEX_GATEWAY_ACCOUNT_REF'
]);
const PATH_KEYS = new Set([
  'codexHome', 'configDir', 'home', 'logPath', 'profileDir', 'runtimeDir', 'runtimeHome',
  'statePath', 'filePath', 'path', 'cwd', 'rootPath', 'configPath', 'authPath', 'workingDirectory',
  'CODEX_HOME', 'HOME', 'AIH_HOME', 'AIH_CODEX_HOST_HOME', 'outputPath'
]);
const RUNTIME_KEYS = new Set([
  'runtimeKey', 'runtimeId', 'socketName', 'socket', 'paneName', 'endpointKey',
  'launchKey', 'scopeKey', 'sessionRegistryKey', 'runtimeScope', 'name'
]);

function referenceNeedles(mapping) {
  return [...mapping.keys()].flatMap(ref => [ref, ref.replace('_', '')]);
}

function containsMappedRef(value, mapping) {
  return typeof value === 'string' && referenceNeedles(mapping).some(ref => value.includes(ref));
}

/** Only complete path components in known runtime namespaces are renamed. */
function replaceAccountPathSegments(value, mapping) {
  return value.split(/([\\/])/).map(component => {
    if (mapping.has(component)) return mapping.get(component);
    for (const [before, after] of mapping) {
      if (component === `${before}.json`) return `${after}.json`;
      if (component === `chat-${before}.json`) return `chat-${after}.json`;
      if (component === `chat-${before}`) return `chat-${after}`;
      if (component === `${before}.auth`) return `${after}.auth`;
    }
    return component;
  }).join('');
}

function replaceRuntimeKey(value, mapping) {
  // These composite names are produced by persistent-session/runtime endpoint
  // registries. This is deliberately not a global substring replacement.
  for (const [before, after] of mapping) {
    for (const prefix of ['aih-codexapp-', 'aih-codexchat-']) {
      if (value === prefix + before.replace('_', '')) return prefix + after.replace('_', '');
    }
  }
  return value.split(/([-:/])/).map(part => mapping.get(part) || part).join('');
}

function transformJsonText(text, mapping, options = {}) {
  const immutable = [];
  const unknown = [];
  try {
    const transformed = transformJsonStrings(text, (value, trail, context) => {
      if (!containsMappedRef(value, mapping)) return value;
      const location = ['$'].concat(trail).join('.');
      if ((!context.isKey && DISPLAY_TEXT_KEYS.has(trail.at(-1)))
        || (options.preserveHistory !== false && trail.some(key => OPAQUE_HISTORY_KEYS.has(key)))
        || (options.eventHistory === true && trail.some(key => HISTORICAL_COMMAND_FIELDS.has(key)))) {
        immutable.push({ location, reason: 'opaque_history_content' });
        return value;
      }
      if (mapping.has(value)) return mapping.get(value);
      const key = trail.at(-1);
      let next = value;
      if (context.isKey) next = value.split(':').map(part => mapping.get(part) || part).join(':');
      else if (PATH_KEYS.has(key) || (typeof key === 'string' && /(?:_path|_dir)$/.test(key))) {
        next = replaceAccountPathSegments(value, mapping);
      } else if (RUNTIME_KEYS.has(key)) next = replaceRuntimeKey(value, mapping);
      if (containsMappedRef(next, mapping)) unknown.push({ location, reason: 'untyped_machine_reference' });
      return next;
    });
    return { ...transformed, immutable, unknown };
  } catch (error) {
    return { text, changed: false, immutable: [], unknown: [{ location: '$', reason: error.message }] };
  }
}

function classifyDatabaseText(table, column, value, mapping) {
  if (!containsMappedRef(value, mapping)) return { kind: 'none', value };
  if (table === 'model_usage_records' && column === 'event_key') {
    // model-usage-store.js uses event_key only for UNIQUE insert deduplication,
    // never to select a current account. Existing event provenance is immutable;
    // the separate account_ref column is migrated and totals must stay equal.
    return { kind: 'immutable', value, reason: 'usage_event_idempotency_key' };
  }
  if (mapping.has(value)) return { kind: 'rewrite', value: mapping.get(value) };
  if (column === 'key' && table === 'app_kv') {
    const next = value.split(':').map(part => mapping.get(part) || part).join(':');
    return containsMappedRef(next, mapping)
      ? { kind: 'unknown', value, reason: 'unknown_app_kv_key_reference' }
      : { kind: 'rewrite', value: next };
  }
  if (column.endsWith('_json') || (table === 'app_kv' && column === 'value')) {
    const transformed = transformJsonText(value, mapping, {
      preserveHistory: table.startsWith('chat_runtime_'),
      eventHistory: table === 'chat_runtime_events' && column === 'payload_json'
    });
    if (transformed.unknown.length) return { kind: 'unknown', value, details: transformed.unknown };
    return {
      kind: transformed.changed ? 'rewrite' : 'immutable', value: transformed.text,
      reason: transformed.changed ? undefined : 'opaque_history_content', immutable: transformed.immutable
    };
  }
  return { kind: 'unknown', value, reason: 'untyped_machine_reference' };
}

module.exports = {
  ACCOUNT_REF_PATTERN, ACCOUNT_REF_KEYS, OPAQUE_HISTORY_KEYS, PATH_KEYS,
  classifyDatabaseText, containsMappedRef, replaceAccountPathSegments,
  replaceRuntimeKey, transformJsonText, referenceNeedles
};
