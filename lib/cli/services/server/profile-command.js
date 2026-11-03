'use strict';

const {
  listControlPlaneProfiles,
  removeControlPlaneProfile,
  saveControlPlaneProfile,
  setActiveControlPlaneProfile
} = require('../../../server/control-plane-profile-store');

function createError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function normalizeText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEndpoint(value) {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  if (!raw) throw createError('missing_server_url', 'server URL is required');
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_protocol');
    parsed.hash = '';
    parsed.search = '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = pathname === '/ui'
      ? '/'
      : pathname.endsWith('/ui')
        ? pathname.slice(0, -3) || '/'
        : parsed.pathname;
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw createError('invalid_server_url', 'server URL must be a valid http(s) URL');
  }
}

function readValue(args, index, flag) {
  const token = String(args[index] || '');
  const inlinePrefix = `${flag}=`;
  if (token.startsWith(inlinePrefix)) {
    return { value: token.slice(inlinePrefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || String(value).startsWith('-')) {
    throw createError('missing_option_value', `${flag} requires a value`);
  }
  return { value: String(value), consumed: 2 };
}

function parseAddArgs(args) {
  const options = {
    name: '',
    endpoint: '',
    managementKey: '',
    json: false
  };
  for (let index = 0; index < args.length;) {
    const token = String(args[index] || '');
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--url' || token.startsWith('--url=') || token === '--endpoint' || token.startsWith('--endpoint=')) {
      const flag = token.startsWith('--endpoint') ? '--endpoint' : '--url';
      const next = readValue(args, index, flag);
      options.endpoint = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readValue(args, index, '--management-key');
      options.managementKey = next.value;
      index += next.consumed;
      continue;
    }
    if (token.startsWith('-')) throw createError('unknown_option', `unknown option: ${token}`);
    if (options.name) throw createError('too_many_arguments', 'server add accepts one optional name');
    options.name = token;
    index += 1;
  }
  options.endpoint = normalizeEndpoint(options.endpoint);
  options.managementKey = normalizeText(options.managementKey, 4096);
  if (!options.managementKey) {
    throw createError('missing_management_key', '--management-key is required');
  }
  options.name = normalizeText(options.name, 120) || options.endpoint;
  return options;
}

function parseSimpleArgs(args, action) {
  const options = { target: '', json: false };
  for (const value of args) {
    const token = String(value || '');
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token.startsWith('-')) throw createError('unknown_option', `unknown option: ${token}`);
    if (options.target) throw createError('too_many_arguments', `server ${action} accepts one target`);
    options.target = normalizeText(token, 2048);
  }
  if ((action === 'use' || action === 'remove') && !options.target) {
    throw createError('missing_server_target', `server ${action} requires an id, name, or URL`);
  }
  return options;
}

function profileDeps(deps) {
  return {
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir
  };
}

function sanitizeProfile(profile, activeProfileId = '') {
  return {
    id: profile.id,
    name: profile.name,
    endpoint: profile.endpoint,
    state: profile.state,
    active: profile.id === activeProfileId,
    managementKeyConfigured: Boolean(normalizeText(profile.managementKey, 4096)),
    lastError: normalizeText(profile.lastError, 512)
  };
}

function findProfile(store, target) {
  const normalizedTarget = normalizeText(target, 2048).replace(/\/+$/, '');
  return store.profiles.find((profile) => {
    return profile.id === normalizedTarget
      || profile.name === normalizedTarget
      || profile.endpoint.replace(/\/+$/, '') === normalizedTarget;
  }) || null;
}

function listProfiles(deps) {
  const store = listControlPlaneProfiles(profileDeps(deps));
  return {
    ok: true,
    activeProfileId: store.activeProfileId,
    profiles: store.profiles.map((profile) => sanitizeProfile(profile, store.activeProfileId))
  };
}

function addProfile(args, deps) {
  const options = parseAddArgs(args);
  const result = saveControlPlaneProfile({
    name: options.name,
    endpoint: options.endpoint,
    managementKey: options.managementKey,
    state: 'ready',
    lastError: ''
  }, { active: true }, profileDeps(deps));
  return {
    ok: true,
    json: options.json,
    action: 'add',
    profile: sanitizeProfile(result.profile, result.store.activeProfileId)
  };
}

function useProfile(args, deps) {
  const options = parseSimpleArgs(args, 'use');
  const store = listControlPlaneProfiles(profileDeps(deps));
  const profile = findProfile(store, options.target);
  if (!profile) throw createError('server_not_found', `server not found: ${options.target}`);
  const nextStore = setActiveControlPlaneProfile(profile.id, profileDeps(deps));
  return {
    ok: true,
    json: options.json,
    action: 'use',
    profile: sanitizeProfile(profile, nextStore.activeProfileId)
  };
}

function removeProfile(args, deps) {
  const options = parseSimpleArgs(args, 'remove');
  const store = listControlPlaneProfiles(profileDeps(deps));
  const profile = findProfile(store, options.target);
  if (!profile) throw createError('server_not_found', `server not found: ${options.target}`);
  const nextStore = removeControlPlaneProfile(profile.id, profileDeps(deps));
  return {
    ok: true,
    json: options.json,
    action: 'remove',
    removed: sanitizeProfile(profile),
    activeProfileId: nextStore.activeProfileId
  };
}

function runServerProfileCommand(action, args = [], deps = {}) {
  if (action === 'add') return addProfile(args, deps);
  if (action === 'ls' || action === 'list') {
    const options = parseSimpleArgs(args, 'ls');
    if (options.target) throw createError('too_many_arguments', 'server ls does not accept a target');
    return { ...listProfiles(deps), json: options.json, action: 'list' };
  }
  if (action === 'use') return useProfile(args, deps);
  if (action === 'remove' || action === 'rm') return removeProfile(args, deps);
  throw createError('unknown_server_profile_action', `unknown server profile action: ${action}`);
}

function formatServerProfileResult(result) {
  if (result.action === 'list') {
    if (result.profiles.length === 0) return '[aih] no saved servers';
    return result.profiles.map((profile) => {
      const marker = profile.active ? '*' : ' ';
      const key = profile.managementKeyConfigured ? 'key=configured' : 'key=missing';
      return `${marker} ${profile.name}  ${profile.endpoint}  ${profile.state}  ${key}`;
    }).join('\n');
  }
  const profile = result.profile || result.removed;
  return `[aih] server ${result.action}: ${profile.name} (${profile.endpoint})`;
}

module.exports = {
  formatServerProfileResult,
  parseAddArgs,
  runServerProfileCommand,
  sanitizeProfile
};
