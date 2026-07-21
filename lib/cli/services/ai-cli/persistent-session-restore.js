'use strict';

// Post-reboot restore engine for persistent tmux/psmux sessions.
//
// tmux servers are in-memory only, so a machine reboot silently destroys every
// aih session. The registry (lib/runtime/persistent-session-registry.js) is
// the on-disk record of what was running; this module reconciles it against
// the live tmux servers and re-creates reboot-killed sessions detached.
//
// Reconciliation rules per registry entry:
//   * its tmux server answers and the session is listed  → alive: touch it
//   * its tmux server answers, session missing           → user closed it: drop entry
//   * server unreachable, updatedAt >= system boot time  → ended during THIS
//     boot (not a reboot victim): drop entry
//   * server unreachable, updatedAt <  system boot time  → killed by reboot:
//     restore (cwd must still exist, else mark unrecoverable)
//
// Restoring reuses the ENTIRE normal launch pipeline: we spawn a detached
// `aih <provider> <account>` child with AIH_PERSIST_DETACHED=1 and
// AIH_SESSION_TARGET=<exact session name>, cwd = the recorded project dir.
// The child builds account-isolated env / config sync exactly like a manual
// launch, creates the session via `tmux new-session -Ad`, and exits. Secrets
// therefore ride the child's process env only — never argv or tmux -e.
//
// Conversation continuity comes from provider-native resume:
//   codex  → forward '/resume' (normalizeRuntimeForwardArgs resolves the
//            latest thread id for that cwd from the state DB)
//   claude → '--continue' (same-cwd latest conversation)
//   others → plain relaunch of the session shell (v1: no resume args)

const LOCK_FILE_NAME = '.restore.lock';
const LOCK_STALE_MS = 5 * 60 * 1000;
const { resolveCliAccountRef } = require('../../../server/account-ref-store');

function buildRestoreForwardArgs(provider) {
  const name = String(provider || '').trim().toLowerCase();
  if (name === 'codex') return ['/resume'];
  if (name === 'claude') return ['--continue'];
  return [];
}

function isNoServerProbe(probe) {
  const stderr = String((probe && probe.stderr) || '');
  return /no server running|No such file or directory|error connecting to|failed to connect/i.test(stderr);
}

// Pure planning: bucket registry entries into alive / restore / drop /
// unrecoverable given per-socket probe results. Probes are supplied by the
// caller so this stays synchronous and unit-testable.
function planRestoreActions(entries, probeBySocket, options = {}) {
  const bootTimeMs = Number(options.bootTimeMs) || 0;
  const cwdExists = typeof options.cwdExists === 'function' ? options.cwdExists : () => true;
  const plan = { alive: [], restore: [], drop: [], unrecoverable: [], unknown: [] };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const probe = probeBySocket && probeBySocket[entry.socket];
    if (!probe || probe.trusted !== true) {
      plan.unknown.push(entry);
      continue;
    }
    if (!probe.noServer) {
      const aliveNames = probe.aliveNames instanceof Set
        ? probe.aliveNames
        : new Set(Array.isArray(probe.aliveNames) ? probe.aliveNames : []);
      if (aliveNames.has(entry.session)) plan.alive.push(entry);
      else plan.drop.push(entry);
      continue;
    }
    // Server gone. Only sessions last confirmed alive BEFORE this boot are
    // reboot victims; anything newer simply ended during the current boot.
    if (entry.updatedAt >= bootTimeMs) {
      plan.drop.push(entry);
      continue;
    }
    if (entry.unrecoverable) {
      plan.unrecoverable.push(entry);
      continue;
    }
    if (!cwdExists(entry.cwd)) {
      plan.unrecoverable.push({ ...entry, unrecoverable: 'cwd-missing' });
      continue;
    }
    plan.restore.push(entry);
  }
  return plan;
}

function buildRestoreChildEnv(baseEnv, entry, persistentSession) {
  const env = { ...(baseEnv || {}) };
  env[persistentSession.DETACHED_ENV] = '1';
  env[persistentSession.TARGET_ENV] = String(entry.session || '');
  // The child must plan its OWN session; stale interactive flags would skew it.
  delete env[persistentSession.SESSION_ENV];
  delete env[persistentSession.RESUME_ENV];
  delete env[persistentSession.MIRROR_ENV];
  delete env[persistentSession.MARKER_ENV];
  return env;
}

