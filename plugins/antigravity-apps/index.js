'use strict';

// Antigravity 桌面端与 IDE 的 app.install 参考插件。
//
// 产品边界（以官方 /download 页面为准，2026-11 实测）：
//   - Antigravity（Desktop / Hub）：storage.googleapis.com/antigravity-public/antigravity-hub/...
//     版本线 2.35.x，产物 Antigravity.dmg / Antigravity-x64.exe / Antigravity.tar.gz
//   - Antigravity IDE（Standalone）：edgedl.me.gvt1.com/edgedl/release2/j0qc3/antigravity/stable/...
//     版本线 2.8.x，产物 "Antigravity IDE.dmg" / "Antigravity IDE.exe" / "Antigravity IDE.tar.gz"
//
// 两者是**不同产品、不同版本线、不同 CDN**，因此不能用一个 appId 表达。早先的
// 版本只装了 Desktop，用户会以为「Antigravity 已装」而 IDE 其实不存在。
//
// 安装逻辑完全在插件内执行：宿主只传 appId/action/platform/proxyUrl，插件负责
// 下载、挂载/静默安装、安装后探测与打开。宿主不执行这里的命令字符串。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CONTRIBUTION = 'antigravity.apps.install';
const PROVIDER = 'agy';
const DOWNLOAD_PAGE = 'https://antigravity.google/download';

// 两个产品各自的官方产物域名：解析出的地址必须落在其中之一，防止被中间人
// 换成任意主机（页面内容来自网络，不能当成可信输入）。
const OFFICIAL_PREFIXES = [
  'https://storage.googleapis.com/antigravity-public/',
  'https://edgedl.me.gvt1.com/edgedl/release2/j0qc3/antigravity/'
];

const PRODUCTS = {
  'antigravity-desktop': {
    name: 'Antigravity',
    kind: 'desktop',
    gui: true,
    // Desktop 是账号入口对应的产品。
    accountKind: 'desktop',
    order: 10,
    artifactDir: 'antigravity-hub',
    binaryName: 'Antigravity',
    downloadBytes: 242043825
  },
  'antigravity-ide': {
    name: 'Antigravity IDE',
    kind: 'ide',
    gui: true,
    // IDE 是独立产品，不能把安装状态算到 Desktop 账号入口。
    accountKind: 'none',
    order: 11,
    artifactDir: 'release2/j0qc3/antigravity/stable',
    binaryName: 'Antigravity IDE',
    downloadBytes: 174201335
  }
};

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

// 无桌面的 Linux server 不提供 Desktop/IDE 安装面。
//
// 平台列表排除 linux 后，宿主既不会在 Toolkit 出卡，也会在 operate 校验阶段
// 拒绝 install/uninstall；CLI 不在此插件内，仍走 Provider 的 CLI 安装计划。
function hasDesktopSession() {
  if (currentPlatform() !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function platformsFor(product) {
  if (!product.gui || hasDesktopSession()) return ['macos', 'windows', 'linux'];
  return ['macos', 'windows'];
}

// candidateExecutables 返回该产品在各平台的候选安装路径。
// IDE 与 Desktop 的可执行文件名不同，必须分开判断，否则「Desktop 已装」会被
// 误报成「IDE 已装」。
function candidateExecutables(appId) {
  const home = homeDir();
  const product = PRODUCTS[appId];
  if (!product) return [];
  const bin = product.binaryName;
  if (currentPlatform() === 'macos') {
    return [
      path.join(home, 'Applications', bin + '.app'),
      '/Applications/' + bin + '.app'
    ];
  }
  if (currentPlatform() === 'windows') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(local, 'Programs', bin, bin + '.exe'),
      path.join(programFiles, bin, bin + '.exe')
    ];
  }
  const slug = appId === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity';
  return [
    path.join(home, '.local', 'opt', slug, slug),
    path.join(home, '.local', 'bin', slug)
  ];
}

function findExecutable(appId) {
  for (const candidate of candidateExecutables(appId)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_error) { /* ignore */ }
  }
  return '';
}

