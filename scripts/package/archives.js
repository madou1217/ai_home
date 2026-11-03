'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ensureDir, removeIfExists, sha256File } = require('./fs-utils');

function sevenZipPath() {
  const binary = require('7zip-bin').path7za;
  try {
    fs.chmodSync(binary, 0o755);
  } catch (_error) { /* 只影响可执行位；失败时交给 spawn 报错 */ }
  return binary;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.stdio || 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

/** 生成 tar.gz（保留 Unix 可执行位）。 */
function createTarGz(bundleRoot, outputPath) {
  ensureDir(path.dirname(outputPath));
  removeIfExists(outputPath);
  const args = ['-czf', outputPath];
  // macOS 的 bsdtar 默认把 xattr 和 AppleDouble 元数据写进归档；
  // 目标机器是 Linux 时会看到无害但吵人的警告。
  if (process.platform === 'darwin') args.push('--no-xattrs');
  args.push(
    '--exclude=.DS_Store',
    '--exclude=._.DS_Store',
    '--exclude=._*',
    '-C',
    path.dirname(bundleRoot),
    path.basename(bundleRoot)
  );
  run('tar', args, { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return outputPath;
}

/** 生成 zip。用 7za 保证构建机不需要额外的 zip 工具。 */
function createZip(bundleRoot, outputPath) {
  ensureDir(path.dirname(outputPath));
  removeIfExists(outputPath);
  run(sevenZipPath(), ['a', '-tzip', '-mx=7', outputPath, path.basename(bundleRoot)], {
    cwd: path.dirname(bundleRoot)
  });
  return outputPath;
}

/**
 * 生成 SFX 的内嵌载荷：zip 的条目必须是 bundle 内的相对路径，
 * Go 端解包后直接得到 runtime/、bin/、web/ 布局。
 */
function createPayloadZip(bundleRoot, outputPath) {
  ensureDir(path.dirname(outputPath));
  removeIfExists(outputPath);
  run(sevenZipPath(), ['a', '-tzip', '-mx=7', outputPath, '.'], { cwd: bundleRoot });
  return outputPath;
}

function writeChecksum(filePath) {
  const hash = sha256File(filePath);
  const line = `${hash}  ${path.basename(filePath)}\n`;
  fs.writeFileSync(`${filePath}.sha256`, line);
  return { sha256: hash, checksumFile: `${path.basename(filePath)}.sha256` };
}

module.exports = {
  createPayloadZip,
  createTarGz,
  createZip,
  sevenZipPath,
  writeChecksum
};