function createPersistentSessionRestore(deps = {}) {
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  const os = deps.os || require('os');
  const spawn = deps.spawn || require('child_process').spawn;
  const spawnSync = deps.spawnSync || require('child_process').spawnSync;
  const processObj = deps.processObj || process;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const persistentSession = deps.persistentSession || require('../../../runtime/persistent-session');
  const registry = deps.persistentSessionRegistry || require('../../../runtime/persistent-session-registry');
  const aihBinPath = String(deps.aihBinPath || '').trim()
    || path.resolve(__dirname, '..', '..', '..', '..', 'bin', 'ai-home.js');
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  function lockFilePath() {
    return path.join(registry.registryDir(aiHomeDir), LOCK_FILE_NAME);
  }

  // Guards against the server-startup restore and a lazy `aih ss` restore
  // racing each other. Best-effort: a crashed holder goes stale after 5 min.
  function acquireLock(now) {
    const lockPath = lockFilePath();
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, `${processObj.pid} ${now}\n`, { flag: 'wx' });
      return true;
    } catch (_error) {
      try {
        const stat = fs.statSync(lockPath);
        if (now - stat.mtimeMs > LOCK_STALE_MS) {
          fs.writeFileSync(lockPath, `${processObj.pid} ${now}\n`);
          return true;
        }
      } catch (_statError) {}
      return false;
    }
  }

  function releaseLock() {
    try { fs.unlinkSync(lockFilePath()); } catch (_error) {}
  }

  function probeSocket(tmux, entry) {
    try {
      const listCmd = persistentSession.buildListSessionsCommand({
        cliName: entry.provider,
        runtimeScope: entry.runtimeScope,
        tmuxCommand: tmux.command
      });
      const probe = spawnSync(listCmd.command, listCmd.args, {
        encoding: 'utf8',
        timeout: Number(deps.probeTimeoutMs) || 1500
      });
      if (probe && !probe.error && probe.status === 0) {
        return {
          trusted: true,
          noServer: false,
          aliveNames: new Set(persistentSession.parseSessionList(probe.stdout).map((s) => s.name))
        };
      }
      if (isNoServerProbe(probe)) return { trusted: true, noServer: true, aliveNames: new Set() };
      return { trusted: false };
    } catch (_error) {
      return { trusted: false };
    }
  }

  function spawnRestoreChild(entry) {
    const forwardArgs = buildRestoreForwardArgs(entry.provider);
    const childArgs = [aihBinPath, entry.provider];
    if (!entry.gateway) {
      const account = resolveCliAccountRef(fs, aiHomeDir, entry.accountRef, { bestEffort: true });
      const cliAccountId = String(account && account.cliAccountId || '').trim();
      if (!/^\d+$/.test(cliAccountId)) throw new Error('restore_account_ref_not_registered');
      childArgs.push(cliAccountId);
    }
    childArgs.push(...forwardArgs);
    const child = spawn(
      processObj.execPath,
      childArgs,
      {
        cwd: entry.cwd,
        env: buildRestoreChildEnv(processObj.env, entry, persistentSession),
        detached: true,
        stdio: 'ignore'
      }
    );
    if (child && typeof child.unref === 'function') child.unref();
    return child;
  }

  // Reconcile the registry with the live tmux servers and re-create sessions
  // killed by a reboot. Planning is synchronous and cheap (one list-sessions
  // per socket); actual restoration happens in detached children, so callers
  // are never blocked on provider startup.
  function restorePersistentSessions(options = {}) {
    if (!aiHomeDir) return { skipped: 'no-aih-home' };
    if (String(processObj.env[persistentSession.DETACHED_ENV] || '') === '1') {
      return { skipped: 'restore-child' };
    }
    // detectTmux resolves nothing without an injected probe — always hand it
    // spawnSync so `tmux -V` can confirm the engine.
    const tmux = persistentSession.detectTmux({
      platform: processObj.platform,
      env: processObj.env,
      spawnSync
    });
    if (!tmux.available) return { skipped: 'no-tmux' };

    const entries = registry.listEntries(aiHomeDir, { fs });
    if (!entries.length) return { restored: 0, alive: 0, dropped: 0, unrecoverable: 0 };

    const now = Number(options.now) || Date.now();
    if (!acquireLock(now)) return { skipped: 'locked' };
    try {
      const bootTimeMs = Number(options.bootTimeMs)
        || (now - Math.max(0, Number(os.uptime()) || 0) * 1000);
      const probeBySocket = {};
      for (const entry of entries) {
        if (!probeBySocket[entry.socket]) probeBySocket[entry.socket] = probeSocket(tmux, entry);
      }
      const plan = planRestoreActions(entries, probeBySocket, {
        bootTimeMs,
        cwdExists: (cwd) => {
          try { return !!cwd && fs.existsSync(cwd); } catch (_error) { return false; }
        }
      });

      for (const entry of plan.alive) {
        registry.touchEntry(aiHomeDir, entry.socket, entry.session, { fs, now });
      }
      for (const entry of plan.drop) {
        registry.removeEntry(aiHomeDir, entry.socket, entry.session, { fs });
      }
      for (const entry of plan.unrecoverable) {
        if (entry.unrecoverable === 'cwd-missing') {
          registry.markEntryUnrecoverable(aiHomeDir, entry.socket, entry.session, 'cwd-missing', { fs });
        }
      }
      const restoredSessions = [];
      for (const entry of plan.restore) {
        try {
          spawnRestoreChild(entry);
          restoredSessions.push(entry);
        } catch (_error) {}
      }
      if (restoredSessions.length > 0) {
        log(`\x1b[36m[aih]\x1b[0m ♻ 检测到 ${restoredSessions.length} 个重启前的持久会话，正在后台恢复（对话将自动续接）…`);
        log('\x1b[90m[aih]\x1b[0m 稍后运行 `aih ss` 查看并进入恢复后的会话。');
      }
      if (plan.unrecoverable.length > 0) {
        const names = plan.unrecoverable
          .map((entry) => `${entry.session}（${entry.unrecoverable === 'cwd-missing' ? '项目目录已不存在' : entry.unrecoverable}：${entry.cwd || '?'}）`)
          .join('、');
        log(`\x1b[33m[aih]\x1b[0m ⚠ ${plan.unrecoverable.length} 个历史会话无法恢复：${names}`);
      }
      return {
        restored: restoredSessions.length,
        alive: plan.alive.length,
        dropped: plan.drop.length,
        unrecoverable: plan.unrecoverable.length,
        restoredSessions: restoredSessions.map((entry) => ({
          provider: entry.provider,
          gateway: entry.gateway,
          runtimeScope: entry.runtimeScope,
          accountRef: entry.accountRef,
          session: entry.session,
          cwd: entry.cwd
        }))
      };
    } finally {
      releaseLock();
    }
  }

  return { restorePersistentSessions };
}

module.exports = {
  LOCK_FILE_NAME,
  LOCK_STALE_MS,
  buildRestoreForwardArgs,
  buildRestoreChildEnv,
  planRestoreActions,
  createPersistentSessionRestore
};