function statusOf(appId) {
  const executable = findExecutable(appId);
  return {
    appId,
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
  return run('curl', curlArgs(DOWNLOAD_PAGE, { proxyUrl, maxTime: 60 }), { timeout: 90 * 1000 }).stdout;
}

function download(url, output, proxyUrl) {
  run('curl', curlArgs(url, { proxyUrl, output }), { timeout: 30 * 60 * 1000 });
}

// matchURL 从官方页面里取出该产品的下载地址，并强制校验域名。
//
// 目录段用 artifactDir 区分产品：Desktop 在 antigravity-hub/ 下，IDE 在
// release2/.../stable/ 下。同名文件（Antigravity.exe / Antigravity IDE.exe）
// 靠这一层区分，避免把 Desktop 的地址当成 IDE 的。
function matchURL(page, appId, archDir, fileNamePattern) {
  const product = PRODUCTS[appId];
  const dir = product.artifactDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    'https://[a-zA-Z0-9._-]+/[a-zA-Z0-9._/-]*' + dir + '/[^"\'\\s]+/' + archDir + '/' + fileNamePattern
  );
  const match = String(page || '').match(pattern);
  if (!match) throw new Error('未从官方页面解析到 ' + product.name + ' 的安装地址');
  const url = match[0];
  if (!OFFICIAL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    throw new Error('安装地址不在官方域名内');
  }
  return url;
}

// fileStem 把产品名转成正则片段：官方 URL 里空格编码为 %20，但也可能有裸空格，
// 两种都接受。Desktop 的产物名没有空格，IDE 的 "Antigravity IDE" 有。
function fileStem(binaryName) {
  return binaryName.split(' ').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:%20|\\s)');
}

function macInstaller(appId, proxyUrl) {
  const product = PRODUCTS[appId];
  const page = fetchPage(proxyUrl);
  const archDir = currentArch() === 'arm64' ? 'darwin-arm' : 'darwin-x64';
  const url = matchURL(page, appId, archDir, fileStem(product.binaryName) + '\\.dmg');
  const tmp = path.join(os.tmpdir(), 'aih-' + appId + '-' + process.pid + '-' + Date.now() + '.dmg');
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-mount-'));
  const steps = [];
  try {
    steps.push({ id: 'download', label: '下载 ' + product.name, ok: true });
    download(url, tmp, proxyUrl);
    run('hdiutil', ['attach', tmp, '-nobrowse', '-readonly', '-mountpoint', mount], { timeout: 2 * 60 * 1000 });
    steps.push({ id: 'mount', label: '挂载官方 DMG', ok: true });
    const appName = product.binaryName + '.app';
    let app = path.join(mount, appName);
    if (!fs.existsSync(app)) {
      // DMG 里可能多一层目录；按 .app 唯一名兜底。
      const found = fs.readdirSync(mount, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
        .map((entry) => entry.name);
      if (found.length === 1) app = path.join(mount, found[0]);
      else throw new Error('DMG 内未找到 ' + appName);
    }
    const targetDir = path.join(homeDir(), 'Applications');
    fs.mkdirSync(targetDir, { recursive: true });
    const installed = path.join(targetDir, path.basename(app));
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

// stopInstaller 结束安装器及其子进程。
//
// Inno 安装器可能拉起 IDE 后继续驻留，锁住安装目录并让后续卸载 EBUSY；
// 安装完成后必须收尾，不能把安装器留在后台。
function stopInstaller(exe, pid) {
  try { run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 30 * 1000 }); } catch (_error) { /* 已退出 */ }
  const image = path.basename(exe);
  for (const name of [image, image + '.tmp']) {
    try { run('taskkill', ['/IM', name, '/T', '/F'], { timeout: 30 * 1000 }); } catch (_error) { /* 已退出 */ }
  }
}

// waitForInstaller 以 Inno 的安装完成日志判断结束，而不是看 exe 是否出现。
//
// Inno 先写 exe，再写 resources 等大量文件；以「exe 出现」为完成信号会
// 在安装中途结束安装器，留下启动即退出的半安装（缺 resources/app/out/main.js）。
// 反过来也不能无限等安装器退出：它可能拉起 IDE 并等待应用关闭。
function waitForInstaller(exe, args, appId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const logPath = path.join(os.tmpdir(), 'aih-' + appId + '-install-' + process.pid + '-' + Date.now() + '.log');
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (error) {
        // 保留日志用于排查超时/失败原因。
        reject(error);
        return;
      }
      // 安装已完成；安装器可能仍在等待它拉起的 IDE，收尾。
      stopInstaller(exe, child.pid);
      try { fs.rmSync(logPath, { force: true }); } catch (_error) { /* ignore */ }
      resolve();
    };
    const child = spawn(exe, args.concat(['/LOG=' + logPath]), { stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => finish(new Error(error.message)));
    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        // 安装器已退出，但文件落盘可能晚一拍；再给 2 秒。
        setTimeout(() => finish(), 2000);
      } else {
        finish(new Error('安装器退出码 ' + code));
      }
    });
    const installed = () => {
      try {
        return fs.readFileSync(logPath, 'utf8').includes('Installation process succeeded.');
      } catch (_error) {
        return false;
      }
    };
    const started = Date.now();
    timer = setInterval(() => {
      if (installed()) {
        setTimeout(() => finish(), 2000);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        // 超时也必须结束安装器，否则它会在后台继续写目标目录；
        // 用户重试时两个安装器同时写同一路径，会互相覆盖或锁文件。
        stopInstaller(exe, child.pid);
        finish(new Error('安装超时'));
      }
    }, 2000);
    if (child.unref) child.unref();
  });
}

