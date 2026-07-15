#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs, requireString } = require('./lib/cli');
const {
  displayPath,
  findFiles,
  writeJson,
} = require('./lib/fs-utils');

const INSTALLABLE_KINDS = new Set(['appimage', 'deb', 'dmg', 'msi']);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      const result = {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      const acceptedExitCodes = options.acceptedExitCodes || [0];
      if (!acceptedExitCodes.includes(exitCode)) {
        const detail = result.stderr.trim().slice(-2_000) || result.stdout.trim().slice(-2_000);
        reject(new Error(`${command} 退出码 ${exitCode}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve(result);
    });
  });
}

function isBundleKind(filePath, stat, kind) {
  const lowerPath = filePath.toLowerCase();
  if (kind === 'app') {
    return stat.isDirectory() && lowerPath.endsWith('.app');
  }
  if (!stat.isFile()) {
    return false;
  }
  const extensions = {
    appimage: '.appimage',
    deb: '.deb',
    dmg: '.dmg',
    msi: '.msi',
  };
  return lowerPath.endsWith(extensions[kind] || `.${kind}`);
}

function findSingleBundle(bundleRoot, kind) {
  const candidates = findFiles(bundleRoot, (filePath, stat) => isBundleKind(filePath, stat, kind));
  if (candidates.length !== 1) {
    throw new Error(`期望找到 1 个 ${kind} 制品，实际找到 ${candidates.length} 个`);
  }
  return candidates[0];
}

function chooseExecutable(candidates, productName) {
  const executableCandidates = candidates.filter((candidate) => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        return false;
      }
      return process.platform === 'win32' || (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
  if (executableCandidates.length === 0) {
    throw new Error('安装目录中没有找到可执行文件');
  }

  const normalizedProductName = productName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ranked = executableCandidates
    .map((candidate) => {
      const basename = path.basename(candidate, path.extname(candidate)).toLowerCase();
      const normalizedBasename = basename.replace(/[^a-z0-9]/g, '');
      let score = 0;
      if (normalizedBasename === normalizedProductName) {
        score += 100;
      }
      if (normalizedBasename === 'aihome') {
        score += 80;
      }
      if (/unins|uninstall|update/i.test(basename)) {
        score -= 100;
      }
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate));

  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    throw new Error(`无法唯一确定应用可执行文件: ${ranked.map((entry) => displayPath(entry.candidate)).join(', ')}`);
  }
  return ranked[0].candidate;
}

async function installDmg(bundlePath, installRoot, productName) {
  if (process.platform !== 'darwin') {
    throw new Error('DMG 安装只能在 macOS 执行');
  }
  const mountPath = path.join(installRoot, '.mount');
  fs.rmSync(mountPath, { force: true, recursive: true });
  fs.mkdirSync(mountPath, { recursive: true });
  await runCommand('hdiutil', ['attach', bundlePath, '-nobrowse', '-readonly', '-mountpoint', mountPath]);

  try {
    const applications = findFiles(mountPath, (filePath, stat) => (
      stat.isDirectory() && filePath.toLowerCase().endsWith('.app')
    ));
    if (applications.length !== 1) {
      throw new Error(`DMG 内期望 1 个 .app，实际找到 ${applications.length} 个`);
    }
    const installedApplication = path.join(installRoot, path.basename(applications[0]));
    fs.rmSync(installedApplication, { force: true, recursive: true });
    await runCommand('ditto', [applications[0], installedApplication]);
    const executableRoot = path.join(installedApplication, 'Contents', 'MacOS');
    const executable = chooseExecutable(
      findFiles(executableRoot, (_filePath, stat) => stat.isFile()),
      productName,
    );
    return {
      method: 'hdiutil-attach-and-ditto',
      installedPath: installedApplication,
      executablePath: executable,
    };
  } finally {
    await runCommand('hdiutil', ['detach', mountPath]);
    fs.rmSync(mountPath, { force: true, recursive: true });
  }
}

function windowsSearchRoots(installRoot, productName) {
  const roots = [installRoot];
  const environmentRoots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  for (const root of environmentRoots) {
    roots.push(path.join(root, productName));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function installMsi(bundlePath, installRoot, productName, outputPath) {
  if (process.platform !== 'win32') {
    throw new Error('MSI 安装只能在 Windows 执行');
  }
  fs.mkdirSync(installRoot, { recursive: true });
  const installerLog = path.resolve(`${outputPath}.msiexec.log`);
  await runCommand('msiexec.exe', [
    '/i',
    bundlePath,
    '/qn',
    '/norestart',
    `INSTALLDIR=${installRoot}`,
    '/L*v',
    installerLog,
  ], { acceptedExitCodes: [0, 3010] });

  const candidates = [];
  for (const root of windowsSearchRoots(installRoot, productName)) {
    candidates.push(...findFiles(root, (filePath, stat) => (
      stat.isFile() && filePath.toLowerCase().endsWith('.exe')
    )));
  }
  const executable = chooseExecutable([...new Set(candidates)], productName);
  return {
    method: 'msiexec-quiet-install',
    installedPath: path.dirname(executable),
    executablePath: executable,
    installerLog,
  };
}

async function installDeb(bundlePath, productName) {
  if (process.platform !== 'linux') {
    throw new Error('DEB 安装只能在 Linux 执行');
  }
  const packageQuery = await runCommand('dpkg-deb', ['--field', bundlePath, 'Package']);
  const packageName = packageQuery.stdout.trim();
  if (!packageName) {
    throw new Error('无法读取 DEB 包名');
  }
  const command = typeof process.getuid === 'function' && process.getuid() === 0 ? 'dpkg' : 'sudo';
  const commandArgs = command === 'sudo'
    ? ['dpkg', '--install', bundlePath]
    : ['--install', bundlePath];
  await runCommand(command, commandArgs);

  const packageFiles = await runCommand('dpkg-query', ['--listfiles', packageName]);
  const candidates = packageFiles.stdout
    .split(/\r?\n/u)
    .filter((candidate) => candidate.startsWith('/usr/bin/') && fs.existsSync(candidate));
  const executable = chooseExecutable(candidates, productName);
  return {
    method: 'dpkg-install',
    installedPath: '/',
    executablePath: executable,
    packageName,
  };
}

async function installAppImage(bundlePath, installRoot) {
  if (process.platform !== 'linux') {
    throw new Error('AppImage 验证只能在 Linux 执行');
  }
  fs.mkdirSync(installRoot, { recursive: true });
  const executable = path.join(installRoot, path.basename(bundlePath));
  fs.copyFileSync(bundlePath, executable);
  fs.chmodSync(executable, 0o755);
  return {
    method: 'portable-copy-and-chmod',
    installedPath: installRoot,
    executablePath: executable,
  };
}

async function install(kind, bundlePath, installRoot, productName, outputPath) {
  if (kind === 'dmg') {
    return installDmg(bundlePath, installRoot, productName);
  }
  if (kind === 'msi') {
    return installMsi(bundlePath, installRoot, productName, outputPath);
  }
  if (kind === 'deb') {
    return installDeb(bundlePath, productName);
  }
  return installAppImage(bundlePath, installRoot);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundleRoot = requireString(args, 'bundle-root');
  const installRoot = requireString(args, 'install-root');
  const kind = requireString(args, 'kind').toLowerCase();
  const outputPath = requireString(args, 'output');
  const productName = requireString(args, 'product-name');
  if (!INSTALLABLE_KINDS.has(kind)) {
    throw new Error(`不支持的安装包类型: ${kind}`);
  }

  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  const manifest = {
    schemaVersion: 1,
    platform: process.platform,
    architecture: os.arch(),
    kind,
    status: 'failed',
    distributionSigning: 'unsigned',
    bundlePath: null,
    installedPath: null,
    executablePath: null,
    method: null,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    error: null,
  };

  try {
    const bundlePath = findSingleBundle(bundleRoot, kind);
    manifest.bundlePath = path.resolve(bundlePath);
    const installed = await install(
      kind,
      manifest.bundlePath,
      path.resolve(installRoot),
      productName,
      outputPath,
    );
    Object.assign(manifest, installed, { status: 'installed' });
  } catch (error) {
    manifest.error = error.message;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    manifest.durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000);
    writeJson(outputPath, manifest);
  }

  if (manifest.status !== 'installed') {
    throw new Error(manifest.error || '安装失败');
  }
  process.stdout.write(`${kind} 已安装，清单: ${displayPath(outputPath)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`packaged install 失败: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  chooseExecutable,
  findSingleBundle,
  isBundleKind,
};
