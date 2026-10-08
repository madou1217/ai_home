'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { readNodeAccounts } = require('../account/go-bridge/node-account-reader');
const { inspectCodebuddyCredential } = require('../account/codebuddy-credential-source');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { getDatabaseSyncCtor } = require('./session-reader-utils');

const IDE_PROVIDERS = new Set(['codebuddy', 'codebuddycn']);
const ID = /^[a-f0-9]{32}$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

// Matches the official IDE FilePathServiceImpl.getBasePath on each platform.
function extensionDataRoot(home, path, platform) {
  const parts = platform === 'darwin' ? ['Library', 'Application Support']
    : platform === 'win32' ? ['AppData', 'Local'] : ['.local', 'share'];
  return path.join(home, ...parts, 'CodeBuddyExtension', 'Data');
}

function readJson(fs, file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) return null;
    if (fs.realpathSync(file) !== file) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

function nativeTime(value) {
  const at = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isSafeInteger(at) && at > 0 ? at : 0;
}

function readIdeMetadata(home, { fs, path, DatabaseSync }) {
  if (!DatabaseSync) return new Map();
  let db;
  try {
    const file = path.join(home, 'electron-user-data', 'codebuddy-sessions.vscdb');
    if (fs.realpathSync(file) !== file) return new Map();
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key GLOB 'session:*'").all();
    return new Map(rows.flatMap(row => {
      try {
        const entry = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
        return ID.test(entry.conversationId) ? [[entry.conversationId, entry]] : [];
      } catch (_) { return []; }
    }));
  } catch (_) { return new Map(); }
  finally { try { db?.close(); } catch (_) {} }
}

// The IDE stores request totals and message files separately from the CLI's
// JSONL. Only the observed CodeBuddyIDE store is read; auth/cache trees are not.
function discoverCodebuddyIdeRoots(options = {}) {
  const fs = options.fs || nodeFs, path = options.path || nodePath;
  const aiHomeDir = options.aiHomeDir || (options.hostHomeDir && path.join(options.hostHomeDir, '.ai_home'));
  if (!aiHomeDir) return [];
  let accounts;
  try { accounts = options.accounts || readNodeAccounts(aiHomeDir, { fs }).accounts; } catch (_) { return []; }
  const providers = new Set(options.providers || ['codebuddy', 'codebuddycn']);
  const sources = [];
  for (const account of accounts) {
    if (!IDE_PROVIDERS.has(account.provider)
      || ![...providers].some(provider => provider.endsWith('cn') === account.provider.endsWith('cn'))) continue;
    const identity = inspectCodebuddyCredential(account.nativeAuth?.credentials, account.provider);
    if (!identity.ok || !/^[A-Za-z0-9_-]+$/.test(identity.uid)) continue;
    const homes = [resolveAccountRuntimeDir(aiHomeDir, account.provider, account.accountRef)];
    if (options.hostHomeDir) homes.push(options.hostHomeDir);
    for (const home of homes) sources.push({ home, provider: account.provider, accountRef: account.accountRef, userId: identity.uid });
  }
  const roots = [];
  for (const source of sources) {
    const root = path.join(extensionDataRoot(source.home, path, options.platform || process.platform),
      source.userId, 'CodeBuddyIDE', source.userId, 'history');
    try {
      if (source.home !== options.hostHomeDir) {
        const expectedHome = path.join(fs.realpathSync(aiHomeDir), path.relative(aiHomeDir, source.home));
        if (fs.realpathSync(source.home) !== expectedHome) continue;
      }
      // An account projection cannot borrow another account's private history.
      const expected = path.join(fs.realpathSync(source.home), path.relative(source.home, root));
      if (fs.realpathSync(root) !== expected) continue;
      if (fs.statSync(root).isDirectory()) roots.push({ ...source, root });
    } catch (_) { /* A client that has never created an IDE chat has no store. */ }
  }
  return roots;
}

function discoverCodebuddyIdeSessions(options = {}) {
  const fs = options.fs || nodeFs, path = options.path || nodePath;
  const sessions = [];
  const seen = new Set();
  for (const source of discoverCodebuddyIdeRoots(options)) {
    const root = source.root;
    try {
      const metadata = readIdeMetadata(source.home, { fs, path, DatabaseSync: options.DatabaseSync || getDatabaseSyncCtor() });
      for (const project of fs.readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory() || !ID.test(project.name)) continue;
        const projectRoot = path.join(root, project.name);
        const projectIndex = readJson(fs, path.join(projectRoot, 'index.json'));
        const titles = new Map((Array.isArray(projectIndex?.conversations) ? projectIndex.conversations : [])
          .filter(row => ID.test(row?.id)).map(row => [row.id, row]));
        for (const directory of fs.readdirSync(projectRoot, { withFileTypes: true })) {
          if (!directory.isDirectory() || !ID.test(directory.name)
            || options.sessionId && directory.name !== options.sessionId) continue;
          const indexPath = path.join(projectRoot, directory.name, 'index.json');
          const key = `${indexPath}:${source.provider}:${source.accountRef}`;
          if (seen.has(key) || !fs.existsSync(indexPath)) continue;
          seen.add(key);
          const native = metadata.get(directory.name);
          if (native?.userId && native.userId !== source.userId) continue;
          const title = titles.get(directory.name);
          sessions.push({ ...source, sessionId: directory.name, indexPath,
            projectDirName: `ide-${project.name}`, cwd: String(native?.cwd || ''),
            title: String(native?.title || title?.name || ''),
            updatedAt: Math.max(nativeTime(native?.updatedAt), nativeTime(title?.lastMessageAt)),
            createdAt: nativeTime(native?.createdAt) || nativeTime(title?.createdAt) });
        }
      }
    } catch (_) { /* An absent or concurrently replaced store is retried later. */ }
  }
  return sessions;
}

function readCodebuddyIdeSession(session, options = {}) {
  const fs = options.fs || nodeFs, path = options.path || nodePath;
  const index = readJson(fs, session.indexPath);
  if (!index || !Array.isArray(index.messages) || !Array.isArray(index.requests)) return null;
  const messages = new Map();
  for (const reference of index.messages) {
    if (!ID.test(reference?.id)) continue;
    const file = path.join(path.dirname(session.indexPath), 'messages', `${reference.id}.json`);
    try { if (fs.realpathSync(file) !== file) continue; } catch (_) { continue; }
    const message = readJson(fs, file);
    if (!message || message.id !== reference.id || !['user', 'assistant'].includes(message.role)) continue;
    let extra = {};
    try { extra = JSON.parse(message.extra); } catch (_) {}
    messages.set(message.id, { ...message, extra, complete: reference.isComplete === true,
      timestampMs: nativeTime(message.createdAt) });
  }
  return { messages, requests: index.requests };
}

module.exports = { discoverCodebuddyIdeRoots, discoverCodebuddyIdeSessions, readCodebuddyIdeSession, nativeTime };
