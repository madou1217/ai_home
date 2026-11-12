'use strict';

// 回归守卫（2026-11-06 真机）：WebUI Chat 整轮起不来，报
//
//   provider_resource_reconcile_incomplete:sessions 3
//
// `sessions 3` 是 Finder / 资源管理器复制 `sessions` 目录留下的**复制残留**
// （`sessions 2`、`sessions copy`、`sessions copy 2` 同理）。它不是 provider 声明的
// 会话条目，不参与建链；旧实现把它当「未对账的会话资源」→ 整个账号 / 聊天 harness
// fail-closed。
//
// 守卫两件事：
//   1. 复制残留不再阻断对账（数据原样留在投影里，不迁移、不删除）；
//   2. 容忍范围必须窄：其它来历不明的链接照旧 fail-closed。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { createSessionStoreService } = require('../lib/cli/services/session-store');

const ACCOUNT_REF = 'acct_dup0001';

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dup-session-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function makeService(home) {
  return createSessionStoreService({
    fs,
    fse,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir: path.join(home, '.ai_home'),
    hostHomeDir: home,
    cliConfigs: {},
    getProfileDir: (provider, id) => path.join(home, '.ai_home', 'run', 'auth-projections', provider, id),
    ensureDir: (directoryPath) => fs.mkdirSync(directoryPath, { recursive: true })
  });
}

function projectionRootOf(home) {
  return path.join(home, '.ai_home', 'run', 'auth-projections', 'codex', ACCOUNT_REF);
}

function seedHostSessions(home) {
  const hostSessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(hostSessions, { recursive: true });
  fs.writeFileSync(path.join(hostSessions, 'rollout-1.jsonl'), '{}\n');
  return hostSessions;
}

test('复制残留 sessions 3 不再阻断会话对账', (t) => {
  const home = makeHome(t);
  const hostSessions = seedHostSessions(home);
  const projectionRoot = projectionRootOf(home);
  fs.mkdirSync(path.join(projectionRoot, '.codex'), { recursive: true });
  // 真机形态：复制 `sessions` 链接得到 `sessions 3`。
  fs.symlinkSync(hostSessions, path.join(projectionRoot, 'sessions 3'));
  fs.symlinkSync(hostSessions, path.join(projectionRoot, 'sessions copy'));

  const result = makeService(home).ensureSessionStoreLinks('codex', ACCOUNT_REF);

  const unresolved = result.unresolved || [];
  assert.equal(unresolved.includes('sessions 3'), false, `unexpected unresolved: ${unresolved}`);
  assert.equal(unresolved.includes('sessions copy'), false, `unexpected unresolved: ${unresolved}`);
  // 数据仍在原处：既不迁移也不删除。
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'sessions 3')).isSymbolicLink(), true);
});

test('容忍范围只覆盖会话目录的复制残留，其它未知链接照旧 fail-closed', (t) => {
  const home = makeHome(t);
  const hostSessions = seedHostSessions(home);
  const projectionRoot = projectionRootOf(home);
  fs.mkdirSync(path.join(projectionRoot, '.codex'), { recursive: true });
  fs.symlinkSync(hostSessions, path.join(projectionRoot, 'sessions 3'));
  fs.symlinkSync(hostSessions, path.join(projectionRoot, 'stray-link'));

  const result = makeService(home).ensureSessionStoreLinks('codex', ACCOUNT_REF);

  assert.deepEqual(result.unresolved, ['stray-link']);
});
