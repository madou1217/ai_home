#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureExecutable(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.chmodSync(filePath, 0o755);
  } catch (err) {
    // Best effort only: do not fail installation for permission tweaks.
  }
}

function fixStalePreCommitHook(rootDir) {
  const hookPath = path.join(rootDir, '.git', 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) return;

  let hookBody = '';
  try {
    hookBody = fs.readFileSync(hookPath, 'utf8');
  } catch (err) {
    return;
  }

  const nodeScriptMatch = hookBody.match(/^\s*node\s+([^\s]+)\s*$/m);
  if (!nodeScriptMatch) return;

  const rawScriptPath = nodeScriptMatch[1].trim();
  const scriptPath = path.resolve(rootDir, rawScriptPath);
  if (fs.existsSync(scriptPath)) return;

  const safeHook = [
    '#!/bin/sh',
    '# reset stale hook entry whose target script is missing',
    'exit 0',
    ''
  ].join('\n');
  try {
    fs.writeFileSync(hookPath, safeHook, 'utf8');
    fs.chmodSync(hookPath, 0o755);
  } catch (err) {
    // Best effort only: do not fail installation for hook cleanup.
  }
}

function buildWebUI(rootDir) {
  const webDir = path.join(rootDir, 'web');
  const webPackageJson = path.join(webDir, 'package.json');
  const webDistDir = path.join(webDir, 'dist');

  // 检查 web 目录是否存在
  if (!fs.existsSync(webDir) || !fs.existsSync(webPackageJson)) {
    console.log('ℹ️  Web UI directory not found, skipping build');
    return;
  }

  console.log('🌐 Building Web UI...');

  // 检查 web/node_modules 是否存在
  const webNodeModules = path.join(webDir, 'node_modules');
  if (!fs.existsSync(webNodeModules)) {
    console.log('📦 Installing Web UI dependencies...');
    const installResult = spawnSync('npm', ['install'], {
      cwd: webDir,
      stdio: 'inherit',
      shell: true
    });

    if (installResult.status !== 0) {
      console.error('❌ Failed to install Web UI dependencies');
      return;
    }
  }

  // 检查是否已经构建过
  if (fs.existsSync(webDistDir)) {
    const distStat = fs.statSync(webDistDir);
    const packageStat = fs.statSync(webPackageJson);

    // 如果 dist 比 package.json 新，跳过构建
    if (distStat.mtime > packageStat.mtime) {
      console.log('✅ Web UI already built, skipping');
      return;
    }
  }

  // 构建 Web UI
  console.log('⚙️  Compiling Web UI...');
  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: webDir,
    stdio: 'inherit',
    shell: true
  });

  if (buildResult.status === 0) {
    console.log('✅ Web UI built successfully!');
    console.log('💡 Access Web UI at: http://127.0.0.1:9527/ui/');
  } else {
    console.error('❌ Web UI build failed (non-fatal, continuing...)');
  }
}

const GO_CLI_BASENAME = process.platform === 'win32' ? 'aih-go.exe' : 'aih-go';

// nativeCliPath 返回随包分发的 Go CLI 路径（bin/native/<platform>-<arch>/aih-go）。
function nativeCliPath(rootDir) {
  return path.join(rootDir, 'bin', 'native', process.platform + '-' + process.arch, GO_CLI_BASENAME);
}

// candidateBinDirs 列出可能存放 aih 入口链接的目录。
function candidateBinDirs() {
  const dirs = [];
  const prefix = String(process.env.npm_config_prefix || '').trim();
  if (prefix) dirs.push(path.join(prefix, 'bin'));
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  const home = String(process.env.HOME || '').trim();
  if (home) dirs.push(path.join(home, '.local', 'bin'), path.join(home, 'bin'));
  return [...new Set(dirs)];
}

