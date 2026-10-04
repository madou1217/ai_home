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
