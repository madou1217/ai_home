'use strict';

const nodeFs = require('node:fs');
const nodeCrypto = require('node:crypto');
const nodeChildProcess = require('node:child_process');

function escapePowerShellPath(value) {
  return String(value || '').replace(/'/g, "''");
}

function directoryExists(fs, targetPath) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function mapProgressRange(start, end, ratio) {
  const safeRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  return clampPercent(start + ((end - start) * safeRatio));
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function resolveBundled7zipPath({ fs = nodeFs, sevenZipBin } = {}) {
  try {
    const bundled = sevenZipBin || require('7zip-bin');
    const candidates = [bundled && bundled.path7za, bundled && bundled.path7x]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (_error) {}
    }
  } catch (_error) {}
  return '';
}

function run7zExtractCommand({
  spawnImpl = nodeChildProcess.spawn,
  command,
  args,
  onProgress
}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let lastPercent = 0;
    const child = spawnImpl(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    function parseProgress(chunk) {
      const matches = String(chunk || '').match(/(\d{1,3})%/g) || [];
      for (const token of matches) {
        const pct = clampPercent(Number(token.replace('%', '')));
        if (pct <= lastPercent) continue;
        lastPercent = pct;
        if (typeof onProgress === 'function') onProgress(pct);
      }
    }

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', parseProgress);
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', parseProgress);
    }

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (Number(code) === 0) {
        if (typeof onProgress === 'function') onProgress(100);
        resolve(true);
        return;
      }
      reject(new Error(`7zip exited with code ${code}`));
    });
  });
}

async function tryExtractZipWith7z({
  zipPath,
  extractDir,
  processImpl,
  bundled7zPath,
  onProgress,
  spawnImpl
}) {
  const args = [
    'x',
    '-y',
    '-bb0',
    '-bd',
    '-bsp1',
    '-mmt=on',
    `-o${String(extractDir || '')}`,
    String(zipPath || '')
  ];
  const tryCommands = [];

  if (processImpl.platform === 'win32') {
    tryCommands.push('7z');
    tryCommands.push('7za');
    tryCommands.push('C:\\Program Files\\7-Zip\\7z.exe');
  } else {
    tryCommands.push('7z');
    tryCommands.push('7za');
  }

  const bundled = String(bundled7zPath || '').trim();
  if (bundled) tryCommands.push(bundled);

  for (const command of tryCommands) {
    try {
      await run7zExtractCommand({
        spawnImpl,
        command,
        args,
        onProgress
      });
      return true;
    } catch (_error) {}
  }
  return false;
}

async function extractZipArchive({
  execSync,
  processImpl,
  zipPath,
  extractDir,
  fs,
  onProgress,
  spawnImpl
}) {
  const bundled7zPath = resolveBundled7zipPath({ fs });
  if (await tryExtractZipWith7z({
    zipPath,
    extractDir,
    processImpl,
    bundled7zPath,
    onProgress,
    spawnImpl
  })) {
    return;
  }
  if (processImpl.platform === 'win32') {
    const src = escapePowerShellPath(zipPath);
    const dst = escapePowerShellPath(extractDir);
    if (typeof onProgress === 'function') onProgress(5);
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${src}' -DestinationPath '${dst}' -Force"`, {
      stdio: 'ignore'
    });
    if (typeof onProgress === 'function') onProgress(100);
    return;
  }
  if (typeof onProgress === 'function') onProgress(5);
  execSync(`unzip -oq "${zipPath}" -d "${extractDir}"`, { stdio: 'ignore' });
  if (typeof onProgress === 'function') onProgress(100);
}

