'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { isAccountRef } = require('../account/public-account-ref');

const AIH_ZCODE_USAGE_OWNER_LOG_ENV = 'AIH_ZCODE_USAGE_OWNER_LOG';
const GLOBAL_RECORD_FUNCTION = '__aihRecordZcodeUsageOwner';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

function patchZcodeUsageSource(source) {
  if (source.includes(`globalThis.${GLOBAL_RECORD_FUNCTION}`)) return source;
  const pattern = /\b[A-Za-z_$][\w$]*\(\s*([A-Za-z_$][\w$]*)\s*,\s*["']recordModelUsage["']\s*\)/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('zcode_usage_writer_marker_unavailable');
  const match = matches[0];
  const name = match[1];
  // Decorate the named persistence function after its successful commit. The
  // original arguments, return value, errors, and SQLite contents are unchanged.
  const replacement = `(()=>{${match[0]};const __aihOriginal=${name};${name}=async function(...__aihArgs){`
    + 'const __aihResult=await __aihOriginal.apply(this,__aihArgs);'
    + `if(globalThis.${GLOBAL_RECORD_FUNCTION})globalThis.${GLOBAL_RECORD_FUNCTION}(__aihArgs[1]);`
    + 'return __aihResult};return ' + name + '})()';
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function installZcodeUsageOwnerRecorder({ accountRef, logPath, fs = nodeFs, path = nodePath,
  globalObject = globalThis, warn = () => {} }) {
  if (!isAccountRef(accountRef) || !path.isAbsolute(logPath)) return false;
  let warned = false;
  globalObject[GLOBAL_RECORD_FUNCTION] = (usage) => {
    if (!usage || typeof usage.id !== 'string' || typeof usage.sessionID !== 'string'
      || !ID.test(usage.id) || !ID.test(usage.sessionID)
      || !Number.isSafeInteger(usage.startedAt) || usage.startedAt <= 0) return;
    const completedAtMs = Number.isSafeInteger(usage.completedAt) && usage.completedAt > 0 ? usage.completedAt : 0;
    const record = { version: 1, accountRef, usageId: usage.id, sessionId: usage.sessionID,
      startedAtMs: usage.startedAt, timestampMs: completedAtMs || usage.startedAt };
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      // Only metadata is persisted. Do not project prompts, credentials, or raw
      // provider payloads into the account ownership index.
      fs.appendFileSync(logPath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (_) {
      if (!warned) { warned = true; warn('zcode_usage_owner_write_failed'); }
    }
  };
  return true;
}

module.exports = { AIH_ZCODE_USAGE_OWNER_LOG_ENV, installZcodeUsageOwnerRecorder, patchZcodeUsageSource };
