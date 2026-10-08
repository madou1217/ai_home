'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  REMOTE_PRESERVED,
  TAR_EXCLUDES,
  buildRemoteScript,
  parseArgs,
  remotePath
} = require('../scripts/deploy-server');

test('deploy-server 参数：需要 SSH 目标，可从环境变量读取，非法值被拒绝', () => {
  assert.throws(() => parseArgs([], {}), /missing --ssh/);
  const fromEnv = parseArgs([], { AIH_DEPLOY_SSH: 'ubuntu@host', AIH_DEPLOY_SSH_KEY: '~/.ssh/k.pem' });
  assert.equal(fromEnv.ssh, 'ubuntu@host');
  assert.equal(fromEnv.sshKey, '~/.ssh/k.pem');
  assert.equal(fromEnv.ref, 'origin/main');
  assert.equal(fromEnv.remoteDir, '~/ai_home');
  assert.equal(parseArgs(['--ssh', 'a@b', '--no-restart', '--port', '9600'], {}).restart, false);
  assert.throws(() => parseArgs(['--ssh', 'a@b', '--unit', 'x; rm -rf /'], {}), /invalid --unit/);
  assert.throws(() => parseArgs(['--ssh', 'a@b', '--remote-dir', '$(whoami)'], {}), /invalid --remote-dir/);
  assert.throws(() => parseArgs(['--ssh'], {}), /requires a value/);
  assert.equal(remotePath('~/ai_home'), `"$HOME"/'ai_home'`);
});

