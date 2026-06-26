'use strict';

const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');

const DEFAULT_CONFLICT_POLICY = 'skip';
const SUPPORTED_CONFLICT_POLICIES = new Set(['skip', 'overwrite', 'report']);

function normalizeConflictPolicy(rawPolicy) {
  const policy = String(rawPolicy || DEFAULT_CONFLICT_POLICY).trim().toLowerCase();
  if (!SUPPORTED_CONFLICT_POLICIES.has(policy)) {
    throw new Error(`Invalid conflict policy: ${rawPolicy}`);
  }
  return policy;
}

function parseImportNonInteractiveArgs(rawArgs) {
  const out = {
    nonInteractive: false,
    targetFile: '',
    conflictPolicy: DEFAULT_CONFLICT_POLICY
  };
  const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  const extra = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;

    if (token === '--non-interactive') {
      out.nonInteractive = true;
      continue;
    }
    if (token === '-o' || token === '--overwrite') {
      out.conflictPolicy = 'overwrite';
      continue;
    }
    if (token === '--file' || token === '--input') {
      const value = String(tokens[i + 1] || '').trim();
      if (!value) throw new Error(`Invalid ${token} value`);
      out.targetFile = value;
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

    if (!out.targetFile) {
      out.targetFile = token;
      continue;
    }
    extra.push(token);
  }

  if (extra.length > 0) {
    throw new Error(`Unexpected argument(s): ${extra.join(' ')}`);
  }
  if (!out.targetFile) {
    throw new Error('Missing backup file');
  }

  out.conflictPolicy = normalizeConflictPolicy(out.conflictPolicy);
  return out;
}

function isNumericAccountId(name) {
  return /^\d+$/.test(String(name || ''));
}

function compareAccountIds(a, b) {
  const aNum = Number(a);
  const bNum = Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
  return String(a).localeCompare(String(b));
}

function getDirectoryEntriesSafe(fsImpl, targetPath) {
  try {
    return fsImpl.readdirSync(targetPath, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

function restoreProfilesWithConflictPolicy(params) {
  const input = params && typeof params === 'object' ? params : {};
  const srcProfilesDir = String(input.srcProfilesDir || '').trim();
  const dstProfilesDir = String(input.dstProfilesDir || '').trim();
  if (!srcProfilesDir) throw new Error('srcProfilesDir is required.');
  if (!dstProfilesDir) throw new Error('dstProfilesDir is required.');

  const fsImpl = input.fsImpl || fs;
  const fseImpl = input.fseImpl || fse;
  const conflictPolicy = normalizeConflictPolicy(input.conflictPolicy || DEFAULT_CONFLICT_POLICY);
  const resolveIdentity = typeof input.resolveIdentity === 'function'
    ? input.resolveIdentity
    : () => 'Unknown';

  if (!fsImpl.existsSync(srcProfilesDir) || !fsImpl.statSync(srcProfilesDir).isDirectory()) {
    throw new Error('Backup archive does not contain a profiles/ directory.');
  }

  fseImpl.ensureDirSync(dstProfilesDir);

  const summary = {
    conflictPolicy,
    totalAccounts: 0,
    imported: 0,
    overwritten: 0,
    skipped: 0,
    reported: 0,
    conflicts: 0,
    metadataCopied: 0,
    importedAccounts: [],
    overwrittenAccounts: [],
    skippedAccounts: [],
    reportedAccounts: []
  };

  const tools = getDirectoryEntriesSafe(fsImpl, srcProfilesDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  tools.forEach((tool) => {
    const srcToolDir = path.join(srcProfilesDir, tool);
    const dstToolDir = path.join(dstProfilesDir, tool);
    fseImpl.ensureDirSync(dstToolDir);

    const entries = getDirectoryEntriesSafe(fsImpl, srcToolDir)
      .slice()
      .sort((left, right) => {
        const leftIsAccount = left.isDirectory() && isNumericAccountId(left.name);
        const rightIsAccount = right.isDirectory() && isNumericAccountId(right.name);
        if (leftIsAccount && rightIsAccount) return compareAccountIds(left.name, right.name);
        if (leftIsAccount) return -1;
        if (rightIsAccount) return 1;
        return left.name.localeCompare(right.name);
      });

    entries.forEach((entry) => {
      const srcEntry = path.join(srcToolDir, entry.name);
      const dstEntry = path.join(dstToolDir, entry.name);

      if (entry.isDirectory() && isNumericAccountId(entry.name)) {
        summary.totalAccounts += 1;
        const accountInfo = {
          tool,
          id: entry.name,
          identity: resolveIdentity(tool, dstEntry)
        };

        if (fsImpl.existsSync(dstEntry)) {
          summary.conflicts += 1;
          if (conflictPolicy === 'overwrite') {
            fseImpl.removeSync(dstEntry);
            fseImpl.copySync(srcEntry, dstEntry, { overwrite: true });
            accountInfo.identity = resolveIdentity(tool, dstEntry);
            summary.overwritten += 1;
            summary.overwrittenAccounts.push(accountInfo);
            return;
          }
          if (conflictPolicy === 'report') {
            summary.reported += 1;
            summary.reportedAccounts.push(accountInfo);
            return;
          }
          summary.skipped += 1;
          summary.skippedAccounts.push(accountInfo);
          return;
        }

        fseImpl.copySync(srcEntry, dstEntry, { overwrite: true });
        accountInfo.identity = resolveIdentity(tool, dstEntry);
        summary.imported += 1;
        summary.importedAccounts.push(accountInfo);
        return;
      }

      if (!fsImpl.existsSync(dstEntry)) {
        fseImpl.copySync(srcEntry, dstEntry, { overwrite: true });
        summary.metadataCopied += 1;
        return;
      }

      if (conflictPolicy === 'overwrite') {
        fseImpl.removeSync(dstEntry);
        fseImpl.copySync(srcEntry, dstEntry, { overwrite: true });
        summary.metadataCopied += 1;
      }
    });
  });

  return summary;
}

function formatImportSummary(summary) {
  const result = summary && typeof summary === 'object' ? summary : {};
  const policy = result.conflictPolicy || DEFAULT_CONFLICT_POLICY;
  const imported = Number(result.imported || 0);
  const overwritten = Number(result.overwritten || 0);
  const skipped = Number(result.skipped || 0);
  const reported = Number(result.reported || 0);
  const conflicts = Number(result.conflicts || 0);
  return `policy=${policy} imported=${imported} overwritten=${overwritten} skipped=${skipped} reported=${reported} conflicts=${conflicts}`;
}

module.exports = {
  DEFAULT_CONFLICT_POLICY,
  SUPPORTED_CONFLICT_POLICIES,
  normalizeConflictPolicy,
  parseImportNonInteractiveArgs,
  isNumericAccountId,
  restoreProfilesWithConflictPolicy,
  formatImportSummary
};
