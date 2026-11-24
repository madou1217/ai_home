'use strict';

// Antigravity 桌面端（IDE）的 app.install 参考插件。
//
// 安装逻辑完全在插件内执行：宿主只传 appId/action/platform/proxyUrl，插件负责
// 下载、挂载/静默安装、安装后探测与打开。宿主不执行这里的命令字符串。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONTRIBUTION = 'antigravity.desktop.apps';
const APP_ID = 'antigravity-desktop';
const PROVIDER = 'agy';
const PAGE_URL = 'https://antigravity.google/download';

function currentPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function currentArch() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  return process.arch;
}

function homeDir() {
  return os.homedir();
}

function candidateExecutables() {
  const home = homeDir();
  if (currentPlatform() === 'macos') {
    return [
      path.join(home, 'Applications', 'Antigravity.app'),
      '/Applications/Antigravity.app'
    ];
  }
  if (currentPlatform() === 'windows') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(programFiles, 'Antigravity', 'Antigravity.exe')
    ];
  }
  return [
    path.join(home, '.local', 'opt', 'antigravity', 'antigravity'),
    path.join(home, '.local', 'bin', 'antigravity')
  ];
}

function findExecutable() {
  for (const candidate of candidateExecutables()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_error) { /* ignore */ }
  }
  return '';
}