// ensureNativeCli 在缺少 Go CLI 且本机有 Go 工具链时就地构建；否则返回空。
function ensureNativeCli(rootDir) {
  const binary = nativeCliPath(rootDir);
  if (fs.existsSync(binary)) return binary;
  if (spawnSync('go', ['version'], { stdio: 'ignore' }).status !== 0) return '';
  const build = spawnSync(process.execPath, [path.join(rootDir, 'scripts', 'build-go-cli.js')], {
    cwd: rootDir,
    stdio: 'ignore'
  });
  if (build.status !== 0) return '';
  return fs.existsSync(binary) ? binary : '';
}

// linkTarget 指向包内的 bin/aih 启动器（不是 JS 入口，也不是裸二进制），
// 这样 npm 重新安装、换目录、切换平台都不需要改链接。
function linkTarget(dir, rootDir, binary) {
  const launcher = path.join(rootDir, 'bin', 'aih');
  const packageDir = path.join(path.dirname(dir), 'lib', 'node_modules', 'ai_home');
  try {
    if (fs.realpathSync(packageDir) === rootDir) {
      return path.relative(dir, path.join(packageDir, 'bin', 'aih'));
    }
  } catch (err) {
    // 非 npm 布局时退回仓库相对路径。
  }
  return path.relative(dir, launcher);
}

// relinkAihEntry 把全局 aih 入口指向 Go CLI：启动会话不再经过 Node 外壳。
// 只改指向本包的符号链接；任一步失败都保留原链接（Node 入口仍可用）。
function relinkAihEntry(rootDir, options = {}) {
  const log = options.log || console;
  if (process.platform === 'win32') return { action: 'skipped_windows', count: 0 };
  const binary = options.binary || ensureNativeCli(rootDir);
  if (!binary) return { action: 'skipped_no_binary', count: 0 };
  try {
    fs.chmodSync(binary, 0o755);
  } catch (err) {
    // 权限调整失败不影响后续链接尝试。
  }
  const linked = [];
  for (const dir of candidateBinDirs()) {
    const link = path.join(dir, 'aih');
    let stat;
    try {
      stat = fs.lstatSync(link);
    } catch (err) {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    try {
      const target = fs.realpathSync(link);
      if (!target.startsWith(rootDir + path.sep)) continue;
      if (target === path.join(rootDir, 'bin', 'aih')) continue;
      const temporary = link + '.aih-link-' + process.pid;
      fs.rmSync(temporary, { force: true });
      fs.symlinkSync(linkTarget(dir, rootDir, binary), temporary);
      fs.renameSync(temporary, link);
      linked.push(link);
    } catch (err) {
      log.log('ℹ️  native entry link skipped (' + link + '): ' + err.message);
    }
  }
  if (linked.length > 0) log.log('[aih] entry linked to native CLI: ' + linked.join(', '));
  return { action: linked.length > 0 ? 'linked' : 'not_found', count: linked.length, links: linked };
}
function main() {
  const rootDir = path.resolve(__dirname, '..');
  fixStalePreCommitHook(rootDir);
  ensureExecutable(path.join(rootDir, 'bin', 'ai-home.js'));
  ensureExecutable(path.join(rootDir, 'bin', 'claude-desktop-credential.js'));

  if (process.platform === 'darwin') {
    const helpers = [
      path.join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
      path.join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')
    ];
    helpers.forEach(ensureExecutable);
  }

  // 入口链接：aih 指向 Go CLI，启动会话不再经过 Node 外壳（失败不影响安装）。
  try {
    relinkAihEntry(rootDir);
  } catch (error) {
    console.log(`ℹ️  native entry link skipped: ${error.message}`);
  }

  // 构建 Web UI
  buildWebUI(rootDir);

  // Go Core 构件（显式 opt-in 功能；失败只提示，不影响安装）
  require('./postinstall-go-core').prepareGoCore().then(
    (result) => {
      if (result.action !== 'up_to_date' && result.action !== 'skipped') console.log(`[aih] Go Core: ${result.action}`);
    },
    (error) => console.log(`ℹ️  Go Core preparation skipped: ${error.message}`)
  );
}

if (require.main === module) {
  main();
}

module.exports = { relinkAihEntry, nativeCliPath, ensureNativeCli };