async function windowsInstaller(appId, proxyUrl) {
  const product = PRODUCTS[appId];
  const page = fetchPage(proxyUrl);
  // 产物目录名两产品不同：Desktop 用 windows-arm/windows-x64，
  // IDE 用 windows-arm64/windows-x64。
  const isIDE = appId === 'antigravity-ide';
  const archDir = currentArch() === 'arm64'
    ? (isIDE ? 'windows-arm64' : 'windows-arm')
    : 'windows-x64';
  const stem = fileStem(product.binaryName);
  const filePattern = isIDE ? stem + '\\.exe' : stem + '-(?:x64|arm64)\\.exe';
  const url = matchURL(page, appId, archDir, filePattern);
  const tmp = path.join(os.tmpdir(), 'aih-' + appId + '-' + process.pid + '-' + Date.now() + '.exe');
  const steps = [];
  try {
    steps.push({ id: 'download', label: '下载 ' + product.name, ok: true });
    download(url, tmp, proxyUrl);
    // Desktop 是 NSIS（/S）；IDE 是 Inno Setup（/VERYSILENT），两者不能共用参数。
    if (isIDE) {
      // IDE 安装包含数十万个文件，慢盘/杀毒扫描下实测约 8 分钟；给足余量。
      await waitForInstaller(tmp, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], appId, 30 * 60 * 1000);
    } else {
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
    }
    steps.push({ id: 'install', label: '运行官方包默认安装', ok: true });
    return steps;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_error) { /* ignore */ }
  }
}

function linuxInstaller(appId, proxyUrl) {
  const product = PRODUCTS[appId];
  const page = fetchPage(proxyUrl);
  const archDir = currentArch() === 'arm64' ? 'linux-arm' : 'linux-x64';
  const url = matchURL(page, appId, archDir, fileStem(product.binaryName) + '\\.tar\\.gz');
  const tmp = path.join(os.tmpdir(), 'aih-' + appId + '-' + process.pid + '-' + Date.now() + '.tar.gz');
  const slug = appId === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity';
  const dest = path.join(homeDir(), '.local', 'opt', slug);
  const steps = [];
  try {
    steps.push({ id: 'download', label: '下载 ' + product.name, ok: true });
    download(url, tmp, proxyUrl);
    fs.mkdirSync(dest, { recursive: true });
    run('tar', ['-xzf', tmp, '-C', dest, '--strip-components=1'], { timeout: 5 * 60 * 1000 });
    steps.push({ id: 'install', label: '解压到 ' + dest, ok: true });
    return steps;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_error) { /* ignore */ }
  }
}

// assertCompleteInstall 兜底识别被中断的 Inno 安装。
//
// 安装器被中途结束时会留下 is-*.tmp 和缺失的 resources；exe 已存在，
// 只看 findExecutable 会误报成功。发现残留临时文件就按安装失败处理。
function assertCompleteInstall(appId) {
  if (currentPlatform() !== 'windows') return;
  const product = PRODUCTS[appId];
  const local = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
  const dir = path.join(local, 'Programs', product.binaryName);
  let partial = [];
  try {
    partial = fs.readdirSync(dir).filter((name) => /^is-.*\.tmp$/i.test(name));
  } catch (_error) {
    return;
  }
  if (partial.length > 0) {
    throw new Error('安装未完成，安装器被中断：' + partial.join(', '));
  }
}

