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
    console.log('💡 Access Web UI at: http://127.0.0.1:8317/ui/');
  } else {
    console.error('❌ Web UI build failed (non-fatal, continuing...)');
  }
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  fixStalePreCommitHook(rootDir);

  if (process.platform === 'darwin') {
    const helpers = [
      path.join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
      path.join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')
    ];
    helpers.forEach(ensureExecutable);
  }

  // 构建 Web UI
  buildWebUI(rootDir);
}

main();
