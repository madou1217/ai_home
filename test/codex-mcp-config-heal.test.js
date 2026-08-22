'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  convertWslPathToWindows,
  convertWindowsPathToWsl,
  healCodexMcpServers,
  healCodexMcpServersConfigFile,
  resolveMcpCommandTarget
} = require('../lib/cli/services/pty/codex-mcp-config-heal');

function fakeFs(existingPaths = []) {
  const set = new Set(existingPaths.map((value) => String(value).toLowerCase()));
  return { existsSync: (value) => set.has(String(value).toLowerCase()) };
}

const WIN_UVX = 'C:\\Users\\madou\\.local\\bin\\uvx.exe';
const WSL_UVX = '/mnt/c/Users/madou/.local/bin/uvx.exe';

test('WSL 与 Windows 路径可无损互转', () => {
  assert.equal(convertWslPathToWindows(WSL_UVX), WIN_UVX);
  assert.equal(convertWindowsPathToWsl(WIN_UVX), WSL_UVX);
  assert.equal(convertWslPathToWindows('/mnt/d/tools/app.exe'), 'D:\\tools\\app.exe');
  assert.equal(convertWindowsPathToWsl('D:\\tools\\app.exe'), '/mnt/d/tools/app.exe');
});

test('Windows 上 WSL 路径目标存在时优先转换而非清理', () => {
  const target = resolveMcpCommandTarget(`'${WSL_UVX}'`, {
    platform: 'win32',
    fs: fakeFs([WIN_UVX])
  });
  assert.deepEqual(target, { action: 'convert', command: WIN_UVX });
});

test('相对命令与 home 路径不强求，保持原样', () => {
  for (const command of ['uvx', 'npx', '~/.local/bin/uvx', '${HOME}/bin/tool', './tool']) {
    assert.deepEqual(
      resolveMcpCommandTarget(command, { platform: 'win32', fs: fakeFs([]) }),
      { action: 'keep' }
    );
  }
});

test('绝对路径两种形态都不存在才判定清理', () => {
  const target = resolveMcpCommandTarget("'/opt/ghost/bin/tool'", {
    platform: 'win32',
    fs: fakeFs([])
  });
  assert.deepEqual(target, { action: 'remove' });
});

test('Linux 上 Windows 路径目标存在时转换为 WSL 挂载路径', () => {
  const target = resolveMcpCommandTarget(`'${WIN_UVX}'`, {
    platform: 'linux',
    fs: fakeFs([WSL_UVX])
  });
  assert.deepEqual(target, { action: 'convert', command: WSL_UVX });
});

test('healCodexMcpServers 转换 command 并保留段结构', () => {
  const config = [
    'model_provider = "aih_server"',
    '',
    '[mcp_servers.blender]',
    'args = [ "blender-mcp" ]',
    `command = '${WSL_UVX}'`,
    'startup_timeout_sec = 120',
    '',
    '[mcp_servers.node_repl]',
    'command = "D:\\\\nodejs\\\\node_repl.exe"'
  ].join('\n');
  const result = healCodexMcpServers(config, {
    platform: 'win32',
    fs: fakeFs([WIN_UVX, 'D:\\nodejs\\node_repl.exe'])
  });
  assert.equal(result.converted.length, 1);
  assert.equal(result.converted[0].name, 'blender');
  assert.equal(result.removed.length, 0);
  assert.match(result.config, new RegExp(`command = '${WIN_UVX.replace(/\\/g, '\\\\')}'`));
  assert.match(result.config, /args = \[ "blender-mcp" \]/);
  assert.match(result.config, /startup_timeout_sec = 120/);
  assert.match(result.config, /mcp_servers\.node_repl/);
});

test('healCodexMcpServers 清理死条目时连同子表一起移除', () => {
  const config = [
    '[mcp_servers.blender]',
    'command = \'/opt/missing/tool\'',
    '',
    '[mcp_servers.blender.env]',
    'FOO = "1"',
    '',
    '[mcp_servers.node_repl]',
    'command = "D:\\\\nodejs\\\\node_repl.exe"',
    'args = []'
  ].join('\n');
  const result = healCodexMcpServers(config, {
    platform: 'win32',
    fs: fakeFs(['D:\\nodejs\\node_repl.exe'])
  });
  assert.deepEqual(result.removed, [{ name: 'blender', command: '/opt/missing/tool' }]);
  assert.equal(result.config.includes('mcp_servers.blender'), false);
  assert.equal(result.config.includes('FOO'), false);
  assert.match(result.config, /mcp_servers\.node_repl/);
});

test('healCodexMcpServersConfigFile 备份后写回且幂等', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-mcp-heal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.toml');
  const original = [
    '[mcp_servers.blender]',
    `command = '${WSL_UVX}'`,
    'args = [ "blender-mcp" ]'
  ].join('\n');
  fs.writeFileSync(configPath, original, 'utf8');

  const logs = [];
  const once = healCodexMcpServersConfigFile(configPath, {
    fs,
    platform: process.platform,
    log: (message) => logs.push(message)
  });
  assert.equal(once.changed, true);
  assert.equal(once.converted.length, 1);
  assert.notEqual(once.backupPath, '');
  assert.equal(fs.existsSync(once.backupPath), true);
  assert.match(fs.readFileSync(configPath, 'utf8'), /command = 'C:.*uvx\.exe'/);
  assert.equal(logs.length, 1);

  const twice = healCodexMcpServersConfigFile(configPath, {
    fs,
    platform: process.platform,
    log: () => {}
  });
  assert.equal(twice.changed, false, '已转换过的路径应幂等无改动');
});

test('healCodexMcpServersConfigFile 对缺失文件与异常保持静默', () => {
  const missing = healCodexMcpServersConfigFile('Z:/definitely/not/here/config.toml', {
    fs,
    platform: 'win32'
  });
  assert.equal(missing.changed, false);

  const broken = healCodexMcpServersConfigFile('C:/x/config.toml', {
    fs: { existsSync: () => true, readFileSync: () => { throw new Error('boom'); } },
    platform: 'win32',
    log: () => {}
  });
  assert.equal(broken.changed, false);
});
