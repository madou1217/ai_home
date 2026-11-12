'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULTS,
  UPLOAD_TRANSPORTS,
  parseArgs,
  rsyncAppendFlag,
  uploadArchive
} = require('../scripts/deploy-server');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'deploy-server.js');
const baseOptions = () => parseArgs(['--ssh', 'ubuntu@example.test']);

test('上传通道是注册表：scp / rsync 都只是具体实现', () => {
  assert.deepStrictEqual(Object.keys(UPLOAD_TRANSPORTS).sort(), ['rsync', 'scp']);
  for (const [key, transport] of Object.entries(UPLOAD_TRANSPORTS)) {
    assert.strictEqual(transport.name, key);
    assert.strictEqual(typeof transport.command, 'string');
    assert.strictEqual(typeof transport.args, 'function');
    assert.strictEqual(typeof transport.resumable, 'boolean');
    assert.ok(transport.label.length > 0);
  }
});

test('默认走 rsync——慢链路上只有它能续传', () => {
  assert.strictEqual(DEFAULTS.upload, 'rsync');
  assert.strictEqual(baseOptions().upload, 'rsync');
  assert.strictEqual(UPLOAD_TRANSPORTS.rsync.resumable, true);
  assert.strictEqual(UPLOAD_TRANSPORTS.scp.resumable, false);
});

test('rsync 参数带 --partial 和续传旗标，scp 不带（续传能力的真值源）', () => {
  const rsyncArgs = UPLOAD_TRANSPORTS.rsync.args(baseOptions(), '/tmp/a.tgz', '/tmp/b.tgz');
  assert.ok(rsyncArgs.includes('--partial'));
  assert.ok(rsyncArgs.includes(rsyncAppendFlag()));
  const scpArgs = UPLOAD_TRANSPORTS.scp.args(baseOptions(), '/tmp/a.tgz', '/tmp/b.tgz');
  assert.ok(!scpArgs.includes('--partial'));
  assert.ok(!scpArgs.includes('--append'));
  assert.ok(!scpArgs.includes('--append-verify'));
});

test('续传旗标跟着本机 rsync 实现走：openrsync 只有 --append，GNU 才有 --append-verify', () => {
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
  const version = `${probe.stdout || ''}${probe.stderr || ''}`;
  const expected = /openrsync/i.test(version) ? '--append' : '--append-verify';
  assert.strictEqual(rsyncAppendFlag(), expected);
  // 写死 --append-verify 会在 macOS 自带的 openrsync 上直接 unrecognized option
  assert.ok(UPLOAD_TRANSPORTS.rsync.args(baseOptions(), 'a', 'b').includes(expected));
});

test('两条通道都复用同一份 ssh 参数（BatchMode / ConnectTimeout / 密钥）', () => {
  const options = parseArgs(['--ssh', 'u@h', '--ssh-key', '~/.ssh/deploy-key.pem']);
  const rsyncArgs = UPLOAD_TRANSPORTS.rsync.args(options, 'a', 'b');
  const sshLine = rsyncArgs[rsyncArgs.indexOf('-e') + 1];
  assert.match(sshLine, /^ssh /);
  assert.match(sshLine, /BatchMode=yes/);
  assert.match(sshLine, /ConnectTimeout=20/);
  assert.match(sshLine, /deploy-key\.pem/);
  const scpArgs = UPLOAD_TRANSPORTS.scp.args(options, 'a', 'b');
  assert.deepStrictEqual(scpArgs.slice(0, 3), ['-q', '-o', 'BatchMode=yes']);
  assert.ok(scpArgs.some((item) => item.includes('deploy-key.pem')), 'scp 也要带上密钥');
});

test('带空格的密钥路径在 -e 里被引号包住，否则 rsync 会把它拆成两个参数', () => {
  const options = parseArgs(['--ssh', 'u@h', '--ssh-key', '/tmp/a b/key.pem']);
  const rsyncArgs = UPLOAD_TRANSPORTS.rsync.args(options, 'a', 'b');
  const sshLine = rsyncArgs[rsyncArgs.indexOf('-e') + 1];
  assert.match(sshLine, /'\/tmp\/a b\/key\.pem'/);
});

test('--upload 只接受注册表里的通道，写错立刻报错而不是静默回退', () => {
  assert.strictEqual(parseArgs(['--ssh', 'u@h', '--upload', 'scp']).upload, 'scp');
  assert.strictEqual(parseArgs(['--ssh', 'u@h', '--upload', 'rsync']).upload, 'rsync');
  assert.throws(() => parseArgs(['--ssh', 'u@h', '--upload', 'ftp']), /invalid --upload/);
  assert.throws(() => uploadArchive({ upload: 'ftp' }, 'a', 'b'), /unknown upload transport/);
});

test('续传通道的重试次数多于不续传通道：前者每次都在前进，后者重试等于从头再来', () => {
  assert.ok(Number.isInteger(UPLOAD_TRANSPORTS.rsync.maxAttempts));
  assert.ok(Number.isInteger(UPLOAD_TRANSPORTS.scp.maxAttempts));
  assert.ok(UPLOAD_TRANSPORTS.rsync.maxAttempts > UPLOAD_TRANSPORTS.scp.maxAttempts);
});

test('上传完要对长度：--append 不校验内容，长度不符必须删掉重来而不是接着追加', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(source.includes('uploaded size mismatch'), '缺少长度校验');
  assert.ok(source.includes('remoteArtifactSize'), '缺少远端长度探测');
});

test('源码守卫：main 里只经 uploadArchive 上传，不再直接 run scp', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(source.includes('uploadArchive(options, resolved.artifact, remoteArtifact'), '主流程应调用 uploadArchive');
  assert.ok(!/run\('scp'/.test(source), '不应再出现硬编码的 run(\'scp\')');
  assert.ok(!/npm install --/.test(source), '二进制部署不应在远端执行 npm install');
});
