const fs = require('fs');
const path = require('path');
const { SESSION_STORE_ALLOWLIST } = require('../cli/services/session-store');

function toIssue(type, severity, message, details = {}) {
  return { type, severity, message, details };
}

function safeListNumericDirs(fsImpl, dirPath) {
  if (!fsImpl.existsSync(dirPath)) return [];
  let entries = [];
  try {
    entries = fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter((entry) => entry && entry.isDirectory && entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));
}

function checkProfilesDirectoryWritable(fsImpl, profilesDir) {
  if (!fsImpl.existsSync(profilesDir)) {
    return [
      toIssue(
        'required-config',
        'warn',
        'profiles directory is missing',
        { path: profilesDir }
      )
    ];
  }

  try {
    fsImpl.accessSync(profilesDir, fs.constants.W_OK);
  } catch (e) {
    return [
      toIssue(
        'permission',
        'error',
        'profiles directory is not writable',
        { path: profilesDir }
      )
    ];
  }

  return [];
}

function checkAccountConfigTopology(fsImpl, hostHomeDir, profilesDir, cliName, config) {
  const issues = [];
  const globalDirName = config && config.globalDir ? config.globalDir : `.${cliName}`;
  const globalRoot = path.join(hostHomeDir, globalDirName);
  const sharedEntries = new Set(SESSION_STORE_ALLOWLIST[cliName] || []);
  const toolProfilesDir = path.join(profilesDir, cliName);
  const ids = safeListNumericDirs(fsImpl, toolProfilesDir);

  ids.forEach((id) => {
    const toolConfigDir = path.join(toolProfilesDir, id, globalDirName);
    if (!fsImpl.existsSync(toolConfigDir)) {
      issues.push(toIssue(
        'required-config',
        'error',
        'account is missing required tool config directory',
        { cli: cliName, id, path: toolConfigDir }
      ));
      return;
    }

    let entries = [];
    try {
      entries = fsImpl.readdirSync(toolConfigDir);
    } catch (e) {
      issues.push(toIssue(
        'permission',
        'error',
        'cannot read tool config directory',
        { cli: cliName, id, path: toolConfigDir }
      ));
      return;
    }

    entries.forEach((name) => {
      const entryPath = path.join(toolConfigDir, name);
      if (sharedEntries.has(name)) {
        let stats;
        try {
          stats = fsImpl.lstatSync(entryPath);
        } catch (e) {
          return;
        }
        const hostEntryPath = path.join(globalRoot, name);
        if (!stats.isSymbolicLink()) {
          issues.push(toIssue(
            'link',
            'warn',
            'shared tool config entry should symlink to native global config',
            { cli: cliName, id, path: entryPath, target: hostEntryPath }
          ));
          return;
        }
      }

      let stats;
      try {
        stats = fsImpl.lstatSync(entryPath);
      } catch (e) {
        return;
      }
      if (!stats.isSymbolicLink()) return;

      let targetPath;
      try {
        targetPath = path.resolve(path.dirname(entryPath), fsImpl.readlinkSync(entryPath));
      } catch (e) {
        issues.push(toIssue(
          'link',
          'error',
          'failed to read symlink target',
          { cli: cliName, id, path: entryPath }
        ));
        return;
      }

      if (!fsImpl.existsSync(targetPath)) {
        issues.push(toIssue(
          'link',
          'error',
          'broken symlink detected in tool config directory',
          { cli: cliName, id, path: entryPath, target: targetPath }
        ));
        return;
      }

      if (path.resolve(targetPath) === path.resolve(globalRoot)) {
        issues.push(toIssue(
          'link',
          'warn',
          'tool config root should not symlink directly to native global root',
          { cli: cliName, id, path: entryPath, target: targetPath }
        ));
      }
    });

    sharedEntries.forEach((name) => {
      const hostEntryPath = path.join(globalRoot, name);
      const entryPath = path.join(toolConfigDir, name);
      if (!fsImpl.existsSync(hostEntryPath)) return;
      if (fsImpl.existsSync(entryPath)) return;
      issues.push(toIssue(
        'link',
        'warn',
        'shared tool config entry is missing expected symlink',
        { cli: cliName, id, path: entryPath, target: hostEntryPath }
      ));
    });
  });

  return issues;
}

function runDoctorChecks(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const hostHomeDir = options.hostHomeDir;
  const aiHomeDir = options.aiHomeDir || path.join(hostHomeDir, '.ai_home');
  const profilesDir = options.profilesDir || path.join(aiHomeDir, 'profiles');
  const cliConfigs = options.cliConfigs || {};

  if (!hostHomeDir) {
    throw new Error('hostHomeDir is required for doctor checks.');
  }

  let issues = [];
  issues = issues.concat(checkProfilesDirectoryWritable(fsImpl, profilesDir));

  Object.keys(cliConfigs).forEach((cliName) => {
    issues = issues.concat(
      checkAccountConfigTopology(fsImpl, hostHomeDir, profilesDir, cliName, cliConfigs[cliName])
    );
  });

  const bySeverity = { error: 0, warn: 0, info: 0 };
  const byType = { permission: 0, link: 0, 'required-config': 0 };
  issues.forEach((issue) => {
    if (bySeverity[issue.severity] !== undefined) bySeverity[issue.severity] += 1;
    if (byType[issue.type] !== undefined) byType[issue.type] += 1;
  });

  return {
    ok: bySeverity.error === 0,
    issues,
    summary: {
      total: issues.length,
      bySeverity,
      byType
    }
  };
}

module.exports = {
  runDoctorChecks
};
