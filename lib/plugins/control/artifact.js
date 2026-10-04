'use strict';

// 离线插件包（.aih-plugin）：8 字节魔数 + 4 字节元数据长度 + JSON 元数据（manifest + 文件表，含每个文件的
// sha256）+ 按文件表顺序拼接的文件内容。
//
// 接受流程（acceptArtifact）只在私有副本上工作，避免「检查完再用」之间文件被替换：
//   1. 复制到 accepted/ 下的临时名，同时流式计算整体摘要；
//   2. 校验包结构与每个文件的摘要；
//   3. 原子 rename 成 accepted/<digest>.aih-plugin；
//   4. 从私有副本解压到 extracted/ 下的临时目录，边写边校验每个文件，全部通过后原子 rename 成
//      extracted/<digest>。任何一步失败都删除临时产物，坏包不会在磁盘上留下任何东西。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { limits } = require('../sdk/contract.generated.json');
const { PluginError, requireCondition } = require('../sdk/errors');
const { safeRelativePath, validateManifest } = require('../sdk/manifest');

const MAGIC = Buffer.from('AIHPLG01');
const HEADER_BYTES = MAGIC.length + 4;
const COPY_CHUNK_BYTES = 1024 * 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// 包内路径：相对、无 ..、无反斜杠/冒号，且任何一段都不是 Windows 保留名或以点/空格结尾
// （Windows 会静默去掉，导致两个不同的名字落到同一个文件上）。
function safePackagePath(value) {
  if (!safeRelativePath(value)) return false;
  return value.split('/').every((segment) => !WINDOWS_RESERVED.test(segment) && !/[. ]$/.test(segment));
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
      position += count;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function listSourceFiles(root, current = root, result = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) throw new PluginError('plugin_package_symlink', `不允许符号链接：${relative}`);
    if (!safePackagePath(relative)) throw new PluginError('plugin_package_path_invalid', `非法路径：${relative}`);
    if (entry.isDirectory()) listSourceFiles(root, absolute, result);
    else if (entry.isFile()) result.push({ absolute, path: relative });
    else throw new PluginError('plugin_package_entry_invalid', `不支持的文件类型：${relative}`);
  }
  return result;
}

function assertUniquePaths(paths) {
  const seen = new Set();
  for (const value of paths) {
    const folded = value.toLowerCase();
    requireCondition(!seen.has(folded), 'plugin_package_path_collision', `大小写不敏感的文件系统上会互相覆盖：${value}`);
    seen.add(folded);
  }
}

/** 从源目录打包。清单取自源目录的 plugin.json，并原样写进包。 */
function buildArtifact(sourceDir, outputFile, options = {}) {
  const root = path.resolve(String(sourceDir || ''));
  const output = path.resolve(String(outputFile || ''));
  requireCondition(fs.existsSync(root) && fs.statSync(root).isDirectory(), 'plugin_package_source_invalid');
  const manifestFile = path.join(root, 'plugin.json');
  requireCondition(fs.existsSync(manifestFile), 'plugin_manifest_missing', '源目录缺少 plugin.json');
  let manifestInput;
  try { manifestInput = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_error) { throw new PluginError('plugin_manifest_invalid', 'plugin.json 不是合法 JSON'); }
  const manifest = validateManifest(manifestInput, options);
  const files = listSourceFiles(root).sort((left, right) => left.path.localeCompare(right.path));
  assertUniquePaths(files.map((file) => file.path));
  requireCondition(files.some((file) => file.path === manifest.entry), 'plugin_entry_missing', `包内没有入口 ${manifest.entry}`);
  requireCondition(files.length <= limits.packageFiles, 'plugin_package_file_count');
  const records = files.map((file) => ({ path: file.path, size: fs.statSync(file.absolute).size, sha256: sha256File(file.absolute) }));
  const metadata = Buffer.from(JSON.stringify({ formatVersion: 1, manifest, files: records }));
  requireCondition(metadata.length <= limits.packageMetadataBytes, 'plugin_package_metadata_limit');
  const total = HEADER_BYTES + metadata.length + records.reduce((sum, record) => sum + record.size, 0);
  requireCondition(total <= limits.packageBytes, 'plugin_package_bytes_limit');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fd = fs.openSync(output, 'w', 0o600);
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header.writeUInt32BE(metadata.length, MAGIC.length);
    fs.writeSync(fd, header);
    fs.writeSync(fd, metadata);
    for (const file of files) fs.writeSync(fd, fs.readFileSync(file.absolute));
  } finally { fs.closeSync(fd); }
  return { file: output, digest: sha256File(output), bytes: total, manifest, files: records };
}

