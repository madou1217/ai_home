'use strict';

const fsBase = require('node:fs');
const osBase = require('node:os');
const pathBase = require('node:path');
const { spawnSync: spawnSyncBase } = require('node:child_process');
const { detectImageType, normalizeMimeType, validateImageBuffer } = require('./image-data');

function createClipboardError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizePlatform(value) {
  return String(value || process.platform).trim() || process.platform;
}

function mkTempImagePath(fsImpl, osImpl, pathImpl, extension = 'png') {
  const dir = fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), 'aih-ssh-clipboard-'));
  return pathImpl.join(dir, `clipboard.${extension}`);
}

function cleanupTempFile(fsImpl, pathImpl, filePath) {
  try { fsImpl.unlinkSync(filePath); } catch (_error) {}
  try {
    if (typeof fsImpl.rmSync === 'function') {
      fsImpl.rmSync(pathImpl.dirname(filePath), { recursive: true, force: true });
    }
  } catch (_error) {}
}

function readExistingImageFile(fsImpl, filePath, mimeType, maxBytes) {
  try {
    if (!filePath || !fsImpl.existsSync(filePath)) return null;
    const buffer = fsImpl.readFileSync(filePath);
    const info = validateImageBuffer(buffer, { mimeType, maxBytes });
    return {
      buffer,
      mimeType: info.mimeType,
      sha256: info.sha256,
      byteLength: info.byteLength
    };
  } catch (_error) {
    return null;
  }
}

function normalizeSpawnBufferResult(result) {
  if (!result || result.status !== 0) return null;
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(String(result.stdout || ''), 'utf8');
  return stdout.length ? stdout : null;
}

function tryReadMacClipboardImage(deps, maxBytes) {
  const { fsImpl, osImpl, pathImpl, spawnSync } = deps;
  const pngpastePath = mkTempImagePath(fsImpl, osImpl, pathImpl, 'png');
  try {
    const pngpaste = spawnSync('pngpaste', [pngpastePath], { stdio: 'ignore' });
    const image = readExistingImageFile(fsImpl, pngpastePath, 'image/png', maxBytes);
    if (pngpaste && pngpaste.status === 0 && image) return image;
  } catch (_error) {
  } finally {
    cleanupTempFile(fsImpl, pathImpl, pngpastePath);
  }

  const osascriptPath = mkTempImagePath(fsImpl, osImpl, pathImpl, 'png');
  const quotedPath = osascriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    `set outPath to POSIX file "${quotedPath}"`,
    'try',
    '  set pngData to the clipboard as «class PNGf»',
    '  set fileRef to open for access outPath with write permission',
    '  set eof fileRef to 0',
    '  write pngData to fileRef',
    '  close access fileRef',
    'on error',
    '  try',
    '    close access outPath',
    '  end try',
    '  error number -128',
    'end try'
  ];
  try {
    const result = spawnSync('osascript', script.flatMap((line) => ['-e', line]), { stdio: 'ignore' });
    const image = readExistingImageFile(fsImpl, osascriptPath, 'image/png', maxBytes);
    if (result && result.status === 0 && image) return image;
  } catch (_error) {
  } finally {
    cleanupTempFile(fsImpl, pathImpl, osascriptPath);
  }
  return null;
}

function tryReadLinuxClipboardImage(deps, maxBytes) {
  const { spawnSync } = deps;
  const candidates = [
    { command: 'wl-paste', args: ['--type', 'image/png'], mimeType: 'image/png' },
    { command: 'wl-paste', args: ['--type', 'image/jpeg'], mimeType: 'image/jpeg' },
    { command: 'wl-paste', args: ['--type', 'image/webp'], mimeType: 'image/webp' },
    { command: 'wl-paste', args: ['--type', 'image/gif'], mimeType: 'image/gif' },
    { command: 'wl-paste', args: ['--type', 'image/tiff'], mimeType: 'image/tiff' },
    { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], mimeType: 'image/png' },
    { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/jpeg', '-o'], mimeType: 'image/jpeg' },
    { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/webp', '-o'], mimeType: 'image/webp' },
    { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/gif', '-o'], mimeType: 'image/gif' },
    { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/tiff', '-o'], mimeType: 'image/tiff' }
  ];

  for (const candidate of candidates) {
    try {
      const stdout = normalizeSpawnBufferResult(spawnSync(candidate.command, candidate.args, {
        encoding: null,
        maxBuffer: maxBytes + 1024
      }));
      if (!stdout) continue;
      const info = validateImageBuffer(stdout, { mimeType: candidate.mimeType, maxBytes });
      return {
        buffer: stdout,
        mimeType: info.mimeType,
        sha256: info.sha256,
        byteLength: info.byteLength
      };
    } catch (_error) {}
  }
  return null;
}

function tryReadWindowsClipboardImage(deps, maxBytes) {
  const { fsImpl, osImpl, pathImpl, spawnSync } = deps;
  const imagePath = mkTempImagePath(fsImpl, osImpl, pathImpl, 'png');
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { exit 4 }',
    `$file = "${imagePath.replace(/`/g, '``').replace(/"/g, '`"')}"`,
    '$img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)',
    'Write-Output $file'
  ].join('; ');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const commands = ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
  try {
    for (const command of commands) {
      try {
        const result = spawnSync(command, ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const image = readExistingImageFile(fsImpl, imagePath, 'image/png', maxBytes);
        if (result && result.status === 0 && image) return image;
      } catch (_error) {}
    }
  } finally {
    cleanupTempFile(fsImpl, pathImpl, imagePath);
  }
  return null;
}

function readClipboardImage(options = {}) {
  const fsImpl = options.fs || fsBase;
  const osImpl = options.os || osBase;
  const pathImpl = options.path || pathBase;
  const spawnSync = options.spawnSync || spawnSyncBase;
  const platform = normalizePlatform(options.platform);
  const maxBytes = Math.max(1, Number(options.maxBytes) || (16 * 1024 * 1024));
  const deps = { fsImpl, osImpl, pathImpl, spawnSync };

  let image = null;
  if (platform === 'darwin') {
    image = tryReadMacClipboardImage(deps, maxBytes);
  } else if (platform === 'win32') {
    image = tryReadWindowsClipboardImage(deps, maxBytes);
  } else {
    image = tryReadLinuxClipboardImage(deps, maxBytes);
  }

  if (!image) return null;
  const detected = detectImageType(image.buffer);
  const mimeType = normalizeMimeType(image.mimeType) || (detected && detected.mimeType);
  if (!mimeType) throw createClipboardError('ssh_clip_clipboard_image_unsupported');
  return {
    ...image,
    mimeType
  };
}

module.exports = {
  readClipboardImage
};
