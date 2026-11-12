'use strict';

// 回归守卫（2026-11-03 真机）：WebUI「安装并打开 ZCode（账号）」时宿主进程起不来，
// 启动状态 JSON 报 failedPhase=preparing_host_storage / errorCode=sql_failed /
// systemCode=ENOENT。
//
// 根因不在数据库内容（同一份 tasks-index.sqlite 拷到别处能正常迁移到 ready），
// 而在投影里的一条**悬空链接**：旧版本把宿主 `~/.zcode` 下的每个条目都链进账号
// 投影，后来收窄成声明表；宿主 `~/.zcode/backup` 被删后，投影里的
// `.zcode/backup -> <host>/.zcode/backup` 就悬空了。ZCode 迁移前要在
// `<dataRoot>/backup` 建目录，`mkdir(recursive)` 在悬空链接上返回 ENOENT
// （父目录存在，只是最后一段解析不到），迁移备份失败 → sql_failed。
//
// 守卫两层：
//   1. 链接卫生：只删「指向共享根且目标已消失」的一级链接，声明共享的条目
//      （含故意悬挂的 -wal/-shm 侧车）与账号私有链接一律不动。
//   2. 行为等价：修完之后 `mkdir(<projection>/.zcode/backup, {recursive:true})`
//      必须成功——这正是 ZCode 失败的那一步。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureZcodeSharedSessionState,
  repairZcodeProjectionLinks
} = require('../lib/cli/services/ai-cli/launch-profile/zcode-shared-session-store');

function makeRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-links-'));
  const hostHome = path.join(root, 'host');
  const sandbox = path.join(root, 'sandbox');
  fs.mkdirSync(path.join(hostHome, '.zcode', 'v2'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, '.zcode', 'v2'), { recursive: true });
  return { root, hostHome, sandbox };
}

function link(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
}

test('悬空共享链接被清掉，声明条目与私有链接不动', () => {
  const { root, hostHome, sandbox } = makeRoots();
  const projectionRoot = path.join(sandbox, '.zcode');
  const sharedRoot = path.join(hostHome, '.zcode');

  // 宿主真实存在的目录 → 链接保留。
  fs.mkdirSync(path.join(sharedRoot, 'workspace'), { recursive: true });
  link(path.join(sharedRoot, 'workspace'), path.join(projectionRoot, 'workspace'));
  // 宿主已被删的目标 → 悬空，必须清掉（真机就是 backup）。
  link(path.join(sharedRoot, 'backup'), path.join(projectionRoot, 'backup'));
  // 指向共享根之外的账号私有链接 → 不动。
  const privateTarget = path.join(root, 'private', 'cache');
  fs.mkdirSync(privateTarget, { recursive: true });
  link(privateTarget, path.join(projectionRoot, 'cache'));
  // 声明共享的侧车本来就故意悬挂 → 不动。
  link(path.join(sharedRoot, 'v2', 'tasks-index.sqlite-wal'), path.join(projectionRoot, 'v2', 'tasks-index.sqlite-wal'));
  // 真实目录 → 不动。
  fs.mkdirSync(path.join(projectionRoot, 'logs'), { recursive: true });

  const repaired = repairZcodeProjectionLinks({ sandboxDir: sandbox, hostHomeDir: hostHome });

  assert.deepEqual(repaired.removed, ['backup']);
  assert.deepEqual(repaired.errors, []);
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'backup'), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'workspace')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'cache')).isSymbolicLink(), true);
  assert.equal(
    fs.lstatSync(path.join(projectionRoot, 'v2', 'tasks-index.sqlite-wal')).isSymbolicLink(),
    true
  );
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'logs')).isDirectory(), true);

  // 这一步是 ZCode 真机失败的那一步：悬空链接在时 mkdir 抛 ENOENT。
  fs.mkdirSync(path.join(projectionRoot, 'backup'), { recursive: true });
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'backup')).isDirectory(), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test('旧代码路径：悬空链接下 mkdir(recursive) 就是 ENOENT', () => {
  const { root, hostHome, sandbox } = makeRoots();
  const projectionRoot = path.join(sandbox, '.zcode');
  link(path.join(hostHome, '.zcode', 'backup'), path.join(projectionRoot, 'backup'));

  assert.throws(
    () => fs.mkdirSync(path.join(projectionRoot, 'backup'), { recursive: true }),
    (error) => error && error.code === 'ENOENT'
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('启动准备：先修链接，再建共享链接，summary 报告 pruned', () => {
  const { root, hostHome, sandbox } = makeRoots();
  const projectionRoot = path.join(sandbox, '.zcode');
  link(path.join(hostHome, '.zcode', 'backup'), path.join(projectionRoot, 'backup'));
  fs.mkdirSync(path.join(hostHome, '.zcode', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(hostHome, '.zcode', 'v2', 'tasks-index.sqlite'), '');

  const summary = ensureZcodeSharedSessionState({ sandboxDir: sandbox, hostHomeDir: hostHome });

  assert.deepEqual(summary.pruned, ['backup']);
  assert.equal(summary.errors.length, 0);
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'cli')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'v2', 'tasks-index.sqlite')).isSymbolicLink(), true);
  fs.mkdirSync(path.join(projectionRoot, 'backup'), { recursive: true });
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'backup')).isDirectory(), true);

  // 幂等：再跑一次没有可清理的，也不报错。
  const again = ensureZcodeSharedSessionState({ sandboxDir: sandbox, hostHomeDir: hostHome });
  assert.deepEqual(again.pruned, []);
  assert.equal(again.errors.length, 0);

  fs.rmSync(root, { recursive: true, force: true });
});