test('deploy-server 远端脚本：单目录原地更新，预检通过才覆盖，保留依赖/运行时/数据', () => {
  const script = buildRemoteScript(parseArgs(['--ssh', 'a@b'], {}));
  const preflight = script.indexOf('preflight load');
  const rsync = script.indexOf('rsync -a --delete');
  assert.ok(preflight > 0 && rsync > preflight, '预检必须在覆盖代码之前');
  for (const item of REMOTE_PRESERVED) assert.match(script, new RegExp(`--exclude '/${item.replace('.', '\\.')}'`));
  assert.doesNotMatch(script, /pkill -f|pgrep -f/, 'ssh 下按命令行匹配会杀掉会话自身');
  assert.doesNotMatch(script, /releases|retired|node-modules-cache/, '不创建任何版本或缓存目录');
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /systemctl --user restart 'aih-server'/);
  assert.match(script, /readyz/);
  assert.ok(TAR_EXCLUDES.includes('./.git') && TAR_EXCLUDES.includes('./node_modules'));

  const noRestart = buildRemoteScript(parseArgs(['--ssh', 'a@b', '--no-restart'], {}));
  assert.doesNotMatch(noRestart, /systemctl --user restart/);

  if (process.platform !== 'win32') {
    for (const text of [script, noRestart]) {
      const syntax = spawnSync('bash', ['-n'], { input: text, encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
});

// ---- P1：部署必须带上远端平台的 Go Core 二进制，且不能在没带的时候删掉远端那份 ----

const {
  REMOTE_PRESERVED_WITHOUT_GO,
  parseRemoteGoTarget,
  remotePreserved
} = require('../scripts/deploy-server');
const { buildGoServerPlan } = require('../scripts/build-go-server');

test('deploy-server 远端 Go 目标：按 uname 探测，认不出来就交回调用方失败关闭', () => {
  assert.deepEqual(parseRemoteGoTarget('Linux x86_64'), { platform: 'linux', arch: 'x64' });
  assert.deepEqual(parseRemoteGoTarget('Linux aarch64'), { platform: 'linux', arch: 'arm64' });
  assert.deepEqual(parseRemoteGoTarget('Darwin arm64'), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(parseRemoteGoTarget('MINGW64_NT-10.0-22631 x86_64'), { platform: 'win32', arch: 'x64' });
  assert.deepEqual(parseRemoteGoTarget('  Linux  amd64 \n'), { platform: 'linux', arch: 'x64' });
  // 未知平台/架构返回 null：部署一个起不来的二进制比不部署更糟。
  assert.equal(parseRemoteGoTarget('FreeBSD x86_64'), null);
  assert.equal(parseRemoteGoTarget('Linux riscv64'), null);
  assert.equal(parseRemoteGoTarget('Linux'), null);
  assert.equal(parseRemoteGoTarget(''), null);
});

test('deploy-server 参数：--go-target 与 --skip-go-build 互斥且各自可用', () => {
  assert.equal(parseArgs(['--ssh', 'a@b'], {}).goTarget, '');
  assert.equal(parseArgs(['--ssh', 'a@b'], {}).skipGoBuild, false);
  assert.equal(parseArgs(['--ssh', 'a@b'], { AIH_DEPLOY_GO_TARGET: 'linux-arm64' }).goTarget, 'linux-arm64');
  assert.equal(parseArgs(['--ssh', 'a@b', '--go-target', 'win32-x64'], {}).goTarget, 'win32-x64');
  assert.equal(parseArgs(['--ssh', 'a@b', '--skip-go-build'], {}).skipGoBuild, true);
  assert.throws(() => parseArgs(['--ssh', 'a@b', '--go-target', 'linux; rm -rf /'], {}), /invalid --go-target/);
  assert.throws(
    () => parseArgs(['--ssh', 'a@b', '--go-target', 'linux-x64', '--skip-go-build'], {}),
    /mutually exclusive/
  );
});

test('deploy-server 保留名单：跳过 Go 构建时必须保住远端 bin/native', () => {
  assert.deepEqual(remotePreserved({}), REMOTE_PRESERVED);
  assert.deepEqual(remotePreserved({ skipGoBuild: true }), REMOTE_PRESERVED_WITHOUT_GO);
  assert.ok(REMOTE_PRESERVED_WITHOUT_GO.includes('bin/native'));

  // 正常路径不带这条排除：归档里有本次交叉编译出来的远端平台二进制，必须能覆盖上去。
  const shipped = buildRemoteScript(parseArgs(['--ssh', 'a@b'], {}));
  assert.doesNotMatch(shipped, /--exclude '\/bin\/native'/);
  // 跳过构建时归档里没有 bin/native，不带排除就会被 rsync --delete 删掉。
  const skipped = buildRemoteScript(parseArgs(['--ssh', 'a@b', '--skip-go-build'], {}));
  assert.match(skipped, /--exclude '\/bin\/native'/);
});

test('deploy-server 在临时 worktree 里按目标平台交叉编译 Go Core', () => {
  // 产物路径必须落在待打包目录树内，否则归档不带 Go 二进制。
  const plan = buildGoServerPlan({ repositoryRoot: '/tmp/aih-worktree', platform: 'linux', arch: 'x64' });
  assert.equal(plan.output, '/tmp/aih-worktree/bin/native/linux-x64/aih-server');
  assert.equal(plan.target, 'linux-x64');
  assert.equal(plan.env.GOOS, 'linux');
  assert.equal(plan.env.GOARCH, 'amd64');
  assert.equal(plan.env.CGO_ENABLED, '0');
  assert.deepEqual(plan.args.slice(0, 2), ['build', '-trimpath']);
  // 先编译到同目录临时文件再原子改名：直接覆写会让正在运行的旧进程被系统杀掉。
  assert.notEqual(plan.temporaryOutput, plan.output);
  assert.ok(plan.temporaryOutput.startsWith(plan.output));

  const windows = buildGoServerPlan({ repositoryRoot: '/tmp/aih-worktree', platform: 'win32', arch: 'x64' });
  assert.equal(windows.output, '/tmp/aih-worktree/bin/native/win32-x64/aih-server.exe');
  assert.equal(windows.env.GOOS, 'windows');
  assert.throws(() => buildGoServerPlan({ repositoryRoot: '/tmp/aih-worktree', platform: 'plan9', arch: 'x64' }), /unsupported Go Core target/);
});
