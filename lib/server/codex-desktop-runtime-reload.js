'use strict';

function reloadCodexDesktopRuntime(service) {
  if (!service) return { ok: false, reason: 'desktop_hook_unavailable' };

  let hook;
  try {
    hook = typeof service.ensureInstalled === 'function'
      ? service.ensureInstalled()
      : { ok: true, skipped: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'desktop_hook_reconcile_failed',
      error: String(error && error.message || error || 'unknown_error')
    };
  }
  if (!hook || !hook.ok) {
    return {
      ok: false,
      reason: hook && hook.reason ? hook.reason : 'desktop_hook_reconcile_failed',
      hook
    };
  }

  let restart;
  try {
    restart = typeof service.restartRunningAppServers === 'function'
      ? service.restartRunningAppServers()
      : { ok: true, count: 0, pids: [] };
  } catch (error) {
    return {
      ok: false,
      reason: 'desktop_runtime_restart_failed',
      hook,
      error: String(error && error.message || error || 'unknown_error')
    };
  }
  if (!restart || !restart.ok) {
    return {
      ok: false,
      reason: restart && restart.reason ? restart.reason : 'desktop_runtime_restart_failed',
      hook,
      restart
    };
  }

  return {
    ok: true,
    hook,
    restart,
    restarted: Number(restart.count) > 0
  };
}

module.exports = {
  reloadCodexDesktopRuntime
};
