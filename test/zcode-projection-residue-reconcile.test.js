'use strict';

// 回归守卫（2026-11-04 真机）：zcode 账号 9（acct_cf38e…）删不掉，`aih zcode delete 9`
// 一直报
//
//   [aih] root router failed: provider_resource_reconcile_incomplete:.codex
//
// 根因：该账号的投影里有一个 codex 运行时留下的 `.codex/tmp/arg0/<id>/`，里面只有
// 三个 argv0 shim（apply_patch / applypatch / codex-execve-wrapper，全部指向
// node_modules 里的 codex 二进制）和空目录，**没有任何会话文件**。旧实现把它当成
// 未对账的会话资源 → 整个账号 fail-closed → 删号永远卡住。
//
// 守卫三件事：
//   1. 只剩「指向投影外的链接 + 空目录」的子树不算缺口（可删）；
//   2. 链接指向**投影内部**时仍然 fail-closed（目标会随投影一起删掉）；
//   3. 真有会话文件的条目照旧迁移进共享存储，不丢数据。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { createSessionStoreService } = require('../lib/cli/services/session-store');

const ACCOUNT_REF = 'acct_cf38e720d4aeb8a7934c';

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-residue-'));
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
  return path.join(home, '.ai_home', 'run', 'auth-projections', 'zcode', ACCOUNT_REF);
}

// 复刻真机形态：.codex/tmp/arg0/<id>/ 三个 shim 指向投影外的 codex 二进制。
// 宿主共享存储里已经有 .codex（真机一直存在），所以对账走「合并」而不是整目录搬家。
function seedSharedStore(home) {
  fs.mkdirSync(path.join(home, '.zcode', '.aih-runtime-home', '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
}

function seedCodexArg0Shims(home, projectionRoot) {
  const binary = path.join(home, 'node_modules', 'codex', 'codex');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'binary\n');
  const shimDir = path.join(projectionRoot, '.codex', 'tmp', 'arg0', 'codex-arg0d6qMHT');
  fs.mkdirSync(shimDir, { recursive: true });
  for (const name of ['apply_patch', 'applypatch', 'codex-execve-wrapper']) {
    fs.symlinkSync(binary, path.join(shimDir, name));
  }
  return binary;
}

test('只剩 argv0 shim 的 .codex 不再阻断对账（真机账号 9 删不掉的根因）', (t) => {
  const home = makeHome(t);
  const projectionRoot = projectionRootOf(home);
  seedSharedStore(home);
  seedCodexArg0Shims(home, projectionRoot);
  fs.mkdirSync(path.join(projectionRoot, '.zcode', 'v2'), { recursive: true });

  const result = makeService(home).ensureSessionStoreLinks('zcode', ACCOUNT_REF);

  assert.equal(result.unresolved, undefined, `unexpected unresolved: ${JSON.stringify(result.unresolved)}`);
});

test('链接指向投影内部时仍然 fail-closed（目标会随投影一起删）', (t) => {
  const home = makeHome(t);
  const projectionRoot = projectionRootOf(home);
  seedSharedStore(home);
  const innerTarget = path.join(projectionRoot, '.zcode', 'v2', 'credentials.json');
  fs.mkdirSync(path.dirname(innerTarget), { recursive: true });
  fs.writeFileSync(innerTarget, '{}\n');
  const shimDir = path.join(projectionRoot, '.codex', 'tmp', 'arg0', 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.symlinkSync(innerTarget, path.join(shimDir, 'linked-credential'));

  const result = makeService(home).ensureSessionStoreLinks('zcode', ACCOUNT_REF);

  assert.ok(
    Array.isArray(result.unresolved) && result.unresolved.includes(path.join('.codex')),
    `expected .codex to stay unresolved, got ${JSON.stringify(result.unresolved)}`
  );
});

test('真有会话文件时照旧迁移进共享存储，不丢数据', (t) => {
  const home = makeHome(t);
  const projectionRoot = projectionRootOf(home);
  seedSharedStore(home);
  const sessionFile = path.join(projectionRoot, '.codex', 'sessions', '2026', 'rollout.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '{"type":"session"}\n');

  const result = makeService(home).ensureSessionStoreLinks('zcode', ACCOUNT_REF);

  assert.equal(result.unresolved, undefined, `unexpected unresolved: ${JSON.stringify(result.unresolved)}`);
  const migrated = path.join(home, '.zcode', '.aih-runtime-home', '.codex', 'sessions', '2026', 'rollout.jsonl');
  assert.equal(fs.existsSync(migrated), true, 'session file should be migrated into the shared store');
  assert.equal(fs.readFileSync(migrated, 'utf8'), '{"type":"session"}\n');
});
