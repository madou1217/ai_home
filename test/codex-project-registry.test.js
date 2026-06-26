const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureCodexHooksEnabled,
  ensureCodexProjectRegistered,
  getCodexStopEventsPath
} = require('../lib/server/codex-project-registry');

function encodedWindowsCodexHome() {
  const colon = String.fromCharCode(0xf03a);
  const backslash = String.fromCharCode(0xf05c);
  return `C${colon}${backslash}Users${backslash}alice${backslash}.codex`;
}

test('ensureCodexProjectRegistered appends trusted project block once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-project-registry-'));
  const projectPath = '/Users/model/projects/shalou';

  try {
    const first = ensureCodexProjectRegistered(projectPath, {
      fs,
      hostHomeDir: root,
      ensureDir: (dirPath) => fs.mkdirSync(dirPath, { recursive: true })
    });
    assert.equal(first.ok, true);
    assert.equal(first.updated, true);

    const configPath = path.join(root, '.codex', 'config.toml');
    const contentAfterFirstWrite = fs.readFileSync(configPath, 'utf8');
    assert.match(contentAfterFirstWrite, /\[projects\."\/Users\/model\/projects\/shalou"\]/);
    assert.match(contentAfterFirstWrite, /trust_level = "trusted"/);

    const second = ensureCodexProjectRegistered(projectPath, {
      fs,
      hostHomeDir: root,
      ensureDir: (dirPath) => fs.mkdirSync(dirPath, { recursive: true })
    });
    assert.equal(second.ok, true);
    assert.equal(second.updated, false);
    assert.equal(fs.readFileSync(configPath, 'utf8'), contentAfterFirstWrite);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex project registry decodes encoded Windows host home fallbacks', () => {
  const stopEventsPath = getCodexStopEventsPath({
    processObj: {
      platform: 'win32',
      env: {
        REAL_HOME: encodedWindowsCodexHome()
      }
    },
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' }
  });

  assert.equal(stopEventsPath, 'C:/Users/alice/.codex/aih-stop-events.jsonl');
  assert.equal(stopEventsPath.includes(encodedWindowsCodexHome()), false);
});

