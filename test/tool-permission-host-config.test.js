'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyHostPermission,
  buildHostPermissionContent,
  patchJson,
  patchTomlTopLevel
} = require('../lib/cli/services/toolkit/permission-host-config');

test('host permission patch keeps nested claude settings and comments', () => {
  const source = `{
  // 用户自己的允许列表
  "permissions": {
    "allow": ["Bash(npm test)"] // 保留
  },
  "env": { "FOO": "bar" }
}
`;
  const next = patchJson(source, { 'permissions.defaultMode': 'bypassPermissions' });
  assert.match(next, /Bash\(npm test\)/);
  assert.match(next, /bypassPermissions/);
  assert.match(next, /用户自己的允许列表/);
  assert.doesNotMatch(next, /defaultMode.*\n.*defaultMode/);
  assert.equal(JSON.parse(next.replace('// 用户自己的允许列表', '').replace('// 保留', '')).env.FOO, 'bar');
});

test('host permission patch replaces top-level codex TOML keys without touching tables', () => {
  const source = `# 用户注释
model = "gpt-5"
approval_policy = "on-request"

[features]
web_search = true
`;
  const next = patchTomlTopLevel(source, {
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access'
  });
  assert.match(next, /^sandbox_mode = "danger-full-access"/);
  assert.match(next, /approval_policy = "never"/);
  assert.match(next, /# 用户注释/);
  assert.match(next, /\[features\]\nweb_search = true/);
  assert.doesNotMatch(next, /approval_policy = "on-request"/);
});

test('buildHostPermissionContent uses JSON for JSONC and TOML for TOML', () => {
  const json = buildHostPermissionContent('', 'json', { permission: 'allow' });
  assert.equal(JSON.parse(json).permission, 'allow');
  const toml = buildHostPermissionContent('', 'toml', { approval_policy: 'never' });
  assert.equal(toml.trim(), 'approval_policy = "never"');
});

test('applyHostPermission writes the verified provider host field and is idempotent', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-permission-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const options = {
    fs,
    path,
    os,
    hostHomeDir: hostHome,
    env: process.env,
    platform: process.platform,
    resolveCliInfo: () => ({ installed: false, version: '' })
  };

  const first = applyHostPermission('claude', options);
  assert.equal(first.supported, true);
  assert.equal(first.applied, true);
  assert.equal(first.changed, true);
  const target = path.join(hostHome, '.claude', 'settings.json');
  const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(saved.permissions.defaultMode, 'bypassPermissions');

  const second = applyHostPermission('claude', options);
  assert.equal(second.changed, false);
});
