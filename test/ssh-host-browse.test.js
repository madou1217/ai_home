'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_BROWSE_TIMEOUT_MS,
  browseRemoteDirectories,
  joinRemotePath,
  parentRemotePath,
  parseListDirOutput,
  resolveBrowsePath
} = require('../lib/server/ssh-host-browse');

// dialect.listDir 的输入输出都按 tab 分隔：type\tsize\tmtime\tname
function listOutput(lines) {
  return lines.join('\n');
}

function fakeService({ home = '/Users/model', dialectId = 'posix', stdout = '', code = 0, stderr = '' } = {}) {
  const calls = [];
  const dialect = { id: dialectId, listDir: (target) => `listDir:${target}` };
  const machine = {
    profile: async () => ({ home, dialect, os: dialectId === 'powershell' ? 'windows' : 'linux' }),
    exec: async (command, options) => {
      calls.push({ command, options });
      return { code, stdout, stderr, truncated: false };
    }
  };
  return { service: { machine: () => machine }, calls };
}

test('resolveBrowsePath 把空值 / ~ / 相对路径都折成家目录下的绝对路径', () => {
  assert.equal(resolveBrowsePath('', '/Users/model', 'posix'), '/Users/model');
  assert.equal(resolveBrowsePath('   ', '/Users/model', 'posix'), '/Users/model');
  assert.equal(resolveBrowsePath('~', '/Users/model', 'posix'), '/Users/model');
  assert.equal(resolveBrowsePath('~/projects', '/Users/model', 'posix'), '/Users/model/projects');
  assert.equal(resolveBrowsePath('projects/ai_home', '/Users/model', 'posix'), '/Users/model/projects/ai_home');
  assert.equal(resolveBrowsePath('/etc', '/Users/model', 'posix'), '/etc');
  assert.equal(resolveBrowsePath('/', '/Users/model', 'posix'), '/');
});

test('resolveBrowsePath 在 PowerShell 方言下用反斜杠拼接，盘符路径原样保留', () => {
  assert.equal(resolveBrowsePath('', 'C:\\Users\\model', 'powershell'), 'C:\\Users\\model');
  assert.equal(resolveBrowsePath('projects', 'C:\\Users\\model', 'powershell'), 'C:\\Users\\model\\projects');
  assert.equal(resolveBrowsePath('D:\\work', 'C:\\Users\\model', 'powershell'), 'D:\\work');
});

test('parentRemotePath 处理 POSIX 根目录、尾斜杠和 Windows 盘符', () => {
  assert.equal(parentRemotePath('/Users/model/projects', 'posix'), '/Users/model');
  assert.equal(parentRemotePath('/Users/model/', 'posix'), '/Users');
  assert.equal(parentRemotePath('/Users', 'posix'), '/');
  assert.equal(parentRemotePath('/', 'posix'), '/');
  assert.equal(parentRemotePath('C:\\Users\\model', 'powershell'), 'C:\\Users');
});

test('joinRemotePath 不在根目录上产生双斜杠', () => {
  assert.equal(joinRemotePath('/', 'etc', 'posix'), '/etc');
  assert.equal(joinRemotePath('/Users', 'model', 'posix'), '/Users/model');
  assert.equal(joinRemotePath('C:\\Users', 'model', 'powershell'), 'C:\\Users\\model');
});

test('parseListDirOutput 识别目录 / 文件 / 软链，丢掉 . 和 ..，名字里的 tab 不丢', () => {
  const entries = parseListDirOutput(listOutput([
    'directory\t0\t1700000000\tprojects',
    'regular file\t12\t1700000001\tREADME.md',
    'symbolic link\t0\t1700000002\tlatest',
    'd\t0\t1700000003\t.',
    'd\t0\t1700000003\t..',
    'd\t0\t1700000004\tweird\tname'
  ]));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.type]), [
    ['projects', 'd'],
    ['README.md', 'f'],
    ['latest', 'l'],
    ['weird\tname', 'd']
  ]);
});

test('browseRemoteDirectories 默认列家目录，只返回目录并按名字排序', async () => {
  const { service, calls } = fakeService({
    stdout: listOutput([
      'directory\t0\t1\tzeta',
      'regular file\t10\t1\tREADME.md',
      'directory\t0\t1\talpha'
    ])
  });
  const result = await browseRemoteDirectories({ service, connectionId: 'conn_1', subDir: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'listDir:/Users/model');
  assert.equal(calls[0].options.lane, 'interactive');
  assert.equal(calls[0].options.timeoutMs, DEFAULT_BROWSE_TIMEOUT_MS);
  assert.equal(result.currentDir, '/Users/model');
  assert.equal(result.parentDir, '/Users');
  assert.deepEqual(result.directories, [
    { name: 'alpha', path: '/Users/model/alpha' },
    { name: 'zeta', path: '/Users/model/zeta' }
  ]);
});

test('browseRemoteDirectories 支持相对路径和绝对路径', async () => {
  const relative = fakeService({ stdout: 'directory\t0\t1\tai_home' });
  const relResult = await browseRemoteDirectories({ service: relative.service, connectionId: 'conn_1', subDir: 'projects' });
  assert.equal(relative.calls[0].command, 'listDir:/Users/model/projects');
  assert.deepEqual(relResult.directories, [{ name: 'ai_home', path: '/Users/model/projects/ai_home' }]);

  const absolute = fakeService({ stdout: '' });
  const absResult = await browseRemoteDirectories({ service: absolute.service, connectionId: 'conn_1', subDir: '/srv' });
  assert.equal(absolute.calls[0].command, 'listDir:/srv');
  assert.deepEqual(absResult.directories, []);
  assert.equal(absResult.parentDir, '/');
});

test('browseRemoteDirectories 把远端 NOENT / 权限错误翻成可读错误码', async () => {
  const missing = fakeService({ code: 3, stderr: 'NOENT' });
  await assert.rejects(
    () => browseRemoteDirectories({ service: missing.service, connectionId: 'conn_1', subDir: '/nope' }),
    (error) => error.code === 'not_found'
  );

  const denied = fakeService({ code: 1, stderr: 'ls: Permission denied' });
  await assert.rejects(
    () => browseRemoteDirectories({ service: denied.service, connectionId: 'conn_1', subDir: '/root' }),
    (error) => error.code === 'permission_denied'
  );
});

test('browseRemoteDirectories 透传连接不存在', async () => {
  const service = {
    machine: () => {
      const error = new Error('SSH 连接不存在');
      error.code = 'connection_not_found';
      throw error;
    }
  };
  await assert.rejects(
    () => browseRemoteDirectories({ service, connectionId: 'conn_missing' }),
    (error) => error.code === 'connection_not_found'
  );
});
