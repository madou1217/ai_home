'use strict';

// 回归守卫（2026-11-06 真机）：WebUI agy chat 报
//
//   provider_resource_reconcile_incomplete:sessions
//
// agy 的投影是伪 HOME；Provider 会在 <projection>/.agy/sessions 里写自己的会话，
// 其中可能带指向投影外的活链接。共享存储里已有 sessions 时，合并只能搬走普通文件，
// 活链接留在原处 → 整个 sessions 目录被算成 unresolved。
//
// 启动对账（sessionLinksOnly）只需要 Provider **声明**的会话条目（agy: brain / conversations）；
// 启发式检测到的 sessions 不是声明的会话存储，启动时应原样留在投影里、不阻断聊天。
// 删除账号不走这个分支，仍然要求全量对账 —— 这个测试同时守住两侧边界。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { createSessionStoreService } = require('../lib/cli/services/session-store');

const ACCOUNT_REF = 'acct_agy000000000000001';

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-sessions-'));
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

function seedAgyProjection(home) {
  const projectionRoot = path.join(home, '.ai_home', 'run', 'auth-projections', 'agy', ACCOUNT_REF);
  const toolDir = path.join(projectionRoot, '.agy');
  const sessionsDir = path.join(toolDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'local.jsonl'), '{}\n');
  // 指向投影外的活链接：合并时不能跟随、不能删目标，只能原样留下。
  const external = path.join(home, 'external-target.txt');
  fs.writeFileSync(external, 'keep-me');
  fs.symlinkSync(external, path.join(sessionsDir, 'link-out'));
  // 宿主共享存储里已经有 sessions，迫使走 mergeDirectoryIntoStore 而不是整目录搬移。
  const storeSessions = path.join(home, '.agy', 'sessions');
  fs.mkdirSync(storeSessions, { recursive: true });
  fs.writeFileSync(path.join(storeSessions, 'old.jsonl'), '{}\n');

  // 再放一个**声明**的会话条目（agy: brain）做同样的活链接形态：
  // 启动时伪 HOME 一律降级为 warnings，不能因为声明的目录也卡住聊天。
  const brainDir = path.join(toolDir, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'local.json'), '{}\n');
  fs.symlinkSync(external, path.join(brainDir, 'link-out'));
  const storeBrain = path.join(home, '.agy', 'brain');
  fs.mkdirSync(storeBrain, { recursive: true });
  fs.writeFileSync(path.join(storeBrain, 'old.json'), '{}\n');

  return { projectionRoot, sessionsDir, brainDir, external };
}

test('agy 启动对账不再把伪 HOME 里的 sessions 当成未对账缺口', (t) => {
  const home = makeHome(t);
  const { sessionsDir, brainDir, external } = seedAgyProjection(home);
  const service = makeService(home);

  // 全量对账（删除账号/清理投影）：活链接不能被跟随或删除，必须继续 fail-closed。
  const full = service.ensureSessionStoreLinks('agy', ACCOUNT_REF, {});
  assert.equal(full.unresolved.includes('sessions'), true);
  assert.equal(full.unresolved.includes('brain'), true);

  // 启动对账：伪 HOME 的残余降级为 warnings，聊天不再被阻断。
  const launch = service.ensureSessionStoreLinks('agy', ACCOUNT_REF, { sessionLinksOnly: true });
  assert.equal(launch.unresolved, undefined, 'launch 不应再因伪 HOME 残余阻断聊天');
  assert.equal(fs.lstatSync(path.join(sessionsDir, 'link-out')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(brainDir, 'link-out')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(external, 'utf8'), 'keep-me');
});

test('WebUI chat 启动对账显式要求 sessionLinksOnly', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/server/native-session-chat.js'),
    'utf8',
  );
  const start = source.indexOf('const reconcileRuntimeResources');
  assert.notEqual(start, -1);
  const block = source.slice(start, source.indexOf('});', start));
  assert.match(block, /sessionLinksOnly:\s*true/);
});
