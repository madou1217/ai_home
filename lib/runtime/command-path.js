const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function makeReporter(logFn) {
  const attempts = [];
  function report(step, status, detail) {
    const item = { step, status, detail: String(detail || '') };
    attempts.push(item);
    if (typeof logFn === 'function') logFn(item);
  }
  return { attempts, report };
}

function parsePathEntries(platform, env) {
  const key = platform === 'win32' ? 'Path' : 'PATH';
  const raw = String((env && (env[key] || env.PATH || env.Path)) || '');
  if (!raw) return [];
  const separator = platform === 'win32' ? ';' : ':';
  return raw.split(separator).map((part) => part.trim()).filter(Boolean);
}

function hasExtension(name) {
  return path.extname(String(name || '')).length > 0;
}

function buildCandidateNames(cmdName, platform, env) {
  if (platform !== 'win32') return [cmdName];
  if (hasExtension(cmdName)) return [cmdName];
  const rawPathext = String((env && env.PATHEXT) || '.EXE;.CMD;.BAT;.COM');
  const exts = rawPathext
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  if (exts.length === 0) return [cmdName];
  return exts.map((ext) => `${cmdName}${ext.toLowerCase()}`);
}

function tryResolveFromPathEntries(cmdName, platform, env, report) {
  const entries = parsePathEntries(platform, env);
  const candidateNames = buildCandidateNames(cmdName, platform, env);
  if (entries.length === 0) {
    report('path_scan', 'skip', 'PATH is empty');
    return '';
  }
  for (const dir of entries) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      try {
        if (!fs.existsSync(candidate)) {
          continue;
        }
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) {
          report('path_scan', 'warn', `skipped non-file candidate ${candidate}`);
          continue;
        }
        if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
          report('path_scan', 'warn', `skipped non-executable candidate ${candidate}`);
          continue;
        }
        report('path_scan', 'ok', `resolved ${candidate}`);
        return candidate;
      } catch (_err) {
        report('path_scan', 'warn', `probe failed for ${candidate}`);
      }
    }
  }
  report('path_scan', 'miss', `checked ${entries.length} PATH entries`);
  return '';
}

function resolveWithProbe(cmdName, platform, spawnSyncImpl, report) {
  if (platform === 'win32') {
    const probe = spawnSyncImpl('where.exe', [cmdName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!probe || probe.status !== 0) {
      report('where_probe', 'miss', 'where returned non-zero status');
      return '';
    }
    const lines = String(probe.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const resolved = lines[0] || '';
    if (resolved) {
      report('where_probe', 'ok', `resolved ${resolved}`);
      return resolved;
    }
    report('where_probe', 'miss', 'where returned empty output');
    return '';
  }

  const safe = String(cmdName).replace(/(["\\$`])/g, '\\$1');
  const probe = spawnSyncImpl('sh', ['-lc', `command -v "${safe}"`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!probe || probe.status !== 0) {
    report('command_v_probe', 'miss', 'command -v returned non-zero status');
    return '';
  }
  const resolved = String(probe.stdout || '').trim();
  if (resolved) {
    report('command_v_probe', 'ok', `resolved ${resolved}`);
    return resolved;
  }
  report('command_v_probe', 'miss', 'command -v returned empty output');
  return '';
}

function resolveCommandPathDetailed(cmdName, options = {}) {
  const normalized = String(cmdName || '').trim();
  const { attempts, report } = makeReporter(options.logFn);
  if (!normalized) {
    report('input', 'invalid', 'command name is blank');
    return {
      path: '',
      errorCode: 'INVALID_COMMAND_NAME',
      remediation: 'Provide a non-empty command name.',
      attempts
    };
  }

  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;

  const resolvedByPathScan = tryResolveFromPathEntries(normalized, platform, env, report);
  if (resolvedByPathScan) {
    return {
      path: resolvedByPathScan,
      errorCode: '',
      remediation: '',
      attempts
    };
  }

  const resolvedByProbe = resolveWithProbe(normalized, platform, spawnSyncImpl, report);
  if (resolvedByProbe) {
    return {
      path: resolvedByProbe,
      errorCode: '',
      remediation: '',
      attempts
    };
  }

  return {
    path: '',
    errorCode: 'COMMAND_NOT_FOUND',
    remediation: `Install '${normalized}' and ensure it is available in PATH.`,
    attempts
  };
}

function resolveCommandPath(cmdName, options = {}) {
  return resolveCommandPathDetailed(cmdName, options).path;
}

module.exports = {
  resolveCommandPath,
  resolveCommandPathDetailed
};
