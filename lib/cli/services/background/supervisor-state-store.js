'use strict';

const BACKGROUND_SUPERVISOR_SCHEMA_VERSION = 1;
const BACKGROUND_SUPERVISOR_STATE_FILE = 'background-supervisor.json';
const SECRET_NAME_SEGMENTS = new Set([
  'auth',
  'authorization',
  'credential',
  'credentials',
  'key',
  'password',
  'secret',
  'signature',
  'token'
]);
const COMPACT_SECRET_NAMES = new Set([
  'accesstoken',
  'apikey',
  'clientkey',
  'idtoken',
  'managementkey',
  'refreshtoken',
  'sessiontoken'
]);

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function emptyState() {
  return {
    schemaVersion: BACKGROUND_SUPERVISOR_SCHEMA_VERSION,
    components: {}
  };
}

function createStateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sensitiveName(value) {
  const normalized = String(value || '')
    .replace(/^--/, '')
    .split('=', 1)[0]
    .toLowerCase();
  const segments = normalized.split(/[-_.]+/).filter(Boolean);
  if (segments.some((segment) => SECRET_NAME_SEGMENTS.has(segment))) return true;
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  return COMPACT_SECRET_NAMES.has(compact)
    || /(?:token|secret|password|credential|credentials|authorization|signature)$/.test(compact);
}

function urlContainsSecret(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (_error) {
    return false;
  }
  if (parsed.username || parsed.password) return true;
  return Array.from(parsed.searchParams.keys()).some((name) => sensitiveName(name));
}

function embeddedUrlContainsSecret(value) {
  const token = String(value || '').trim();
  const urlStartPattern = /[a-z][a-z0-9+.-]*:\/\//gi;
  let match = urlStartPattern.exec(token);
  while (match) {
    if (urlContainsSecret(token.slice(match.index))) return true;
    match = urlStartPattern.exec(token);
  }
  return false;
}

function embeddedValueContainsSecretAssignment(value) {
  const token = String(value || '');
  const assignmentPattern = /(?:^|[^a-z0-9_.-])([a-z][a-z0-9_.-]*)\s*=/gi;
  let match = assignmentPattern.exec(token);
  while (match) {
    if (sensitiveName(match[1])) return true;
    match = assignmentPattern.exec(token);
  }
  return false;
}

function hasSecretBearingArgument(args) {
  return (Array.isArray(args) ? args : []).some((item) => {
    const token = String(item || '').trim().toLowerCase();
    return (token.startsWith('--') && sensitiveName(token))
      || embeddedValueContainsSecretAssignment(token)
      || embeddedUrlContainsSecret(token);
  });
}

function normalizeComponent(component) {
  const id = nonEmptyString(component && component.id);
  if (!id) return null;
  if (!Array.isArray(component.args) || component.args.some((item) => typeof item !== 'string')) {
    return null;
  }
  const args = component.args.slice();
  if (args.length === 0 || hasSecretBearingArgument(args)) return null;
  return {
    id,
    args
  };
}

function normalizeState(value, options = {}) {
  const failClosed = Boolean(options.failClosed);
  const state = emptyState();
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  const components = isObject
    && value.components
    && typeof value.components === 'object'
    && !Array.isArray(value.components)
    ? value.components
    : null;
  if (!components
    || (failClosed && value.schemaVersion !== BACKGROUND_SUPERVISOR_SCHEMA_VERSION)) {
    if (failClosed) throw createStateError('background_supervisor_state_invalid');
    return state;
  }
  for (const [storedId, candidate] of Object.entries(components)) {
    const component = normalizeComponent(candidate);
    if (!component || (failClosed && storedId !== component.id)) {
      if (failClosed) throw createStateError('background_supervisor_state_invalid');
      continue;
    }
    state.components[component.id] = component;
  }
  return state;
}

function resolveStateContext(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const path = deps.path || require('node:path');
  const aiHomeDir = nonEmptyString(deps.aiHomeDir);
  if (!aiHomeDir) {
    const error = new Error('AIH_HOME is required for background supervisor state');
    error.code = 'background_supervisor_home_required';
    throw error;
  }
  return {
    fs,
    path,
    aiHomeDir,
    stateFile: path.join(aiHomeDir, 'run', BACKGROUND_SUPERVISOR_STATE_FILE)
  };
}

function readBackgroundSupervisorState(deps = {}) {
  const { fs, stateFile } = resolveStateContext(deps);
  let exists;
  try {
    exists = fs.existsSync(stateFile);
  } catch (_error) {
    throw createStateError('background_supervisor_state_read_failed');
  }
  if (!exists) return emptyState();

  let serialized;
  try {
    serialized = fs.readFileSync(stateFile, 'utf8');
  } catch (_error) {
    throw createStateError('background_supervisor_state_read_failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (_error) {
    throw createStateError('background_supervisor_state_invalid');
  }
  return normalizeState(parsed, { failClosed: true });
}

function writeBackgroundSupervisorState(value, deps = {}) {
  const { fs, path, stateFile } = resolveStateContext(deps);
  const state = normalizeState(value, { failClosed: true });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporaryFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, stateFile);
  } finally {
    try { fs.unlinkSync(temporaryFile); } catch (_error) {}
  }
  return state;
}

function upsertBackgroundComponent(component, deps = {}) {
  const normalized = normalizeComponent(component);
  if (!normalized) {
    const error = new Error('valid background component is required');
    error.code = 'invalid_background_component';
    throw error;
  }
  const state = readBackgroundSupervisorState(deps);
  state.components[normalized.id] = normalized;
  return writeBackgroundSupervisorState(state, deps);
}

function removeBackgroundComponent(id, deps = {}) {
  const state = readBackgroundSupervisorState(deps);
  delete state.components[nonEmptyString(id)];
  return writeBackgroundSupervisorState(state, deps);
}

function listEffectiveBackgroundComponents(value) {
  const state = normalizeState(value);
  const components = Object.values(state.components);
  if (components.length === 0) return [];
  const server = {
    id: 'server',
    args: ['server', 'serve']
  };
  return [
    server,
    ...components.filter((component) => component.id !== 'server')
  ];
}

module.exports = {
  BACKGROUND_SUPERVISOR_SCHEMA_VERSION,
  BACKGROUND_SUPERVISOR_STATE_FILE,
  hasSecretBearingArgument,
  listEffectiveBackgroundComponents,
  readBackgroundSupervisorState,
  removeBackgroundComponent,
  upsertBackgroundComponent,
  writeBackgroundSupervisorState
};