function computeFileSha256(fs, cryptoImpl, filePath, onProgress) {
  const hash = (cryptoImpl || nodeCrypto).createHash('sha256');
  let totalBytes = 0;
  try {
    totalBytes = Number(fs.statSync(filePath).size) || 0;
  } catch (_error) {}
  if (typeof fs.createReadStream !== 'function') {
    const payload = fs.readFileSync(filePath);
    hash.update(payload);
    if (typeof onProgress === 'function') onProgress(payload.length, payload.length || totalBytes || 1);
    return Promise.resolve(hash.digest('hex'));
  }
  return new Promise((resolve, reject) => {
    let processed = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      processed += chunk.length;
      if (typeof onProgress === 'function') onProgress(processed, totalBytes || processed || 1);
    });
    stream.on('end', () => {
      if (typeof onProgress === 'function') onProgress(totalBytes || processed || 1, totalBytes || processed || 1);
      resolve(hash.digest('hex'));
    });
  });
}

function isArchiveExtractCacheReady(fs, path, cacheDir) {
  const extractDir = path.join(cacheDir, 'extract');
  const markerPath = path.join(cacheDir, '.ready.json');
  return directoryExists(fs, extractDir) && fs.existsSync(markerPath);
}

function finalizeArchiveCache({ fs, fse, stagingDir, cacheDir }) {
  try {
    fse.moveSync(stagingDir, cacheDir, { overwrite: true });
    return;
  } catch (error) {
    const code = String(error && error.code || '').trim().toUpperCase();
    if (!['EPERM', 'EXDEV', 'EACCES'].includes(code)) {
      throw error;
    }
  }

  if (directoryExists(fs, cacheDir)) {
    fse.removeSync(cacheDir);
  }
  fse.copySync(stagingDir, cacheDir, { overwrite: true });
  if (directoryExists(fs, stagingDir)) {
    fse.removeSync(stagingDir);
  }
}

async function ensureArchiveExtractedByHash({
  fs,
  path,
  os,
  fse,
  execSync,
  processImpl,
  cryptoImpl,
  zipPath,
  aiHomeDir,
  spawnImpl,
  onHashProgress,
  onExtractProgress
}) {
  const hash = await computeFileSha256(fs, cryptoImpl, zipPath, onHashProgress);
  const cacheRoot = aiHomeDir
    ? path.join(aiHomeDir, '.cache', 'import-zip')
    : path.join(os.tmpdir(), 'aih_import_zip_cache');
  fse.ensureDirSync(cacheRoot);

  const cacheDir = path.join(cacheRoot, hash);
  const extractDir = path.join(cacheDir, 'extract');
  const markerPath = path.join(cacheDir, '.ready.json');
  if (isArchiveExtractCacheReady(fs, path, cacheDir)) {
    if (typeof onExtractProgress === 'function') onExtractProgress(100);
    return {
      hash,
      extractDir,
      cacheHit: true
    };
  }

  const stagingDir = fs.mkdtempSync(path.join(cacheRoot, `${hash}.tmp-`));
  const stagingExtractDir = path.join(stagingDir, 'extract');
  fse.ensureDirSync(stagingExtractDir);

  try {
    await extractZipArchive({
      execSync,
      processImpl,
      zipPath,
      extractDir: stagingExtractDir,
      fs,
      onProgress: onExtractProgress,
      spawnImpl
    });

    if (isArchiveExtractCacheReady(fs, path, cacheDir)) {
      fse.removeSync(stagingDir);
      return {
        hash,
        extractDir,
        cacheHit: true
      };
    }

    if (directoryExists(fs, cacheDir)) {
      fse.removeSync(cacheDir);
    }
    finalizeArchiveCache({
      fs,
      fse,
      stagingDir,
      cacheDir
    });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      hash,
      sourceName: path.basename(zipPath),
      createdAt: new Date().toISOString()
    }, null, 2)}\n`);

    return {
      hash,
      extractDir,
      cacheHit: false
    };
  } catch (error) {
    if (directoryExists(fs, stagingDir)) {
      fse.removeSync(stagingDir);
    }
    throw error;
  }
}

module.exports = {
  clampPercent,
  mapProgressRange,
  formatBytes,
  resolveBundled7zipPath,
  tryExtractZipWith7z,
  extractZipArchive,
  computeFileSha256,
  isArchiveExtractCacheReady,
  finalizeArchiveCache,
  ensureArchiveExtractedByHash
};
