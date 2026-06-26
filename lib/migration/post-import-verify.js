'use strict';

const fs = require('fs');

function compareAccountEntry(left, right) {
  const toolOrder = String(left.tool || '').localeCompare(String(right.tool || ''));
  if (toolOrder !== 0) return toolOrder;
  const leftId = Number(left.id);
  const rightId = Number(right.id);
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function normalizeProbeResult(result) {
  if (result == null) return { ok: true, reason: '' };
  if (typeof result === 'boolean') {
    return { ok: result, reason: result ? '' : 'startup probe returned false' };
  }
  if (typeof result === 'object') {
    const ok = result.ok !== false;
    return { ok, reason: String(result.reason || '').trim() };
  }
  return { ok: false, reason: 'invalid startup probe result' };
}

function verifyImportedAccounts(options) {
  const input = options && typeof options === 'object' ? options : {};
  const accounts = Array.isArray(input.accounts) ? input.accounts.slice() : [];
  const getProfileDir = typeof input.getProfileDir === 'function' ? input.getProfileDir : () => '';
  const checkStatus = typeof input.checkStatus === 'function'
    ? input.checkStatus
    : () => ({ configured: true, accountName: 'Unknown' });
  const startupProbe = typeof input.startupProbe === 'function' ? input.startupProbe : null;
  const fsImpl = input.fsImpl || fs;

  const report = {
    total: 0,
    passed: 0,
    failed: 0,
    passRate: 0,
    entries: []
  };

  accounts.sort(compareAccountEntry).forEach((account) => {
    const tool = String(account.tool || '').trim();
    const id = String(account.id || '').trim();
    if (!tool || !id) return;

    const reasons = [];
    const profileDir = getProfileDir(tool, id);
    const entry = {
      tool,
      id,
      profileDir,
      identity: 'Unknown',
      status: 'pass',
      reasons: []
    };

    if (!profileDir || !fsImpl.existsSync(profileDir)) {
      reasons.push('profile_missing');
    } else {
      const status = checkStatus(tool, profileDir) || {};
      const accountName = String(status.accountName || '').trim();
      if (accountName) entry.identity = accountName;
      if (!status.configured) {
        reasons.push('not_authenticated');
      }
      if (reasons.length === 0 && startupProbe) {
        const probe = normalizeProbeResult(startupProbe(tool, profileDir, account));
        if (!probe.ok) {
          reasons.push(probe.reason ? `startup_probe_failed:${probe.reason}` : 'startup_probe_failed');
        }
      }
    }

    if (reasons.length > 0) {
      entry.status = 'fail';
      entry.reasons = reasons;
      report.failed += 1;
    } else {
      report.passed += 1;
    }

    report.entries.push(entry);
  });

  report.total = report.entries.length;
  report.passRate = report.total > 0 ? Number(((report.passed / report.total) * 100).toFixed(2)) : 0;
  return report;
}

function formatPostImportValidationReport(report) {
  const input = report && typeof report === 'object' ? report : {};
  const total = Number(input.total || 0);
  const passed = Number(input.passed || 0);
  const failed = Number(input.failed || 0);
  const passRate = Number(input.passRate || 0);
  const lines = [
    `Post-import validation: PASS ${passed}/${total}, FAIL ${failed}, pass_rate=${passRate}%`
  ];
  const entries = Array.isArray(input.entries) ? input.entries : [];
  entries
    .filter((entry) => entry && entry.status === 'fail')
    .forEach((entry) => {
      const reasonText = Array.isArray(entry.reasons) && entry.reasons.length > 0
        ? entry.reasons.join(', ')
        : 'unknown';
      lines.push(`- ${entry.tool}:${entry.id} -> ${reasonText}`);
    });
  return lines.join('\n');
}

module.exports = {
  verifyImportedAccounts,
  formatPostImportValidationReport
};