/** 校验包结构与每个文件的摘要（不解压）。只应对私有副本调用。 */
function inspectArtifact(file, options = {}) {
  const artifact = path.resolve(String(file || ''));
  const stat = fs.statSync(artifact);
  requireCondition(stat.isFile() && stat.size <= limits.packageBytes, 'plugin_package_bytes_limit');
  const fd = fs.openSync(artifact, 'r');
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new PluginError('plugin_package_magic_invalid', '不是 AIH 插件包');
    }
    const metadataBytes = header.readUInt32BE(MAGIC.length);
    requireCondition(metadataBytes > 0 && metadataBytes <= limits.packageMetadataBytes, 'plugin_package_metadata_limit');
    const metadataBuffer = Buffer.alloc(metadataBytes);
    requireCondition(fs.readSync(fd, metadataBuffer, 0, metadataBytes, HEADER_BYTES) === metadataBytes, 'plugin_package_truncated');
    let metadata;
    try { metadata = JSON.parse(metadataBuffer.toString('utf8')); } catch (_error) { throw new PluginError('plugin_package_metadata_invalid'); }
    requireCondition(metadata && metadata.formatVersion === 1 && Array.isArray(metadata.files), 'plugin_package_metadata_invalid');
    requireCondition(metadata.files.length <= limits.packageFiles, 'plugin_package_file_count');
    const manifest = validateManifest(metadata.manifest, options);
    assertUniquePaths(metadata.files.map((record) => String(record?.path || '')));
    let offset = HEADER_BYTES + metadataBytes;
    const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
    const records = metadata.files.map((record) => {
      requireCondition(record && safePackagePath(record.path), 'plugin_package_path_invalid', `非法路径：${record?.path}`);
      requireCondition(Number.isSafeInteger(record.size) && record.size >= 0, 'plugin_package_file_invalid');
      requireCondition(typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256), 'plugin_package_digest_invalid');
      const end = offset + record.size;
      requireCondition(end <= stat.size, 'plugin_package_truncated');
      const hash = crypto.createHash('sha256');
      for (let position = offset; position < end;) {
        const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
        requireCondition(count > 0, 'plugin_package_truncated');
        hash.update(chunk.subarray(0, count));
        position += count;
      }
      requireCondition(hash.digest('hex') === record.sha256, 'plugin_package_digest_mismatch', `文件被篡改：${record.path}`);
      const entry = { path: record.path, size: record.size, sha256: record.sha256, offset };
      offset = end;
      return entry;
    });
    requireCondition(offset === stat.size, 'plugin_package_trailing_bytes');
    requireCondition(records.some((record) => record.path === manifest.entry), 'plugin_entry_missing');
    return { file: artifact, manifest, files: records };
  } finally { fs.closeSync(fd); }
}

function copyWithDigest(source, target) {
  const hash = crypto.createHash('sha256');
  const input = fs.openSync(source, 'r');
  const output = fs.openSync(target, 'wx', 0o600);
  try {
    const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
    let total = 0;
    for (let position = 0; ;) {
      const count = fs.readSync(input, chunk, 0, chunk.length, position);
      if (!count) break;
      total += count;
      requireCondition(total <= limits.packageBytes, 'plugin_package_bytes_limit');
      hash.update(chunk.subarray(0, count));
      fs.writeSync(output, chunk, 0, count);
      position += count;
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
  return hash.digest('hex');
}

function extractVerified(inspected, destination) {
  const fd = fs.openSync(inspected.file, 'r');
  try {
    const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
    for (const record of inspected.files) {
      const target = path.join(destination, ...record.path.split('/'));
      const relative = path.relative(destination, target);
      requireCondition(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'plugin_package_path_invalid');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const output = fs.openSync(target, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      try {
        for (let position = record.offset, remaining = record.size; remaining > 0;) {
          const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, remaining), position);
          requireCondition(count > 0, 'plugin_package_truncated');
          hash.update(chunk.subarray(0, count));
          fs.writeSync(output, chunk, 0, count);
          remaining -= count;
          position += count;
        }
      } finally { fs.closeSync(output); }
      requireCondition(hash.digest('hex') === record.sha256, 'plugin_package_digest_mismatch', `解压时校验失败：${record.path}`);
    }
  } finally { fs.closeSync(fd); }
}

/**
 * 接受一个插件包：私有副本 + 校验 + 解压，返回 { digest, artifactPath, directory, manifest }。
 * 相同摘要的包重复接受是幂等的。
 */
function acceptArtifact(file, roots, options = {}) {
  const { acceptedDir, extractedDir } = roots;
  fs.mkdirSync(acceptedDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(extractedDir, { recursive: true, mode: 0o700 });
  const source = path.resolve(String(file || ''));
  requireCondition(fs.existsSync(source) && fs.statSync(source).isFile(), 'plugin_package_missing', `找不到插件包：${source}`);
  const nonce = crypto.randomBytes(8).toString('hex');
  const staging = path.join(acceptedDir, `.incoming-${nonce}`);
  const stagingDir = path.join(extractedDir, `.incoming-${nonce}`);
  try {
    const digest = copyWithDigest(source, staging);
    const inspected = inspectArtifact(staging, options);
    const artifactPath = path.join(acceptedDir, `${digest}.aih-plugin`);
    const directory = path.join(extractedDir, digest);
    if (fs.existsSync(artifactPath)) fs.rmSync(staging, { force: true });
    else fs.renameSync(staging, artifactPath);
    if (!fs.existsSync(directory)) {
      extractVerified({ ...inspected, file: artifactPath }, stagingDir);
      fs.renameSync(stagingDir, directory);
    }
    return { digest, artifactPath, directory, manifest: inspected.manifest, files: inspected.files.length };
  } finally {
    fs.rmSync(staging, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

module.exports = { MAGIC, acceptArtifact, buildArtifact, inspectArtifact, safePackagePath, sha256File };