function statusOne() {
  const executable = findExecutable();
  return {
    appId: APP_ID,
    installed: Boolean(executable),
    state: executable ? 'installed' : 'missing',
    executable
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout || 10 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (result.error) throw new Error(command + ': ' + result.error.message);
  if (result.status !== 0) {
    throw new Error(command + ' 退出码 ' + result.status + (stderr ? '：' + stderr.slice(-300) : ''));
  }
  return { stdout, stderr };
}

function curlArgs(url, options = {}) {
  const args = ['-fL', '--retry', '3', '--connect-timeout', '20', '--max-time', String(options.maxTime || 1800)];
  if (options.proxyUrl) args.unshift('-x', options.proxyUrl);
  if (options.output) args.push('-o', options.output);
  args.push(url);
  return args;
}

function fetchPage(proxyUrl) {
  return run('curl', curlArgs(PAGE_URL, { proxyUrl, maxTime: 60 }), { timeout: 90 * 1000 }).stdout;
}

function download(url, output, proxyUrl) {
  run('curl', curlArgs(url, { proxyUrl, output }), { timeout: 30 * 60 * 1000 });
}

function matchURL(page, pattern) {
  const match = String(page || '').match(pattern);
  if (!match) throw new Error('未从官方页面解析到安装地址');
  const url = match[0];
  if (!url.startsWith('https://storage.googleapis.com/antigravity-public/')) {
    throw new Error('安装地址不在官方域名内');
  }
  return url;
}

function macInstaller(proxyUrl) {
  const page = fetchPage(proxyUrl);
  const target = currentArch() === 'arm64' ? 'darwin-arm' : 'darwin-x64';
  const url = matchURL(page, new RegExp('https://storage\\.googleapis\\.com/antigravity-public/[^\"' + "']+/" + target + '/Antigravity\\.dmg'));
  const tmp = path.join(os.tmpdir(), 'antigravity-' + process.pid + '-' + Date.now() + '.dmg');
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mount-'));
  const steps = [];
  try {
    steps.push({ id: 'download', label: '下载 Antigravity', ok: true });
    download(url, tmp, proxyUrl);
    run('hdiutil', ['attach', tmp, '-nobrowse', '-readonly', '-mountpoint', mount], { timeout: 2 * 60 * 1000 });
    steps.push({ id: 'mount', label: '挂载官方 DMG', ok: true });
    const app = path.join(mount, 'Antigravity.app');
    if (!fs.existsSync(app)) throw new Error('DMG 内未找到 Antigravity.app');
    const targetDir = path.join(homeDir(), 'Applications');
    fs.mkdirSync(targetDir, { recursive: true });
    const installed = path.join(targetDir, 'Antigravity.app');
    fs.rmSync(installed, { recursive: true, force: true });
    run('ditto', [app, installed], { timeout: 5 * 60 * 1000 });
    steps.push({ id: 'install', label: '安装到 ~/Applications', ok: true });
    return steps;
  } finally {
    try { run('hdiutil', ['detach', mount, '-force'], { timeout: 30 * 1000 }); } catch (_error) { /* ignore */ }
    try { fs.rmSync(mount, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch (_error) { /* ignore */ }
  }
}

function windowsInstaller(proxyUrl) {
  const page = fetchPage(proxyUrl);
  const target = currentArch() === 'arm64' ? 'windows-arm/Antigravity-arm64.exe' : 'windows-x64/Antigravity-x64.exe';
  const url = matchURL(page, new RegExp('https://storage\\.googleapis\\.com/antigravity-public/[^\"' + "']+/" + target.replace('.', '\\.')));
  const tmp = path.join(os.tmpdir(), 'antigravity-' + process.pid + '-' + Date.now() + '.exe');
  const steps = [];
  try {
    steps.push({ id: 'download', label: '下载 Antigravity', ok: true });
    download(url, tmp, proxyUrl);
    const result = spawnSync(tmp, ['/S'], {
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    if (result.error) throw new Error(result.error.message);
    if (result.status !== 0 && result.status !== null) {
      throw new Error('安装器退出码 ' + result.status);
    }
    steps.push({ id: 'install', label: '运行官方静默安装器', ok: true });
    return steps;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_error) { /* ignore */ }
  }
}

function linuxInstaller(proxyUrl) {
  const page = fetchPage(proxyUrl);
  const target = currentArch() === 'arm64' ? 'linux-arm' : 'linux-x64';
  const url = matchURL(page, new RegExp('https://storage\\.googleapis\\.com/antigravity-public/[^\"' + "']+/" + target + '/Antigravity\\.tar\\.gz'));
  const tmp = path.join(os.tmpdir(), 'antigravity-' + process.pid + '-' + Date.now() + '.tar.gz');
  const root = path.join(homeDir(), '.local', 'opt', 'antigravity');
  const steps = [];
  try {
    steps.push({ id: 'download', label: '下载 Antigravity', ok: true });
    download(url, tmp, proxyUrl);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    run('tar', ['-xzf', tmp, '-C', root], { timeout: 5 * 60 * 1000 });
    steps.push({ id: 'install', label: '解压到 ~/.local/opt/antigravity', ok: true });
    return steps;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_error) { /* ignore */ }
  }
}

function install(proxyUrl) {
  if (currentPlatform() === 'macos') return macInstaller(proxyUrl);
  if (currentPlatform() === 'windows') return windowsInstaller(proxyUrl);
  return linuxInstaller(proxyUrl);
}

function removeInstalled() {
  const home = homeDir();
  const targets = [];
  if (currentPlatform() === 'macos') targets.push(path.join(home, 'Applications', 'Antigravity.app'));
  if (currentPlatform() === 'windows') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    targets.push(path.join(local, 'Programs', 'Antigravity'));
  }
  if (currentPlatform() === 'linux') targets.push(path.join(home, '.local', 'opt', 'antigravity'));
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
}

function openApp() {
  const executable = findExecutable();
  if (!executable) throw new Error('Antigravity 尚未安装');
  if (currentPlatform() === 'macos') {
    spawnSync('open', ['-a', executable], { stdio: 'ignore' });
  } else if (currentPlatform() === 'windows') {
    spawnSync(executable, [], { stdio: 'ignore', detached: true, windowsHide: false });
  } else {
    spawnSync(executable, [], { stdio: 'ignore', detached: true });
  }
}

function handle(value) {
  const kind = value && value.kind;
  if (kind === 'describe') {
    return {
      apps: [{
        appId: APP_ID,
        provider: PROVIDER,
        name: 'Antigravity',
        kind: 'desktop',
        platforms: ['macos', 'windows', 'linux'],
        order: 10,
        capabilities: {
          install: true,
          update: true,
          uninstall: true,
          open: true,
          accountScope: false,
          openMode: 'plugin'
        },
        install: { requiresConfirmation: true, requiresAdmin: false, downloadBytes: 242043825 },
        uninstall: { removesUserData: false },
        open: { mode: 'plugin' }
      }]
    };
  }
  if (kind === 'status') {
    return { apps: [statusOne()] };
  }
  if (kind !== 'operate') {
    return { ok: false, message: 'unknown invoke kind' };
  }
  const action = String(value.action || '');
  const proxyUrl = String(value.proxyUrl || '');
  try {
    if (action === 'install' || action === 'update') {
      const steps = install(proxyUrl);
      return { ok: true, changed: true, steps, status: statusOne(), message: '安装完成' };
    }
    if (action === 'uninstall') {
      removeInstalled();
      return { ok: true, changed: true, steps: [{ id: 'uninstall', label: '删除 Antigravity', ok: true }], status: statusOne(), message: '已卸载' };
    }
    if (action === 'open') {
      openApp();
      return { ok: true, changed: false, steps: [{ id: 'open', label: '启动 Antigravity', ok: true }], status: statusOne(), message: '已打开' };
    }
    if (action === 'close') {
      return { ok: true, changed: false, steps: [{ id: 'close', label: '关闭由用户完成', ok: true }], status: statusOne(), message: '请手动关闭' };
    }
    return { ok: false, message: 'unsupported action: ' + action };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : '操作失败',
      steps: [{ id: action || 'operate', label: action, ok: false, error: error && error.message ? error.message : '' }],
      status: statusOne()
    };
  }
}

module.exports = {
  apply(ctx) {
    ctx.aih.register(CONTRIBUTION, async (value) => handle(value || {}));
  }
};
