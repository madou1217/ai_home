'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listProviderSessionHistory, resolveProviderVersion } = require('../lib/cli/services/ai-cli/provider-inspect');

test('aih <cli> version：直接问原生 CLI，找不到二进制就说找不到（不猜）', () => {
  const found = resolveProviderVersion('codex', {
    resolveCommandPath: () => '/usr/local/bin/codex',
    spawnSync: () => ({ status: 0, stdout: 'codex-cli 0.163.0\n', stderr: '' })
  });
  assert.equal(found.ok, true);
  assert.equal(found.version, 'codex-cli 0.163.0');
  assert.equal(found.cliPath, '/usr/local/bin/codex');

  // 版本输出里夹着 node 的 ExperimentalWarning 时，取第一条真正的版本行
  const noisy = resolveProviderVersion('codex', {
    resolveCommandPath: () => '/usr/local/bin/codex',
    spawnSync: () => ({ status: 0, stdout: '(node:1) ExperimentalWarning: SQLite\ncodex-cli 0.163.0\n', stderr: '' })
  });
  assert.equal(noisy.version, 'codex-cli 0.163.0');

  const missing = resolveProviderVersion('kiro', { resolveCommandPath: () => '' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'cli_not_found');
});

test('aih <cli> sessions --history：从宿主会话库列出 id，按时间倒序并截断', () => {
  const readProjectsFromHostByProviders = () => ([
    { projectPath: '/proj/a', sessions: [{ id: 's-old', title: 'old', updatedAt: '100' }, { id: 's-new', title: 'new', updatedAt: '300' }] },
    { projectPath: '/proj/b', sessions: [{ id: 's-mid', updatedAt: '200' }, { id: '' }] }
  ]);
  const history = listProviderSessionHistory('codex', { limit: 2, readProjectsFromHostByProviders });
  assert.equal(history.ok, true);
  assert.equal(history.total, 3);
  assert.deepEqual(history.sessions.map((row) => row.id), ['s-new', 's-mid']);
  assert.equal(history.sessions[0].projectPath, '/proj/a');

  // 按账号隔离的 provider：宿主读不到就明确说「按账号隔离」，不假装空历史
  const scoped = listProviderSessionHistory('cline', { readProjectsFromHostByProviders: () => [] });
  assert.equal(scoped.ok, false);
  assert.equal(scoped.reason, 'account_scoped');

  const unavailable = listProviderSessionHistory('codex', {});
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'history_unavailable');
});

test('接线守卫：version 与 sessions --history 必须挂在 provider 派发上，且有宿主读取器注入', () => {
  const root = path.join(__dirname, '..');
  const router = fs.readFileSync(path.join(root, 'lib/cli/commands/ai-cli/router.js'), 'utf8');
  const wiring = fs.readFileSync(path.join(root, 'lib/cli/bootstrap/root-dispatch.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'lib/cli/app.js'), 'utf8');
  const help = fs.readFileSync(path.join(root, 'lib/cli/commands/help/messages.js'), 'utf8');

  assert.match(router, /idOrAction === 'version'/);
  assert.match(router, /resolveProviderVersion\(cliName/);
  assert.match(router, /--history/);
  assert.match(router, /listProviderSessionHistory\(cliName/);
  assert.match(wiring, /readProjectsFromHostByProviders: deps\.readProjectsFromHostByProviders/);
  assert.match(app, /readProjectsFromHostByProviders/);
  assert.match(help, /aih \$\{cliName\} version/);
  assert.match(help, /sessions --history/);
});
