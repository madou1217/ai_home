'use strict';

// Persistent-session registry: the on-disk "RDB" for tmux/psmux sessions.
//
// The tmux server is a purely in-memory process — a machine reboot destroys
// every aih persistent session and, without this registry, even the knowledge
// that they existed. Each launch therefore records one small JSON file per
// session under $AIH_HOME/run/persistent-sessions/. After a reboot the restore engine
// (lib/cli/services/ai-cli/persistent-session-restore.js) reconciles these
// entries against the live tmux servers and re-creates the dead ones detached,
// with provider-native resume args so the conversation continues.
//
// The registry stores addressing metadata ONLY (provider/accountRef/socket/
// session/cwd/label/forward-args). It never stores credentials, and it does
// not need an append-only log: entries are tiny and rewritten whole.

const fs = require('fs');
const path = require('path');
const { isAccountRef } = require('../account/public-account-ref');
const { GATEWAY_RUNTIME_SCOPE } = require('../account/runtime-target');
const { resolveAihRunPath } = require('./aih-storage-layout');

const REGISTRY_SUBDIR = path.join('run', 'persistent-sessions');
const UNRECOVERABLE_REASONS = Object.freeze(['cwd-missing']);

function registryDir(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? resolveAihRunPath(root, 'persistent-sessions') : '';
}

function isSafeEntryKeyPart(value) {
  return /^[A-Za-z0-9._-]+$/.test(String(value || '').trim());
}

// One file per (socket, session). Both parts are already filename-safe by
// construction (deriveSocket sanitises, session names pass isSafeSessionName),
// but reject anything else outright rather than escaping.
function entryFileName(socket, session) {
  const socketPart = String(socket || '').trim();
  const sessionPart = String(session || '').trim();
  if (!isSafeEntryKeyPart(socketPart) || !isSafeEntryKeyPart(sessionPart)) return '';
  return `${socketPart}--${sessionPart}.json`;
}

function entryFilePath(aiHomeDir, socket, session) {
  const dir = registryDir(aiHomeDir);
  const file = entryFileName(socket, session);
  return dir && file ? path.join(dir, file) : '';
}

function readEntryFile(filePath, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeEntry(raw = {}) {
  return {
    provider: String(raw.provider || '').trim(),
    runtimeScope: String(raw.runtimeScope || '').trim(),
    gateway: raw.gateway === true,
    accountRef: String(raw.accountRef || '').trim(),
    socket: String(raw.socket || '').trim(),
    session: String(raw.session || '').trim(),
    cwd: String(raw.cwd || '').trim(),
    label: String(raw.label || '').trim(),
    forwardArgs: Array.isArray(raw.forwardArgs) ? raw.forwardArgs.map((a) => String(a)) : [],
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    unrecoverable: String(raw.unrecoverable || '').trim()
  };
}

function isUsableEntry(entry) {
  const baseValid = Boolean(
    entry
    && entry.provider
    && entry.socket
    && entry.session
    && entryFileName(entry.socket, entry.session)
  );
  if (!baseValid) return false;
  if (entry.gateway) {
    return entry.runtimeScope === GATEWAY_RUNTIME_SCOPE
      && !entry.accountRef;
  }
  return isAccountRef(entry.accountRef)
    && entry.runtimeScope === entry.accountRef;
}

// Record (or refresh) a session at launch time. Preserves createdAt across
// rewrites so "how old is this session" survives reattach/takeover updates.
function writeEntry(aiHomeDir, rawEntry = {}, options = {}) {
  const fsImpl = options.fs || fs;
  const now = Number(options.now) || Date.now();
  const entry = normalizeEntry(rawEntry);
  if (!isUsableEntry(entry)) return null;
  const filePath = entryFilePath(aiHomeDir, entry.socket, entry.session);
  if (!filePath) return null;
  try {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const existing = normalizeEntry(readEntryFile(filePath, fsImpl) || {});
    entry.createdAt = existing.createdAt || now;
    entry.updatedAt = now;
    // A session that is being launched again is recoverable by definition.
    entry.unrecoverable = '';
    fsImpl.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    return entry;
  } catch (_error) {
    return null;
  }
}

// Mark an entry as seen-alive without touching its launch metadata. Restores
// and `aih ss` reconciliation call this so updatedAt reflects "last confirmed
// alive", which is what disambiguates reboot-killed sessions from sessions
// that simply ended during the current boot.
function touchEntry(aiHomeDir, socket, session, options = {}) {
  const fsImpl = options.fs || fs;
  const now = Number(options.now) || Date.now();
  const filePath = entryFilePath(aiHomeDir, socket, session);
  if (!filePath) return false;
  const existing = readEntryFile(filePath, fsImpl);
  if (!existing) return false;
  try {
    existing.updatedAt = now;
    fsImpl.writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

function markEntryUnrecoverable(aiHomeDir, socket, session, reason, options = {}) {
  const fsImpl = options.fs || fs;
  const filePath = entryFilePath(aiHomeDir, socket, session);
  if (!filePath) return false;
  const existing = readEntryFile(filePath, fsImpl);
  if (!existing) return false;
  try {
    existing.unrecoverable = String(reason || 'unknown').trim();
    fsImpl.writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

function removeEntry(aiHomeDir, socket, session, options = {}) {
  const fsImpl = options.fs || fs;
  const filePath = entryFilePath(aiHomeDir, socket, session);
  if (!filePath) return false;
  try {
    fsImpl.unlinkSync(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function removeEntriesForSocket(aiHomeDir, socket, options = {}) {
  const targetSocket = String(socket || '').trim();
  if (!targetSocket) return 0;
  let removed = 0;
  for (const entry of listEntries(aiHomeDir, options)) {
    if (entry.socket !== targetSocket) continue;
    if (removeEntry(aiHomeDir, entry.socket, entry.session, options)) removed += 1;
  }
  return removed;
}

function listEntries(aiHomeDir, options = {}) {
  const fsImpl = options.fs || fs;
  const dir = registryDir(aiHomeDir);
  if (!dir) return [];
  let files = [];
  try {
    files = fsImpl.readdirSync(dir);
  } catch (_error) {
    return [];
  }
  const entries = [];
  for (const file of files) {
    if (!/\.json$/.test(file) || file.startsWith('.')) continue;
    const entry = normalizeEntry(readEntryFile(path.join(dir, file), fsImpl) || {});
    if (isUsableEntry(entry)) entries.push(entry);
  }
  return entries;
}

module.exports = {
  REGISTRY_SUBDIR,
  UNRECOVERABLE_REASONS,
  registryDir,
  entryFileName,
  entryFilePath,
  writeEntry,
  touchEntry,
  markEntryUnrecoverable,
  removeEntry,
  removeEntriesForSocket,
  listEntries
};