async function install(appId, proxyUrl) {
  const platform = currentPlatform();
  const steps = platform === 'macos'
    ? macInstaller(appId, proxyUrl)
    : platform === 'windows'
      ? await windowsInstaller(appId, proxyUrl)
      : linuxInstaller(appId, proxyUrl);
  if (!findExecutable(appId)) {
    throw new Error('安装完成但未找到 ' + PRODUCTS[appId].name + ' 可执行文件');
  }
  assertCompleteInstall(appId);
  return steps;
}

// quitApp 在卸载前关闭目标应用。
//
// 卸载必须删除安装目录；Windows 上运行中的 exe 会锁住目录（EBUSY），
// macOS 上运行中的 .app 也可能阻止删除。先优雅退出，再兜底强制结束。
function isAppRunning(appId) {
  const product = PRODUCTS[appId];
  if (!product) return false;
  if (currentPlatform() === 'windows') {
    const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + product.binaryName + '.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true
    });
    return String(result.stdout || '').toLowerCase().includes((product.binaryName + '.exe').toLowerCase());
  }
  if (currentPlatform() === 'macos') {
    const result = spawnSync('pgrep', ['-f', '/' + product.binaryName + '.app/Contents/MacOS/'], { encoding: 'utf8' });
    return result.status === 0;
  }
  const slug = appId === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity';
  const result = spawnSync('pgrep', ['-f', path.join(homeDir(), '.local', 'opt', slug)], { encoding: 'utf8' });
  return result.status === 0;
}

// quitApp 退出应用并确认进程消失。卸载前如果应用仍在运行，宁可直接报错，
// 也不能带着运行中的进程删除目录——Electron 会弹出 main.js 缺失的错误框。
async function quitApp(appId) {
  const product = PRODUCTS[appId];
  if (!product) return;
  if (currentPlatform() === 'windows') {
    try {
      run('taskkill', ['/IM', product.binaryName + '.exe', '/T', '/F'], { timeout: 30 * 1000 });
    } catch (_error) { /* 未运行 */ }
    // 安装器/更新器的临时进程也可能锁目录。
    try {
      run('powershell', ['-NoProfile', '-Command',
        "Get-Process | Where-Object { $_.ProcessName -like 'aih-antigravity-*' } | Stop-Process -Force"], { timeout: 30 * 1000 });
    } catch (_error) { /* 未运行 */ }
  } else if (currentPlatform() === 'macos') {
    try {
      run('osascript', ['-e', 'quit app "' + product.binaryName + '"'], { timeout: 30 * 1000 });
    } catch (_error) { /* 未运行或拒绝退出 */ }
    try {
      run('pkill', ['-f', '/' + product.binaryName + '.app/Contents/MacOS/'], { timeout: 10 * 1000 });
    } catch (_error) { /* 已退出 */ }
  } else {
    const slug = appId === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity';
    try {
      run('pkill', ['-f', path.join(homeDir(), '.local', 'opt', slug)], { timeout: 10 * 1000 });
    } catch (_error) { /* 未运行 */ }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isAppRunning(appId)) return;
    await delay(500);
  }
  throw new Error('应用仍在运行，请关闭 ' + product.name + ' 后重试卸载');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// removePath 在应用退出后重试删除：Windows 的文件锁/杀毒扫描可能持续数十秒，
// 一次 EBUSY 不代表卸载失败。
async function removePath(target) {
  let lastError = null;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 10 && currentPlatform() === 'windows') {
        try { run('cmd', ['/c', 'rmdir', '/s', '/q', target], { timeout: 60 * 1000 }); } catch (_error) { /* 继续重试 */ }
      }
      await delay(1000);
    }
  }
  throw lastError || new Error('无法删除安装目录');
}

