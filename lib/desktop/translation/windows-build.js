'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const WINDOWS_SOURCE_DIR = path.resolve(__dirname, '../../../native/translation/windows');
const PROJECT_FILE = path.join(WINDOWS_SOURCE_DIR, 'AihTranslation.csproj');
const SOURCE_FILE = path.join(WINDOWS_SOURCE_DIR, 'Program.cs');
const MANIFEST_FILE = path.join(WINDOWS_SOURCE_DIR, 'app.manifest');

function normalizeArch(value = process.arch) {
  const arch = String(value || '').trim().toLowerCase();
  return arch === 'arm64' ? 'arm64' : 'x64';
}

function buildError(message, cause) {
  const error = new Error(message);
  error.code = 'windows_helper_build_unavailable';
  if (cause) error.cause = cause;
  return error;
}

async function buildWindowsTranslationExecutable(aiHomeDir, {
  mode = 'helper',
  arch = process.arch,
  dotnetCommand = 'dotnet',
  fsImpl = fs,
  runImpl = run,
  sourceDir = WINDOWS_SOURCE_DIR,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw buildError(`Windows 翻译 helper 不支持当前构建平台：${platform}`);
  }
  const normalizedMode = mode === 'full-app' ? 'full-app' : 'helper';
  const rid = `win-${normalizeArch(arch)}`;
  const project = path.join(sourceDir, path.basename(PROJECT_FILE));
  const source = path.join(sourceDir, path.basename(SOURCE_FILE));
  const manifest = path.join(sourceDir, path.basename(MANIFEST_FILE));
  let sourceBytes;
  try {
    sourceBytes = await Promise.all([fsImpl.readFile(project), fsImpl.readFile(source), fsImpl.readFile(manifest)]);
  } catch (error) {
    throw buildError('Windows 翻译 helper 源码不完整', error);
  }
  const hash = crypto.createHash('sha256')
    .update(normalizedMode)
    .update(rid)
    .update(String(platform))
    .update(sourceBytes[0])
    .update(sourceBytes[1])
    .update(sourceBytes[2])
    .digest('hex');
  const root = path.join(aiHomeDir, 'run', 'desktop-translation', 'windows');
  const releaseDir = path.join(root, normalizedMode, hash);
  const executable = path.join(releaseDir, 'aih-translation.exe');
  if (await fsImpl.stat(executable).catch(() => null)) return executable;

  const stagingDir = path.join(root, `.staging-${process.pid}-${hash}`);
  await fsImpl.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fsImpl.mkdir(stagingDir, { recursive: true });
  try {
    await runImpl(dotnetCommand, [
      'publish', project,
      '--configuration', 'Release',
      '--runtime', rid,
      '--self-contained', 'true',
      '-p:PublishSingleFile=true',
      '-p:EnableCompressionInSingleFile=true',
      '--output', stagingDir,
    ], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    const stagedExecutable = path.join(stagingDir, 'aih-translation.exe');
    if (!await fsImpl.stat(stagedExecutable).catch(() => null)) {
      throw buildError('dotnet publish 未生成 aih-translation.exe');
    }
    await fsImpl.mkdir(path.dirname(releaseDir), { recursive: true });
    try {
      await fsImpl.rename(stagingDir, releaseDir);
    } catch (error) {
      // Another server process may have published the same content first.
      // Reuse its immutable release and discard our staging directory.
      if (!await fsImpl.stat(executable).catch(() => null)) throw error;
    }
    if (!await fsImpl.stat(executable).catch(() => null)) {
      throw buildError('Windows 翻译 helper 构建产物不可用');
    }
    return executable;
  } catch (error) {
    if (error && error.code === 'windows_helper_build_unavailable') throw error;
    const missingDotnet = error && (error.code === 'ENOENT' || /not found|not recognized/i.test(String(error.message || '')));
    throw buildError(missingDotnet
      ? '未找到 dotnet SDK；请在 Windows 安装 .NET 8 SDK 后重试'
      : `Windows 翻译 helper 构建失败：${error && error.message ? error.message : 'unknown error'}`, error);
  } finally {
    await fsImpl.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildWindowsTranslationHelper(aiHomeDir, options = {}) {
  return buildWindowsTranslationExecutable(aiHomeDir, { ...options, mode: 'helper' });
}

async function buildWindowsTranslationApp(aiHomeDir, options = {}) {
  return buildWindowsTranslationExecutable(aiHomeDir, { ...options, mode: 'full-app' });
}

module.exports = {
  buildWindowsTranslationExecutable,
  buildWindowsTranslationHelper,
  buildWindowsTranslationApp,
  normalizeArch,
};