test('ensureCodexHooksEnabled writes feature flag, hook script and hooks json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hooks-'));

  try {
    const result = ensureCodexHooksEnabled({
      fs,
      hostHomeDir: root,
      codexVersion: '0.114.0',
      enableStopHook: true
    });

    assert.equal(result.ok, true);
    const configPath = path.join(root, '.codex', 'config.toml');
    const hooksJsonPath = path.join(root, '.codex', 'hooks.json');
    const hookScriptPath = path.join(root, '.codex', 'hooks', 'aih-stop-notify.js');
    const stopEventsPath = path.join(root, '.codex', 'aih-stop-events.jsonl');

    assert.equal(fs.existsSync(configPath), true);
    assert.equal(fs.existsSync(hooksJsonPath), true);
    assert.equal(fs.existsSync(hookScriptPath), true);
    assert.equal(result.stopEventsPath, stopEventsPath);
    assert.match(fs.readFileSync(configPath, 'utf8'), /\[features\]\nhooks = true/);
    assert.match(fs.readFileSync(hookScriptPath, 'utf8'), /aih-stop-events\.jsonl/);
    assert.equal(getCodexStopEventsPath({ hostHomeDir: root }), stopEventsPath);

    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.equal(Array.isArray(hooksConfig.hooks.Stop), true);
    const managedHook = hooksConfig.hooks.Stop
      .flatMap((group) => Array.isArray(group && group.hooks) ? group.hooks : [])
      .find((hook) => String(hook && hook.command || '').includes('aih-stop-notify.js'));
    assert.ok(managedHook);
    assert.equal(managedHook.statusMessage, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureCodexHooksEnabled normalizes old managed stop hook schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hooks-normalize-'));
  const codexDir = path.join(root, '.codex');
  const hooksDir = path.join(codexDir, 'hooks');
  const hooksJsonPath = path.join(codexDir, 'hooks.json');

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `/usr/bin/env node "${path.join(hooksDir, 'aih-stop-notify.js')}"`,
                timeout: 10,
                statusMessage: 'AI Home completion notification'
              }
            ]
          }
        ]
      }
    }, null, 2) + '\n', 'utf8');

    const result = ensureCodexHooksEnabled({
      fs,
      hostHomeDir: root,
      codexVersion: '0.130.0',
      enableStopHook: true
    });

    assert.equal(result.ok, true);
    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const managedHook = hooksConfig.hooks.Stop[0].hooks[0];
    assert.equal(managedHook.type, 'command');
    assert.equal(managedHook.timeout, 10);
    assert.equal(managedHook.statusMessage, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureCodexProjectRegistered ignores injected fs existence stubs for host config writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-project-registry-hostfs-'));
  const codexDir = path.join(root, '.codex');
  const configPath = path.join(codexDir, 'config.toml');

  try {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n', 'utf8');

    const result = ensureCodexProjectRegistered('/Users/model/projects/feature/ai_home', {
      fs: {
        existsSync: () => false
      },
      hostHomeDir: root,
      ensureDir: (dirPath) => fs.mkdirSync(dirPath, { recursive: true })
    });

    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    const content = fs.readFileSync(configPath, 'utf8');
    assert.match(content, /^model = "gpt-5\.4"$/m);
    assert.match(content, /^model_reasoning_effort = "high"$/m);
    assert.match(content, /\[projects\."\/Users\/model\/projects\/feature\/ai_home"\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureCodexHooksEnabled preserves existing host config when injected fs is stubbed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hooks-hostfs-'));
  const codexDir = path.join(root, '.codex');
  const configPath = path.join(codexDir, 'config.toml');

  try {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n', 'utf8');

    const result = ensureCodexHooksEnabled({
      fs: {
        existsSync: () => false
      },
      hostHomeDir: root,
      ensureDir: (dirPath) => fs.mkdirSync(dirPath, { recursive: true }),
      codexVersion: '0.114.0',
      enableStopHook: true
    });

    assert.equal(result.ok, true);
    const content = fs.readFileSync(configPath, 'utf8');
    assert.match(content, /^model = "gpt-5\.4"$/m);
    assert.match(content, /^model_reasoning_effort = "high"$/m);
    assert.match(content, /^\[features\]$/m);
    assert.match(content, /^hooks = true$/m);
    assert.doesNotMatch(content, /^codex_hooks\s*=/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureCodexHooksEnabled keeps codex_hooks for older codex versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hooks-legacy-'));

  try {
    const result = ensureCodexHooksEnabled({
      fs,
      hostHomeDir: root,
      codexVersion: '0.113.0',
      enableStopHook: true
    });

    assert.equal(result.ok, true);
    const content = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    assert.match(content, /\[features\]\ncodex_hooks = true/);
    assert.doesNotMatch(content, /^hooks\s*=/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureCodexHooksEnabled removes managed stop hook when notification hook is not enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hooks-disabled-'));
  const codexDir = path.join(root, '.codex');
  const hooksDir = path.join(codexDir, 'hooks');
  const hooksJsonPath = path.join(codexDir, 'hooks.json');

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `/usr/bin/env node "${path.join(hooksDir, 'aih-stop-notify.js')}"`,
                timeout: 10
              },
              {
                type: 'command',
                command: '/usr/bin/env node "/tmp/keep.js"',
                timeout: 10
              }
            ]
          }
        ]
      }
    }, null, 2) + '\n', 'utf8');

    const result = ensureCodexHooksEnabled({
      fs,
      hostHomeDir: root,
      codexVersion: '0.130.0',
      processObj: { env: {} }
    });

    assert.equal(result.ok, true);
    assert.equal(result.hookInstalled, false);
    assert.equal(result.hooksUpdated, true);
    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.equal(hooksConfig.hooks.Stop[0].hooks.length, 1);
    assert.equal(hooksConfig.hooks.Stop[0].hooks[0].command, '/usr/bin/env node "/tmp/keep.js"');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
