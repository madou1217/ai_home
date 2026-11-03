'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { request } = require('undici');
const { getProxyDispatcher, resolveProxyConfig } = require('../../../../server/http-utils-utils');

const MANIFEST_URL = 'https://herdr.dev/latest.json';

async function download(url, maxBytes) {
  let source = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (source.protocol !== 'https:' || source.username || source.password) {
      throw new Error('herdr_download_url_invalid');
    }
    const proxy = resolveProxyConfig(source.toString());
    const response = await request(source, {
      headers: { 'User-Agent': 'ai-home-toolkit' },
      headersTimeout: 30000,
      bodyTimeout: 180000,
      ...(proxy.url ? { dispatcher: getProxyDispatcher(proxy.url) } : {})
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      await response.body.dump();
      source = new URL(response.headers.location, source);
      continue;
    }
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new Error(`herdr_download_http_${response.statusCode}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { response.body.destroy(); throw new Error('herdr_download_too_large'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('herdr_download_redirect_limit');
}

async function installHerdr(target, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const osName = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform];
  const releaseArch = platform === 'win32' ? 'x86_64' : { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!osName || !releaseArch) throw new Error('herdr_unsupported_platform');
  const manifest = JSON.parse((await download(MANIFEST_URL, 2 * 1024 * 1024)).toString('utf8'));
  const key = `${osName}-${releaseArch}`;
  const source = new URL(String(manifest.assets?.[key] || ''));
  const checksum = String(manifest.sha256?.[key] || '').toLowerCase();
  if (source.protocol !== 'https:' || source.hostname !== 'github.com'
    || !source.pathname.startsWith('/herdrdev/herdr/releases/download/') || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error('herdr_release_manifest_invalid');
  }
  const bytes = await download(source.toString(), 256 * 1024 * 1024);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('herdr_checksum_mismatch');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = `${target}.aih-${crypto.randomBytes(6).toString('hex')}`;
  let tempDir;
  try {
    if (platform === 'win32') {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-herdr-'));
      const archive = path.join(tempDir, 'herdr.zip');
      fs.writeFileSync(archive, bytes);
      const quote = (v) => `'${v.replace(/'/g, "''")}'`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(tempDir)} -Force`], {
        encoding: 'utf8', windowsHide: true, timeout: 120000
      });
      if (result.status !== 0) throw new Error('herdr_archive_extract_failed');
      const findBinary = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? findBinary(file) : entry.name.toLowerCase() === 'herdr.exe' ? [file] : [];
      });
      const binary = findBinary(tempDir);
      if (binary.length !== 1) throw new Error('herdr_archive_binary_ambiguous');
      const packageFiles = listExtractedRuntimeFiles(tempDir, archive);
      if (!packageFiles.some((file) => path.basename(file).toLowerCase() === 'herdr.exe')) {
        throw new Error('herdr_archive_binary_missing');
      }
      const stagingDir = `${path.dirname(target)}.aih-${crypto.randomBytes(6).toString('hex')}`;
      fs.mkdirSync(stagingDir, { recursive: true });
      try {
        for (const source of packageFiles) {
          const relative = path.relative(tempDir, source);
          const staged = path.join(stagingDir, relative);
          fs.mkdirSync(path.dirname(staged), { recursive: true });
          fs.copyFileSync(source, staged);
        }
        // Install every runtime file through a sibling staging path and rename
        // individually. Herdr's Windows package includes conpty.dll and
        // OpenConsole.exe; copying only herdr.exe makes the installed binary
        // start and then fail when it opens a native terminal.
        for (const source of packageFiles) {
          const relative = path.relative(tempDir, source);
          const staged = path.join(stagingDir, relative);
          const destination = path.join(path.dirname(target), relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          replaceInstalledFile(staged, destination);
        }
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    } else {
      fs.writeFileSync(staging, bytes, { mode: 0o755, flag: 'wx' });
      const version = spawnSync(staging, ['--version'], { encoding: 'utf8', timeout: 10000 });
      if (version.status !== 0 || !String(version.stdout).includes(`herdr ${manifest.version}`)) {
        throw new Error('herdr_binary_verification_failed');
      }
      fs.renameSync(staging, target);
    }
  } finally {
    try { fs.unlinkSync(staging); } catch (_error) {}
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return { ok: true, version: manifest.version, target };
}

function replaceInstalledFile(staged, destination) {
  try {
    fs.renameSync(staged, destination);
    return;
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(String(error && error.code || ''))
      || !fs.existsSync(destination)) throw error;
  }
  // Windows cannot rename over an existing file. Move the old inode aside,
  // install the already verified staged file, and remove the backup. If the
  // second rename fails, restore the old file before surfacing the error.
  const backup = `${destination}.aih-old-${crypto.randomBytes(6).toString('hex')}`;
  fs.renameSync(destination, backup);
  try {
    fs.renameSync(staged, destination);
  } catch (error) {
    try { fs.renameSync(backup, destination); } catch (_restoreError) {}
    throw error;
  }
  fs.unlinkSync(backup);
}

function listExtractedRuntimeFiles(root, archivePath) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (file === archivePath) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  visit(root);
  return files;
}

if (require.main === module) {
  const target = String(process.argv[2] || '');
  if (!path.isAbsolute(target) || !/^herdr(?:\.exe)?$/.test(path.basename(target))) {
    process.stderr.write('invalid_herdr_install_target\n'); process.exitCode = 1;
  } else installHerdr(target).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { installHerdr };
