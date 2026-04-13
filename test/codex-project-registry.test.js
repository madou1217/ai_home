const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureCodexHooksEnabled,
  ensureCodexProjectRegistered
} = require('../lib/server/codex-project-registry');

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

test('ensureCodexHooksEnabled writes feature flag, hook script and hooks json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hooks-'));

  try {
    const result = ensureCodexHooksEnabled({
      fs,
      hostHomeDir: root
    });

    assert.equal(result.ok, true);
    const configPath = path.join(root, '.codex', 'config.toml');
    const hooksJsonPath = path.join(root, '.codex', 'hooks.json');
    const hookScriptPath = path.join(root, '.codex', 'hooks', 'aih-stop-notify.js');

    assert.equal(fs.existsSync(configPath), true);
    assert.equal(fs.existsSync(hooksJsonPath), true);
    assert.equal(fs.existsSync(hookScriptPath), true);
    assert.match(fs.readFileSync(configPath, 'utf8'), /\[features\]\ncodex_hooks = true/);

    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.equal(Array.isArray(hooksConfig.hooks.Stop), true);
    assert.equal(
      hooksConfig.hooks.Stop.some((group) =>
        Array.isArray(group && group.hooks)
        && group.hooks.some((hook) => String(hook.command || '').includes('aih-stop-notify.js'))
      ),
      true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
