'use strict';

const os = require('node:os');
const path = require('node:path');
const nodeFs = require('node:fs');
const { ensureDirSync } = require('./fs-compat');
const codexStopHookScriptName = 'aih-stop-notify.js';

function normalizeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/\/+$/, '');
}

function escapeTomlBasicString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function resolveHostHomeDir(options = {}) {
  return String(
    options.hostHomeDir
    || process.env.REAL_HOME
    || os.homedir()
  ).trim();
}

function ensureCodexHooksEnabled(options = {}) {
  const hostFs = nodeFs;
  const ensureDir = options.ensureDir || ((dirPath) => ensureDirSync(hostFs, dirPath));
  const hostHomeDir = resolveHostHomeDir(options);
  const codexDir = path.join(hostHomeDir, '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  const hooksDir = path.join(codexDir, 'hooks');
  const hookScriptPath = path.join(hooksDir, codexStopHookScriptName);
  const hooksJsonPath = path.join(codexDir, 'hooks.json');

  ensureDir(codexDir);
  ensureDir(hooksDir);

  let content = '';
  try {
    content = hostFs.existsSync(configPath) ? String(hostFs.readFileSync(configPath, 'utf8') || '') : '';
  } catch (_error) {
    content = '';
  }

  if (!/^\[features\]\s*$/m.test(content)) {
    content = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${content ? '\n' : ''}[features]\ncodex_hooks = true\n`;
  } else if (/^codex_hooks\s*=/m.test(content)) {
    content = content.replace(/^codex_hooks\s*=.*$/m, 'codex_hooks = true');
  } else {
    content = content.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true');
  }
  hostFs.writeFileSync(configPath, content, 'utf8');

  const scriptContent = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');

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

(async () => {
  const payload = await readPayload();
  if (!String(payload.last_assistant_message || '').trim()) process.exit(0);
  notify();
  process.exit(0);
})();
`;

  hostFs.writeFileSync(hookScriptPath, scriptContent, 'utf8');
  try {
    hostFs.chmodSync(hookScriptPath, 0o755);
  } catch (_error) {}

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
  const stopHooks = Array.isArray(hooksConfig.hooks.Stop) ? hooksConfig.hooks.Stop : [];
  const commandValue = `/usr/bin/env node "${hookScriptPath}"`;
  const hasExisting = stopHooks.some((group) =>
    Array.isArray(group && group.hooks)
    && group.hooks.some((hook) => String(hook && hook.command || '').includes(codexStopHookScriptName))
  );

  if (!hasExisting) {
    stopHooks.push({
      hooks: [
        {
          type: 'command',
          command: commandValue,
          timeout: 10,
          statusMessage: 'AI Home completion notification'
        }
      ]
    });
    hooksConfig.hooks.Stop = stopHooks;
    hostFs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
  }

  return {
    ok: true,
    configPath,
    hookScriptPath,
    hooksJsonPath
  };
}

function ensureCodexProjectRegistered(projectPath, options = {}) {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if (!normalizedProjectPath) {
    return { ok: false, updated: false, reason: 'missing_project_path' };
  }

  const hostFs = nodeFs;
  const ensureDir = options.ensureDir || ((dirPath) => ensureDirSync(hostFs, dirPath));
  const hostHomeDir = resolveHostHomeDir(options);
  const codexDir = path.join(hostHomeDir, '.codex');
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
  ensureCodexProjectRegistered
};
