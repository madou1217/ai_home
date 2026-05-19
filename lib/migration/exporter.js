'use strict';

const DEFAULT_CONFLICT_POLICY = 'skip';
const SUPPORTED_CONFLICT_POLICIES = new Set(['skip', 'overwrite', 'report']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function defaultExportName(dateLike) {
  const current = dateLike instanceof Date ? dateLike : new Date();
  const stamp = `${current.getFullYear()}${pad2(current.getMonth() + 1)}${pad2(current.getDate())}${pad2(current.getHours())}${pad2(current.getMinutes())}`;
  return `ai-home+${stamp}.aes`;
}

function ensureAesSuffix(fileName) {
  if (!fileName) return defaultExportName();
  return fileName.endsWith('.aes') ? fileName : `${fileName}.aes`;
}

function normalizeConflictPolicy(rawPolicy) {
  const policy = String(rawPolicy || DEFAULT_CONFLICT_POLICY).trim().toLowerCase();
  if (!SUPPORTED_CONFLICT_POLICIES.has(policy)) {
    throw new Error(`Invalid conflict policy: ${rawPolicy}`);
  }
  return policy;
}

function looksLikeSelector(token, knownTools) {
  if (!token) return false;
  if (token.includes(':')) return true;
  return knownTools.includes(token);
}

function appendSelector(out, selectorRaw) {
  const selector = String(selectorRaw || '').trim();
  if (!selector) return;
  if (!selector.includes(':') && selector.includes(',')) {
    selector
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => out.push(item));
    return;
  }
  out.push(selector);
}

function dedupePreserveOrder(items) {
  const seen = new Set();
  const result = [];
  (items || []).forEach((itemRaw) => {
    const item = String(itemRaw || '').trim();
    if (!item || seen.has(item)) return;
    seen.add(item);
    result.push(item);
  });
  return result;
}

function parseExportNonInteractiveArgs(rawArgs, options) {
  const out = {
    nonInteractive: false,
    targetFile: '',
    selectors: [],
    conflictPolicy: DEFAULT_CONFLICT_POLICY
  };
  const opts = options && typeof options === 'object' ? options : {};
  const knownTools = Array.isArray(opts.knownTools) ? opts.knownTools.map((name) => String(name || '').trim()).filter(Boolean) : [];
  const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;

    if (token === '--non-interactive') {
      out.nonInteractive = true;
      continue;
    }
    if (token === '--output' || token === '-o') {
      const value = String(tokens[i + 1] || '').trim();
      if (!value) throw new Error('Invalid --output value');
      out.targetFile = value;
      i += 1;
      continue;
    }
    if (token === '--selector') {
      const value = String(tokens[i + 1] || '').trim();
      if (!value) throw new Error('Invalid --selector value');
      appendSelector(out.selectors, value);
      i += 1;
      continue;
    }
    if (token === '--conflict' || token === '--on-conflict') {
      const value = String(tokens[i + 1] || '').trim();
      if (!value) throw new Error(`Invalid ${token} value`);
      out.conflictPolicy = normalizeConflictPolicy(value);
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }

    if (!out.targetFile && !looksLikeSelector(token, knownTools)) {
      out.targetFile = token;
      continue;
    }
    appendSelector(out.selectors, token);
  }

  const defaultFileName = typeof opts.defaultExportName === 'function'
    ? String(opts.defaultExportName() || '').trim()
    : defaultExportName(opts.now);
  out.targetFile = ensureAesSuffix(out.targetFile || defaultFileName);
  out.selectors = dedupePreserveOrder(out.selectors);
  return out;
}

function buildExportExecutionPlan(params) {
  const input = params && typeof params === 'object' ? params : {};
  const targetFile = ensureAesSuffix(String(input.targetFile || '').trim() || defaultExportName());
  const conflictPolicy = normalizeConflictPolicy(input.conflictPolicy || DEFAULT_CONFLICT_POLICY);
  const selectors = dedupePreserveOrder(input.selectors || []);
  const resolveSelectors = typeof input.resolveSelectors === 'function'
    ? input.resolveSelectors
    : (values) => values;
  const fileExists = typeof input.fileExists === 'function'
    ? input.fileExists
    : () => false;

  const selectedTargets = dedupePreserveOrder(resolveSelectors(selectors) || []);
  const outputExists = Boolean(fileExists(targetFile));

  let outputAction = 'create';
  let shouldWrite = true;
  if (outputExists) {
    if (conflictPolicy === 'overwrite') {
      outputAction = 'overwrite';
      shouldWrite = true;
    } else if (conflictPolicy === 'report') {
      outputAction = 'reported';
      shouldWrite = false;
    } else {
      outputAction = 'skipped';
      shouldWrite = false;
    }
  }

  return {
    mode: 'non-interactive',
    targetFile,
    conflictPolicy,
    selectors,
    selectedTargets,
    outputExists,
    outputAction,
    shouldWrite
  };
}

module.exports = {
  DEFAULT_CONFLICT_POLICY,
  SUPPORTED_CONFLICT_POLICIES,
  defaultExportName,
  ensureAesSuffix,
  normalizeConflictPolicy,
  parseExportNonInteractiveArgs,
  buildExportExecutionPlan
};