async function removeInstalled(appId) {
  const product = PRODUCTS[appId];
  if (!product) return;
  const home = homeDir();
  let target = '';
  if (currentPlatform() === 'macos') {
    // 只删插件自己安装的用户目录，不动 /Applications 的系统级安装。
    target = path.join(home, 'Applications', product.binaryName + '.app');
  } else if (currentPlatform() === 'windows') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    // 只删 per-user 安装目录，不动 Program Files。
    target = path.join(local, 'Programs', product.binaryName);
  } else {
    const slug = appId === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity';
    target = path.join(home, '.local', 'opt', slug);
  }
  if (!fs.existsSync(target)) return;
  // 先改名成 tombstone：安装器/自动更新无法再从原路径拉起应用；改名失败时
  // 说明仍有进程占用，直接报错，不做半删除。
  const tombstone = target + '.aih-uninstall-' + process.pid;
  try {
    fs.rmSync(tombstone, { recursive: true, force: true });
    fs.renameSync(target, tombstone);
  } catch (error) {
    throw new Error('安装目录仍被占用，未删除：' + (error && error.message ? error.message : ''));
  }
  await removePath(tombstone);
}

function openApp(appId) {
  const executable = findExecutable(appId);
  if (!executable) throw new Error('未安装，无法启动');
  if (currentPlatform() === 'macos') {
    run('open', [executable], { timeout: 60 * 1000 });
    return;
  }
  if (currentPlatform() === 'windows') {
    // 不能 spawnSync：start 可能等 GUI 进程，插件 RPC 会超时。
    const child = spawn('cmd', ['/c', 'start', '', executable], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return;
  }
  const child = spawn(executable, [], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function handle(value) {
  const kind = value && value.kind;
  if (kind === 'describe') {
    return {
      apps: Object.keys(PRODUCTS).map((appId) => {
        const product = PRODUCTS[appId];
        return {
          appId,
          provider: PROVIDER,
          name: product.name,
          kind: product.kind,
          accountKind: product.accountKind,
          platforms: platformsFor(product),
          order: product.order,
          capabilities: {
            install: true,
            update: true,
            uninstall: true,
            open: true,
            accountScope: false,
            openMode: 'plugin'
          },
          install: {
            requiresConfirmation: true,
            requiresAdmin: false,
            downloadBytes: product.downloadBytes
          },
          uninstall: { removesUserData: false },
          open: { mode: 'plugin' }
        };
      })
    };
  }
  if (kind === 'status') {
    const requested = Array.isArray(value.appIds) && value.appIds.length > 0
      ? value.appIds.filter((id) => PRODUCTS[id])
      : Object.keys(PRODUCTS);
    return { apps: requested.map((id) => statusOf(id)) };
  }
  if (kind !== 'operate') {
    return { ok: false, message: 'unknown invoke kind' };
  }
  const appId = String(value.appId || '');
  const product = PRODUCTS[appId];
  if (!product) {
    return { ok: false, changed: false, steps: [], status: null, message: 'unknown appId: ' + appId };
  }
  const action = String(value.action || '');
  const proxyUrl = String(value.proxyUrl || '');
  try {
    if (action === 'install' || action === 'update') {
      const steps = await install(appId, proxyUrl);
      return { ok: true, changed: true, steps, status: statusOf(appId), message: '安装完成' };
    }
    if (action === 'uninstall') {
      await quitApp(appId);
      await removeInstalled(appId);
      return { ok: true, changed: true, steps: [{ id: 'uninstall', label: '删除 ' + product.name, ok: true }], status: statusOf(appId), message: '已卸载' };
    }
    if (action === 'open') {
      openApp(appId);
      return { ok: true, changed: false, steps: [{ id: 'open', label: '启动 ' + product.name, ok: true }], status: statusOf(appId), message: '已打开' };
    }
    if (action === 'close') {
      return { ok: true, changed: false, steps: [{ id: 'close', label: '关闭由用户完成', ok: true }], status: statusOf(appId), message: '请手动关闭' };
    }
    return { ok: false, changed: false, steps: [], status: statusOf(appId), message: 'unknown action: ' + action };
  } catch (error) {
    const message = error && error.message ? error.message : '操作失败';
    return {
      ok: false,
      changed: false,
      message,
      steps: [{ id: action || 'operate', label: action, ok: false, error: message }],
      status: statusOf(appId)
    };
  }
}

module.exports = {
  apply(ctx) {
    ctx.aih.register(CONTRIBUTION, async (value) => handle(value || {}));
  }
};
