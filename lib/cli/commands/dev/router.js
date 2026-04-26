'use strict';

function buildMockUsageSnapshot(cliName, remainingPct, usageConstants = {}) {
  const remaining = Math.max(0, Math.min(100, Number(remainingPct) || 0));
  const now = Date.now();
  const schemaVersion = Number(usageConstants.schemaVersion) || 2;
  const codexSource = String(usageConstants.codexSource || 'codex_app_server');
  const geminiSource = String(usageConstants.geminiSource || 'gemini_cli_quota');
  const claudeSource = String(usageConstants.claudeSource || 'claude_oauth_usage_api');

  if (cliName === 'codex' || cliName === 'claude') {
    return {
      schemaVersion,
      kind: cliName === 'codex' ? 'codex_oauth_status' : 'claude_oauth_usage',
      source: cliName === 'codex' ? codexSource : claudeSource,
      capturedAt: now,
      entries: [
        {
          bucket: 'primary',
          windowMinutes: 300,
          window: '5h',
          remainingPct: remaining,
          resetIn: 'mock'
        },
        {
          bucket: 'secondary',
          windowMinutes: 10080,
          window: '7days',
          remainingPct: remaining,
          resetIn: 'mock'
        }
      ]
    };
  }

  return {
    schemaVersion,
    kind: 'gemini_oauth_stats',
    source: geminiSource,
    capturedAt: now,
    models: [
      {
        model: 'gemini-2.5-pro',
        remainingPct: remaining,
        resetIn: 'mock'
      }
    ]
  };
}

function parseMockUsageArgs(args) {
  const provider = String(args[1] || '').trim().toLowerCase();
  const id = String(args[2] || '').trim();
  let remainingPct = 4;
  let durationSec = 60;
  const tokens = Array.isArray(args) ? args.slice(3) : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (token === '--remaining') {
      remainingPct = Number(tokens[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--duration-sec') {
      durationSec = Number(tokens[i + 1]);
      i += 1;
      continue;
    }
  }
  remainingPct = Math.max(0, Math.min(100, Number.isFinite(remainingPct) ? remainingPct : 4));
  durationSec = Math.max(5, Math.min(3600, Number.isFinite(durationSec) ? durationSec : 60));
  return { provider, id, remainingPct, durationSec };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDevCommand(rawArgs, deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  const action = String(args[0] || '').trim().toLowerCase();
  const log = deps.log || console.log;
  const error = deps.error || console.error;
  const fs = deps.fs;
  const ensureDir = deps.ensureDir;
  const getUsageCachePath = deps.getUsageCachePath;
  const readUsageCache = deps.readUsageCache;
  const usageConstants = deps.usageConstants || {};

  if (action !== 'mock-usage') {
    error('\x1b[31m[aih] Unknown dev action.\x1b[0m');
    log('\x1b[90mUsage:\x1b[0m aih dev mock-usage <provider> <id> [--remaining <pct>] [--duration-sec <sec>]');
    return 1;
  }

  const { provider, id, remainingPct, durationSec } = parseMockUsageArgs(args);
  if (!['codex', 'gemini', 'claude'].includes(provider) || !/^\d+$/.test(id)) {
    error('\x1b[31m[aih] Invalid provider or account id.\x1b[0m');
    log('\x1b[90mUsage:\x1b[0m aih dev mock-usage <provider> <id> [--remaining <pct>] [--duration-sec <sec>]');
    return 1;
  }

  const usagePath = getUsageCachePath(provider, id);
  const usageDir = deps.path ? deps.path.dirname(usagePath) : require('path').dirname(usagePath);
  ensureDir(usageDir);
  const hadOriginal = fs.existsSync(usagePath);
  const originalText = hadOriginal ? String(fs.readFileSync(usagePath, 'utf8') || '') : '';
  const mockSnapshot = buildMockUsageSnapshot(provider, remainingPct, usageConstants);

  log(`\x1b[36m[aih]\x1b[0m Mock usage start: ${provider}#${id}, remaining=${remainingPct.toFixed(1)}%, duration=${durationSec}s`);
  fs.writeFileSync(usagePath, `${JSON.stringify(mockSnapshot, null, 2)}\n`);
  const mocked = readUsageCache(provider, id);
  if (!mocked) {
    error('\x1b[31m[aih] mock write failed: snapshot not readable after write.\x1b[0m');
    return 1;
  }
  log(`\x1b[32m[aih]\x1b[0m Mock injected at ${usagePath}`);

  await sleep(durationSec * 1000);
  try {
    if (hadOriginal) {
      fs.writeFileSync(usagePath, originalText);
    } else if (fs.existsSync(usagePath)) {
      fs.unlinkSync(usagePath);
    }
    const restored = readUsageCache(provider, id);
    if (hadOriginal && !restored) {
      error('\x1b[31m[aih] restore check failed: original snapshot is no longer readable.\x1b[0m');
      return 1;
    }
    log('\x1b[32m[aih]\x1b[0m Mock usage restored and re-checked.');
    return 0;
  } catch (restoreError) {
    error(`\x1b[31m[aih] restore failed: ${restoreError.message}\x1b[0m`);
    return 1;
  }
}

module.exports = {
  runDevCommand
};
