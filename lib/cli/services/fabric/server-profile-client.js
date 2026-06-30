'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listControlPlaneProfiles
} = require('../../../server/control-plane-profile-store');
const {
  resolveHostHomeDir
} = require('../../../runtime/host-home');

const DEFAULT_TIMEOUT_MS = 10000;

function createError(code, message, detail = '') {
  const error = new Error(message || code);
  error.code = code;
  error.detail = detail;
  return error;
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) throw createError('invalid_option', `${flag} requires a value`);
  return { value: String(value), consumed: 2 };
}

function normalizeText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function resolveLocalPath(value) {
  const raw = normalizeText(value, 2048);
  return path.resolve(raw.replace(/^~(?=\/|$)/, process.env.HOME || ''));
}

function resolveDefaultAiHomeDir(env = process.env) {
  const hostHomeDir = resolveHostHomeDir({
    env,
    platform: process.platform,
    os
  });
  return path.join(hostHomeDir, '.ai_home');
}

function normalizeHttpEndpoint(value, flag = '--endpoint') {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid_protocol');
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw createError('invalid_endpoint', `${flag} must be a valid http(s) URL`);
  }
}

function normalizeOptionalHttpEndpoint(value, flag = '--endpoint') {
  const raw = normalizeText(value, 2048);
  return raw ? normalizeHttpEndpoint(raw, flag) : '';
}

function parsePositiveInteger(value, flag, fallback, min = 1, max = 240000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createError('invalid_option', `${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function isReadyProfile(profile) {
  return profile
    && profile.state === 'paired'
    && profile.authState === 'paired'
    && Boolean(normalizeText(profile.deviceToken, 4096));
}

function selectReadyProfile(store, options = {}) {
  const profiles = Array.isArray(store && store.profiles) ? store.profiles : [];
  const endpoint = normalizeOptionalHttpEndpoint(options.endpoint || '', '--endpoint');
  const profileId = normalizeText(options.profileId, 96);
  const readyProfiles = profiles.filter(isReadyProfile);

  let profile = null;
  if (profileId) {
    profile = readyProfiles.find((item) => item.id === profileId) || null;
  } else if (endpoint) {
    profile = readyProfiles.find((item) => item.id === store.activeProfileId && item.endpoint === endpoint)
      || readyProfiles.find((item) => item.endpoint === endpoint)
      || null;
  } else {
    profile = readyProfiles.find((item) => item.id === store.activeProfileId)
      || readyProfiles[0]
      || null;
  }

  if (!profile) {
    throw createError(
      'ready_server_profile_missing',
      'No ready server profile found',
      profileId ? `profileId=${profileId}` : (endpoint ? `endpoint=${endpoint}` : 'activeProfileId')
    );
  }
  return profile;
}

function loadControlPlaneProfileStore(options = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  return (deps.listControlPlaneProfiles || listControlPlaneProfiles)({
    fs: fsImpl,
    aiHomeDir: options.aiHomeDir
  });
}

function buildProfileSummary(profile) {
  return {
    id: profile.id,
    name: profile.name,
    endpoint: profile.endpoint,
    connectionMode: profile.connectionMode,
    authState: profile.authState,
    deviceTokenPresent: Boolean(profile.deviceToken)
  };
}

async function fetchJson(url, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  if (typeof fetchImpl !== 'function') throw createError('fetch_unavailable', 'fetch is unavailable');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = parsePositiveInteger(options.timeoutMs, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      method: normalizeText(options.method, 16).toUpperCase() || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller ? controller.signal : undefined
    });
    let body = null;
    try {
      body = response && typeof response.json === 'function' ? await response.json() : null;
    } catch (_error) {
      body = null;
    }
    return {
      status: Number(response && response.status || 0),
      ok: Boolean(response && response.ok),
      body
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutCode = normalizeText(options.timeoutCode, 96) || 'fabric_profile_request_timeout';
      throw createError(timeoutCode, `request timed out after ${timeoutMs}ms`, url);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  buildProfileSummary,
  createError,
  fetchJson,
  isFlag,
  isReadyProfile,
  loadControlPlaneProfileStore,
  normalizeHttpEndpoint,
  normalizeOptionalHttpEndpoint,
  normalizeText,
  parsePositiveInteger,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath,
  selectReadyProfile
};
