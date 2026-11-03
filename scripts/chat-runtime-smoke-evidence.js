'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_STREAM_ERROR_KEYS = new Set(['error', 'message', 'retryable']);
const TIMELINE_LIFECYCLE_EVENTS = new Set([
  'timeline.item.started', 'timeline.item.updated', 'timeline.item.completed'
]);
const TURN_TERMINAL_EVENTS = new Set([
  'turn.completed', 'turn.failed', 'turn.interrupted'
]);
const PROVIDER_PRIVATE_IDENTITY_KEYS = new Set(['nativeSessionId', 'nativeTurnId']);
const PROVIDER_PRIVATE_KEYS = new Set([
  '_meta', 'approvalType', 'availableDecisions', 'choiceResponses', 'decision',
  'execpolicy_amendment', 'grant', 'isSecret', 'method', 'nativeRequest',
  'nativeRequestId', 'nativeThreadId', 'networkPolicyAmendments',
  'network_policy_amendment', 'paramKeys', 'permissions', 'questions',
  'providerTurnId', 'requestId', 'requestedSchema', 'responseKind', 'threadId'
]);

function summarizePrewarmEvidence(events = [], journal = [], journalStart = 0) {
  const eventTypes = events.map((event) => String(event && event.type || ''));
  const nativeMethods = journal.slice(journalStart).map((entry) => (
    String(entry && entry.method || '')
  ));
  return {
    verified: eventTypes.includes('runtime.prewarm.started')
      && eventTypes.includes('runtime.prewarm.ready')
      && !eventTypes.includes('runtime.prewarm.failed')
      && nativeMethods.includes('model/list'),
    eventTypes: eventTypes.filter((type) => type.startsWith('runtime.prewarm.')),
    nativeMethods
  };
}

function auditPublicProtocolBoundary(snapshot = {}, events = []) {
  const leaks = [];
  collectProviderPrivateKeys(snapshot.interactions, 'snapshot.interactions', leaks);
  collectProviderPrivateKeys(snapshot.queue, 'snapshot.queue', leaks);
  collectProviderPrivateKeys(snapshot.timeline, 'snapshot.timeline', leaks);
  collectMatchingKeys(
    snapshot.queue,
    'snapshot.queue',
    PROVIDER_PRIVATE_IDENTITY_KEYS,
    leaks
  );
  events.forEach((event, index) => {
    const eventPath = `events[${index}].payload`;
    collectProviderPrivateKeys(event && event.payload, eventPath, leaks);
    if (event && isPrivateIdentityCheckedEvent(event.type)) {
      collectMatchingKeys(
        event.payload,
        eventPath,
        PROVIDER_PRIVATE_IDENTITY_KEYS,
        leaks
      );
    }
    collectTimelineTurnMismatch(event, index, leaks);
    if (event && event.type === 'stream.error') {
      collectUnexpectedKeys(
        event.payload,
        PUBLIC_STREAM_ERROR_KEYS,
        `events[${index}].payload`,
        leaks
      );
    }
  });
  return {
    verified: leaks.length === 0,
    leakPaths: [...new Set(leaks)].sort().slice(0, 20)
  };
}

function isPrivateIdentityCheckedEvent(type) {
  return TURN_TERMINAL_EVENTS.has(type) || String(type || '').startsWith('queue.');
}

function collectProviderPrivateKeys(value, currentPath, leaks) {
  collectMatchingKeys(value, currentPath, PROVIDER_PRIVATE_KEYS, leaks);
}

function collectMatchingKeys(value, currentPath, keys, leaks) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectMatchingKeys(entry, `${currentPath}[${index}]`, keys, leaks);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${currentPath}.${key}`;
    if (keys.has(key)) leaks.push(entryPath);
    collectMatchingKeys(entry, entryPath, keys, leaks);
  }
}

function collectTimelineTurnMismatch(event, index, leaks) {
  if (!event || !TIMELINE_LIFECYCLE_EVENTS.has(event.type)) return;
  const eventTurnId = text(event.turnId);
  const itemTurnId = text(event.payload && event.payload.item && event.payload.item.turnId);
  if (eventTurnId && itemTurnId && eventTurnId !== itemTurnId) {
    leaks.push(`events[${index}].payload.item.turnId`);
  }
}

function collectUnexpectedKeys(value, allowed, currentPath, leaks) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    leaks.push(currentPath);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) leaks.push(`${currentPath}.${key}`);
  }
}

function findFilesContainingText(rootPath, value, fileSystem = fs) {
  const needle = Buffer.from(String(value || ''));
  if (needle.length === 0) throw new Error('smoke_secret_sentinel_required');
  return listFiles(rootPath, fileSystem).filter((filePath) => {
    const content = readSecretScanFile(fileSystem, filePath);
    return Buffer.from(content).includes(needle);
  }).map((filePath) => path.relative(rootPath, filePath));
}

function listFiles(rootPath, fileSystem) {
  const files = [];
  const visit = (currentPath) => {
    for (const entry of readSecretScanDirectory(fileSystem, currentPath)) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  visit(rootPath);
  return files;
}

function readSecretScanDirectory(fileSystem, directoryPath) {
  try {
    return fileSystem.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    throw secretScanError(error, 'readdir', directoryPath);
  }
}

function readSecretScanFile(fileSystem, filePath) {
  try {
    return fileSystem.readFileSync(filePath);
  } catch (error) {
    throw secretScanError(error, 'readFile', filePath);
  }
}

function secretScanError(cause, phase, targetPath) {
  const error = new Error('smoke_secret_scan_failed');
  error.code = 'smoke_secret_scan_failed';
  error.phase = phase;
  error.path = targetPath;
  error.cause = cause;
  return error;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  auditPublicProtocolBoundary,
  findFilesContainingText,
  summarizePrewarmEvidence
};
