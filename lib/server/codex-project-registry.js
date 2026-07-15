'use strict';

const os = require('node:os');
const path = require('node:path');
const nodeFs = require('node:fs');
const { ensureDirSync } = require('./fs-compat');
const { resolveHostHomeDir: resolveRuntimeHostHomeDir } = require('../runtime/host-home');
const { enableCodexHooksFeatureFlag } = require('../cli/config/codex-feature-flags');
const {
  createManagedCodexStopHookGroup,
  hasManagedCodexStopHook,
  normalizeManagedCodexStopHooks
} = require('./codex-stop-hook-config');
const codexStopHookScriptName = 'aih-stop-notify.js';
const codexStopEventsFileName = 'aih-stop-events.jsonl';

function normalizeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/\/+$/, '');
}

function escapeTomlBasicString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function resolveHostHomeDir(options = {}) {
  const processObj = options.processObj || process;
  const env = { ...(processObj.env || process.env || {}) };
  const explicit = String(options.hostHomeDir || '').trim();
  const realHome = String(env.REAL_HOME || '').trim();
  if (explicit) {
    env.AIH_HOST_HOME = explicit;
  } else if (realHome) {
    env.AIH_HOST_HOME = realHome;
  }
  return resolveRuntimeHostHomeDir({
    env,
    platform: processObj.platform,
    os: options.os || os
  });
}

function resolveCodexProjectConfigDir(options = {}) {
  const explicit = String(options.codexHomeDir || options.codexConfigDir || '').trim();
  if (explicit) return explicit;
  return path.join(resolveHostHomeDir(options), '.codex');
}

function isEnabledEnvValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function shouldInstallCodexStopHook(options = {}) {
  if (options.enableStopHook === true) return true;
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  return isEnabledEnvValue(env.AIH_CODEX_ENABLE_STOP_NOTIFY_HOOK)
    || isEnabledEnvValue(env.AIH_CODEX_STOP_NOTIFY_HOOK);
}

function removeManagedCodexStopHook(hooksConfig) {
  if (!hooksConfig || typeof hooksConfig !== 'object') return false;
  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object') return false;
  const stopHooks = Array.isArray(hooksConfig.hooks.Stop) ? hooksConfig.hooks.Stop : [];
  let changed = false;
  const nextStopHooks = [];

  stopHooks.forEach((group) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      nextStopHooks.push(group);
      return;
    }
    const nextHooks = group.hooks.filter((hook) => {
      const isManaged = String(hook && hook.command || '').includes(codexStopHookScriptName);
      if (isManaged) changed = true;
      return !isManaged;
    });
    if (nextHooks.length > 0) {
      nextStopHooks.push({ ...group, hooks: nextHooks });
    } else if (group.hooks.length > 0) {
      changed = true;
    }
  });

  if (!changed) return false;
  if (nextStopHooks.length > 0) {
    hooksConfig.hooks.Stop = nextStopHooks;
  } else {
    delete hooksConfig.hooks.Stop;
  }
  return true;
}

function ensureCodexHooksEnabled(options = {}) {
  const hostFs = nodeFs;
  const ensureDir = options.ensureDir || ((dirPath) => ensureDirSync(hostFs, dirPath));
  const codexDir = resolveCodexProjectConfigDir(options);
  const configPath = path.join(codexDir, 'config.toml');
  const hooksDir = path.join(codexDir, 'hooks');
  const hookScriptPath = path.join(hooksDir, codexStopHookScriptName);
  const hooksJsonPath = path.join(codexDir, 'hooks.json');
  const stopEventsPath = path.join(codexDir, codexStopEventsFileName);

  ensureDir(codexDir);
  ensureDir(hooksDir);

  let content = '';
  try {
    content = hostFs.existsSync(configPath) ? String(hostFs.readFileSync(configPath, 'utf8') || '') : '';
  } catch (_error) {
    content = '';
  }

  content = enableCodexHooksFeatureFlag(content, {
    codexVersion: options.codexVersion
  }).content;
  hostFs.writeFileSync(configPath, content, 'utf8');

  let hooksConfig = {};
  try {
    hooksConfig = hostFs.existsSync(hooksJsonPath)
      ? JSON.parse(hostFs.readFileSync(hooksJsonPath, 'utf8'))
      : {};
  } catch (_error) {
    hooksConfig = {};
  }

  if (!hooksConfig || typeof hooksConfig !== 'object') hooksConfig = {};
  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object') hooksConfig.hooks = {};

  if (!shouldInstallCodexStopHook(options)) {
    const hooksUpdated = removeManagedCodexStopHook(hooksConfig);
    if (hooksUpdated) {
      hostFs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
    }
    return {
      ok: true,
      configPath,
      hookScriptPath,
      hooksJsonPath,
      stopEventsPath,
      hookInstalled: false,
      hooksUpdated,
      reason: 'stop_hook_disabled'
    };
  }

  const scriptContent = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function readPayload() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_error) {
        resolve({});
      }
    });
    process.stdin.resume();
  });
}

