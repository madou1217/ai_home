'use strict';

// Desktop mode is intentionally derived from invocation/configuration state.
// The helper is owned by a live server or parent process; the standalone app
// is an explicit invocation and never waits for an AIH Server to exist.

function hasFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((value) => String(value) === flag);
}

function valueAfter(argv, flag) {
  if (!Array.isArray(argv)) return '';
  const index = argv.findIndex((value) => String(value) === flag);
  return index >= 0 ? String(argv[index + 1] || '').trim().toLowerCase() : '';
}

function isLiveProcess(pid, probe = process.kill) {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 1) return false;
  try {
    probe(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveDesktopMode({ argv = process.argv, parentPid = 0, serverOwned = false, config = {} } = {}) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const requested = String(config.mode || valueAfter(args, '--desktop-mode') || valueAfter(args, '--mode') || '').trim().toLowerCase();
  const fullApp = requested === 'full-app' || requested === 'app'
    || hasFlag(args, '--full-app') || hasFlag(args, '--desktop-app');
  if (fullApp) return 'full-app';
  const helperRequested = requested === 'helper' || hasFlag(args, '--helper');
  const owned = serverOwned === true || isLiveProcess(parentPid, config.isProcessAlive || process.kill);
  // A helper cannot safely outlive its owner. An unowned/default launch is
  // therefore the standalone shell, even when no explicit app flag is given.
  if (helperRequested && owned) return 'helper';
  if (owned && (serverOwned === true || !helperRequested)) return 'helper';
  return 'full-app';
}

module.exports = { resolveDesktopMode, isLiveProcess };
