'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  exportConfigFile,
  listConfigHistory,
  listConfigProviders,
  readConfigFile,
  readConfigHistoryEntry,
  restoreConfigHistoryEntry,
  saveConfigFile,
  validateConfigFile,
  validateContent
} = require('../lib/cli/services/toolkit/provider-config-manager');
const { historyFile } = require('../lib/cli/services/toolkit/provider-config-history');

function createHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-config-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.codex', 'config.toml'),
    'model = "gpt-5"\nexperimental_bearer_token = "top-secret"\n\n[mcp_servers.demo]\ncommand = "node"\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { access_token: 'access-value', refresh_token: 'refresh-value', account_id: 'acct-1' },
      last_refresh: '2026-10-19T00:00:00Z'
    }, null, 2),
    { mode: 0o600 }
  );
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'opencode', 'opencode.json'),
    '{\n  // 用户注释\n  "model": "anthropic/claude",\n  "theme": "system",\n}\n',
    { mode: 0o600 }
  );
  return home;
}

function optionsFor(home, extra = {}) {
  return {
    hostHomeDir: home,
    aiHomeDir: path.join(home, '.ai_home'),
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    platform: 'darwin',
    resolveCliInfo: () => ({ installed: true, version: '0.163.0', path: 'codex' }),
    ...extra
  };
}

test('provider config list is declarative and never exposes absolute host paths', () => {
  const home = createHome();
  const result = listConfigProviders(optionsFor(home));
  const codex = result.providers.find((provider) => provider.id === 'codex');
  assert.ok(codex);
  assert.deepEqual(codex.files.map((file) => file.id), ['config', 'auth', 'hooks']);
  const config = codex.files.find((file) => file.id === 'config');
  assert.equal(config.exists, true);
  assert.equal(config.displayPath, '~/.codex/config.toml');
  assert.equal(JSON.stringify(result).includes(home), false);
  assert.ok(result.providers.length >= 10);
  assert.ok(result.total >= 20);
});

test('provider config detail includes schema, CLI version and compatibility status', () => {
  const home = createHome();
  const detail = readConfigFile('codex', 'config', optionsFor(home));
  assert.equal(detail.file.exists, true);
  assert.equal(detail.file.format, 'toml');
  assert.equal(detail.cli.version, '0.163.0');
  assert.ok(detail.schema.fieldCount > 100);
  assert.equal(detail.schemaVersion.mismatch, false);
  assert.match(detail.content, /model = "gpt-5"/);
});

test('provider config detail can describe a file that does not exist yet', () => {
  const home = createHome();
  const detail = readConfigFile('codex', 'hooks', optionsFor(home));
  assert.equal(detail.file.exists, false);
  assert.equal(detail.content, '');
  assert.equal(detail.file.canCreate, true);
});

test('saving creates a baseline snapshot, writes atomically and records history', () => {
  const home = createHome();
  const target = path.join(home, '.codex', 'config.toml');
  const before = readConfigFile('codex', 'config', optionsFor(home));
  const nextContent = `${before.content}approval_policy = "never"\n`;
  const saved = saveConfigFile('codex', 'config', nextContent, {
    ...optionsFor(home),
    expectedRevision: before.revision
  });
  assert.equal(saved.changed, true);
  assert.equal(saved.historyEntry.reason, 'save');
  assert.equal(fs.readFileSync(target, 'utf8'), nextContent);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);

  const history = listConfigHistory('codex', 'config', optionsFor(home));
  assert.deepEqual(history.entries.map((entry) => entry.reason), ['save', 'baseline']);
  assert.ok(fs.existsSync(historyFile('codex', 'config', {
    aiHomeDir: path.join(home, '.ai_home')
  })));
});

test('stale revision is rejected and the file is untouched', () => {
  const home = createHome();
  const target = path.join(home, '.codex', 'config.toml');
  const before = fs.readFileSync(target, 'utf8');
  assert.throws(
    () => saveConfigFile('codex', 'config', 'model = "other"\n', {
      ...optionsFor(home),
      expectedRevision: 'stale-revision'
    }),
    (error) => error.code === 'provider_config_conflict'
  );
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('invalid syntax is rejected before the write', () => {
  const home = createHome();
  const target = path.join(home, '.codex', 'config.toml');
  const before = fs.readFileSync(target, 'utf8');
  assert.throws(
    () => saveConfigFile('codex', 'config', 'model = [', optionsFor(home)),
    (error) => error.code === 'provider_config_validation_failed' && error.validation.valid === false
  );
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  const validation = validateConfigFile('codex', 'config', 'model = [', optionsFor(home));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
});

test('jsonc accepts comments and rejects broken documents', () => {
  assert.equal(validateContent('{\n // comment\n "a": 1,\n}', 'jsonc').valid, true);
  assert.equal(validateContent('{"a": }', 'jsonc').valid, false);
});

test('history restore brings back the baseline content', () => {
  const home = createHome();
  const target = path.join(home, '.codex', 'config.toml');
  const original = fs.readFileSync(target, 'utf8');
  const before = readConfigFile('codex', 'config', optionsFor(home));
  saveConfigFile('codex', 'config', `${original}# changed\n`, {
    ...optionsFor(home),
    expectedRevision: before.revision
  });
  const history = listConfigHistory('codex', 'config', optionsFor(home));
  const baseline = history.entries.find((entry) => entry.reason === 'baseline');
  assert.ok(baseline);
  const entry = readConfigHistoryEntry('codex', 'config', baseline.id, optionsFor(home));
  assert.equal(entry.entry.content, original);
  const restored = restoreConfigHistoryEntry('codex', 'config', baseline.id, optionsFor(home));
  assert.equal(restored.historyEntry.reason, 'restore');
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('redacted export removes secrets but keeps structure', () => {
  const home = createHome();
  const config = exportConfigFile('codex', 'config', 'redacted', optionsFor(home));
  assert.equal(config.mode, 'redacted');
  assert.match(config.content, /model = "gpt-5"/);
  assert.doesNotMatch(config.content, /top-secret/);
  assert.match(config.content, /<redacted>/);

  const auth = exportConfigFile('codex', 'auth', 'redacted', optionsFor(home));
  assert.doesNotMatch(auth.content, /access-value|refresh-value|acct-1/);
  assert.match(auth.content, /"type"|access_token/);
  assert.equal(auth.parsed, true);

  const raw = exportConfigFile('codex', 'config', 'raw', optionsFor(home));
  assert.match(raw.content, /top-secret/);
});

test('unknown provider files are rejected instead of touching arbitrary paths', () => {
  const home = createHome();
  assert.throws(
    () => readConfigFile('codex', '../../etc/passwd', optionsFor(home)),
    (error) => error.code === 'provider_config_unknown_file'
  );
});

test('saving a missing file creates it with the declared path', () => {
  const home = createHome();
  const saved = saveConfigFile('codex', 'hooks', '{"hooks":{}}\n', optionsFor(home));
  assert.equal(saved.changed, true);
  const target = path.join(home, '.codex', 'hooks.json');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"hooks":{}}\n');
});