function trySpawn(command, args) {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore' });
    return result.status === 0;
  } catch (_error) {
    return false;
  }
}

function notify() {
  if (process.platform === 'darwin') {
    if (trySpawn('osascript', ['-e', 'beep 1'])) return;
  } else if (process.platform === 'linux') {
    if (trySpawn('sh', ['-lc', 'command -v canberra-gtk-play >/dev/null 2>&1 && canberra-gtk-play -i complete'])) return;
    if (trySpawn('sh', ['-lc', 'command -v paplay >/dev/null 2>&1 && paplay /usr/share/sounds/freedesktop/stereo/complete.oga'])) return;
  }
}

function appendStopEvent(payload) {
  try {
    const stopEventPath = path.join(__dirname, '..', '${codexStopEventsFileName}');
    fs.appendFileSync(stopEventPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      payload
    }) + '\\n', 'utf8');
  } catch (_error) {}
}

(async () => {
  const payload = await readPayload();
  if (!String(payload.last_assistant_message || '').trim()) process.exit(0);
  appendStopEvent(payload);
  notify();
  process.exit(0);
})();
`;

  hostFs.writeFileSync(hookScriptPath, scriptContent, 'utf8');
  try {
    hostFs.chmodSync(hookScriptPath, 0o755);
  } catch (_error) {}
  const stopHooks = Array.isArray(hooksConfig.hooks.Stop) ? hooksConfig.hooks.Stop : [];
  const commandValue = `/usr/bin/env node "${hookScriptPath}"`;
  const normalized = normalizeManagedCodexStopHooks(stopHooks, codexStopHookScriptName);
  const effectiveStopHooks = normalized.hooks;
  const hasExisting = hasManagedCodexStopHook(stopHooks, codexStopHookScriptName);

  if (!hasExisting) {
    effectiveStopHooks.push(createManagedCodexStopHookGroup(commandValue));
    hooksConfig.hooks.Stop = effectiveStopHooks;
    hostFs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
  } else if (normalized.changed) {
    hooksConfig.hooks.Stop = effectiveStopHooks;
    hostFs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
  }

  return {
    ok: true,
    configPath,
    hookScriptPath,
    hooksJsonPath,
    stopEventsPath,
    hookInstalled: true
  };
}

function getCodexStopEventsPath(options = {}) {
  return path.join(resolveHostHomeDir(options), '.codex', codexStopEventsFileName);
}

function ensureCodexProjectRegistered(projectPath, options = {}) {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if (!normalizedProjectPath) {
    return { ok: false, updated: false, reason: 'missing_project_path' };
  }

  const hostFs = nodeFs;
  const ensureDir = options.ensureDir || ((dirPath) => ensureDirSync(hostFs, dirPath));
  const codexDir = resolveCodexProjectConfigDir(options);
  const configPath = path.join(codexDir, 'config.toml');
  const projectHeader = `[projects."${escapeTomlBasicString(normalizedProjectPath)}"]`;
  const projectBlock = `${projectHeader}\ntrust_level = "trusted"\n`;

  ensureDir(codexDir);

  let content = '';
  try {
    content = hostFs.existsSync(configPath) ? String(hostFs.readFileSync(configPath, 'utf8') || '') : '';
  } catch (_error) {
    content = '';
  }

  if (content.includes(projectHeader)) {
    return {
      ok: true,
      updated: false,
      configPath,
      projectPath: normalizedProjectPath
    };
  }

  const nextContent = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${content ? '\n' : ''}${projectBlock}`;
  hostFs.writeFileSync(configPath, nextContent, 'utf8');
  return {
    ok: true,
    updated: true,
    configPath,
    projectPath: normalizedProjectPath
  };
}

module.exports = {
  ensureCodexHooksEnabled,
  ensureCodexProjectRegistered,
  getCodexStopEventsPath,
  __private: {
    removeManagedCodexStopHook,
    shouldInstallCodexStopHook
  }
};
