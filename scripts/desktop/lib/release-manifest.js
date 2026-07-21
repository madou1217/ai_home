'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  describeDigest,
  listRecursively,
  readJson,
  writeJson,
} = require('./fs-utils');

const RELEASE_ASSET_KINDS = Object.freeze([
  ['dmg', '.dmg'],
  ['msi', '.msi'],
  ['deb', '.deb'],
  ['appimage', '.appimage'],
]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

function isValidSemver(version) {
  if (!SEMVER_PATTERN.test(version)) return false;
  const prereleaseStart = version.indexOf('-');
  const buildStart = version.indexOf('+');
  if (prereleaseStart < 0 || (buildStart >= 0 && prereleaseStart > buildStart)) return true;
  const prerelease = version.slice(
    prereleaseStart + 1,
    buildStart < 0 ? undefined : buildStart,
  );
  return prerelease.split('.').every(
    (identifier) => (
      !/^\d+$/u.test(identifier)
      || identifier === '0'
      || !identifier.startsWith('0')
    ),
  );
}

function readCargoPackageVersion(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/u);
  let inPackageSection = false;
  for (const line of lines) {
    if (/^\s*\[package\]\s*(?:#.*)?$/u.test(line)) {
      inPackageSection = true;
      continue;
    }
    if (inPackageSection && /^\s*\[.+\]\s*(?:#.*)?$/u.test(line)) {
      break;
    }
    if (!inPackageSection) continue;
    const version = line.match(/^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/u);
    if (version) return version[1];
  }
  throw new Error(
    inPackageSection
      ? 'src-tauri/Cargo.toml 缺少 [package].version'
      : 'src-tauri/Cargo.toml 缺少 [package]',
  );
}

function readReleaseDescriptor(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const rootPackage = readJson(path.join(root, 'package.json'));
  const webPackage = readJson(path.join(root, 'web', 'package.json'));
  const tauriConfig = readJson(path.join(root, 'src-tauri', 'tauri.conf.json'));
  const versions = {
    'package.json': String(rootPackage.version || '').trim(),
    'web/package.json': String(webPackage.version || '').trim(),
    'src-tauri/tauri.conf.json': String(
      tauriConfig && tauriConfig.package && tauriConfig.package.version || '',
    ).trim(),
    'src-tauri/Cargo.toml': readCargoPackageVersion(
      path.join(root, 'src-tauri', 'Cargo.toml'),
    ),
  };
  const version = versions['package.json'];
  const mismatches = Object.entries(versions)
    .filter(([, candidate]) => candidate !== version)
    .map(([source, candidate]) => `${source}=${candidate || '(empty)'}`);
  if (mismatches.length > 0) {
    throw new Error(
      `桌面发布版本不一致: package.json=${version || '(empty)'}, ${mismatches.join(', ')}`,
    );
  }
  if (!isValidSemver(version)) {
    throw new Error(`桌面发布版本不是有效的 SemVer: ${version || '(empty)'}`);
  }
  const productName = String(
    tauriConfig && tauriConfig.package && tauriConfig.package.productName || '',
  ).trim();
  if (!productName || productName.length > 80 || /[\r\n\0]/u.test(productName)) {
    throw new Error('src-tauri/tauri.conf.json 的 package.productName 无效');
  }
  const tag = `v${version}`;
  return {
    productName,
    version,
    tag,
    title: `${productName} ${tag} (Unsigned Preview)`,
    prerelease: true,
  };
}

function isStrictChild(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function validateReleaseDirectories(workspaceRoot, inputRoot, outputRoot) {
  const workspace = fs.realpathSync(path.resolve(workspaceRoot));
  const unresolvedInput = path.resolve(inputRoot);
  const unresolvedOutput = path.resolve(outputRoot);
  if (!fs.existsSync(unresolvedInput) || !fs.statSync(unresolvedInput).isDirectory()) {
    throw new Error(`Release 制品输入目录不存在: ${unresolvedInput}`);
  }
  if (fs.existsSync(unresolvedOutput) && fs.lstatSync(unresolvedOutput).isSymbolicLink()) {
    throw new Error('Release 输出目录不能是符号链接');
  }
  const outputParent = path.dirname(unresolvedOutput);
  if (!fs.existsSync(outputParent) || !fs.statSync(outputParent).isDirectory()) {
    throw new Error(`Release 输出目录的父目录不存在: ${outputParent}`);
  }
  const input = fs.realpathSync(unresolvedInput);
  const output = path.join(fs.realpathSync(outputParent), path.basename(unresolvedOutput));
  if (!isStrictChild(workspace, input) || !isStrictChild(workspace, output)) {
    throw new Error('Release 制品输入和输出目录必须位于工作区内');
  }
  if (input === output || isStrictChild(input, output) || isStrictChild(output, input)) {
    throw new Error('Release 输出目录不能位于制品输入目录内或包含制品输入目录');
  }
  return { input, output };
}

function releaseAssetKind(filePath) {
  const lowerPath = filePath.toLowerCase();
  const match = RELEASE_ASSET_KINDS.find(([, extension]) => lowerPath.endsWith(extension));
  return match ? match[0] : '';
}

function normalizeReleaseAssetName(fileName) {
  const normalized = fileName
    .replace(/[^0-9A-Za-z._-]+/gu, '.')
    .replace(/\.{2,}/gu, '.')
    .replace(/^\.+|\.+$/gu, '');
  if (!normalized) {
    throw new Error(`Release 制品文件名无法转换为 GitHub 安全名称: ${fileName}`);
  }
  return normalized;
}

function collectReleaseAssets(inputRoot, version = '') {
  const absoluteInput = path.resolve(inputRoot);
  if (!fs.existsSync(absoluteInput) || !fs.statSync(absoluteInput).isDirectory()) {
    throw new Error(`Release 制品输入目录不存在: ${absoluteInput}`);
  }
  const candidates = new Map(RELEASE_ASSET_KINDS.map(([kind]) => [kind, []]));
  for (const entry of listRecursively(absoluteInput)) {
    if (!entry.stat.isFile() || entry.stat.isSymbolicLink()) continue;
    const kind = releaseAssetKind(entry.path);
    if (kind) candidates.get(kind).push(entry.path);
  }

  const assets = [];
  for (const [kind] of RELEASE_ASSET_KINDS) {
    const matches = candidates.get(kind).sort((left, right) => left.localeCompare(right));
    if (matches.length !== 1) {
      throw new Error(`Release 期望 1 个 ${kind} 制品，实际找到 ${matches.length} 个`);
    }
    const sourcePath = matches[0];
    const fileName = path.basename(sourcePath);
    const stat = fs.statSync(sourcePath);
    if (stat.size <= 0) {
      throw new Error(`Release ${kind} 制品不能为空: ${fileName}`);
    }
    if (version && !fileName.split('_').includes(version)) {
      throw new Error(`Release ${kind} 制品文件名不含版本 ${version}: ${fileName}`);
    }
    if (/[\r\n\0]/u.test(fileName)) {
      throw new Error(`Release ${kind} 制品文件名包含控制字符`);
    }
    assets.push({
      kind,
      sourcePath,
      fileName: normalizeReleaseAssetName(fileName),
    });
  }
  const uniqueNames = new Set(assets.map((asset) => asset.fileName));
  if (uniqueNames.size !== assets.length) {
    throw new Error('Release 制品文件名必须唯一');
  }
  return assets;
}

function stageReleaseAssets(options) {
  const descriptor = readReleaseDescriptor(options.workspaceRoot);
  const directories = validateReleaseDirectories(
    options.workspaceRoot,
    options.inputRoot,
    options.outputRoot,
  );
  const candidates = collectReleaseAssets(directories.input, descriptor.version);
  fs.rmSync(directories.output, { force: true, recursive: true });
  fs.mkdirSync(directories.output, { recursive: true });

  const assets = candidates.map((candidate) => {
    const targetPath = path.join(directories.output, candidate.fileName);
    fs.copyFileSync(candidate.sourcePath, targetPath);
    const sourceDigest = describeDigest(candidate.sourcePath);
    const targetDigest = describeDigest(targetPath);
    if (sourceDigest.sha256 !== targetDigest.sha256 || sourceDigest.sizeBytes !== targetDigest.sizeBytes) {
      throw new Error(`Release 制品复制后校验失败: ${candidate.fileName}`);
    }
    return {
      kind: candidate.kind,
      fileName: candidate.fileName,
      sizeBytes: targetDigest.sizeBytes,
      sha256: targetDigest.sha256,
    };
  });

  const manifest = {
    schemaVersion: 1,
    productName: descriptor.productName,
    version: descriptor.version,
    tag: descriptor.tag,
    title: descriptor.title,
    prerelease: descriptor.prerelease,
    distributionSigning: 'unsigned',
    commit: String(process.env.GITHUB_SHA || '').trim() || null,
    runId: String(process.env.GITHUB_RUN_ID || '').trim() || null,
    runAttempt: String(process.env.GITHUB_RUN_ATTEMPT || '').trim() || null,
    assets,
  };
  fs.writeFileSync(
    path.join(directories.output, 'SHA256SUMS.txt'),
    `${assets.map((asset) => `${asset.sha256}  ${asset.fileName}`).join('\n')}\n`,
    'utf8',
  );
  writeJson(path.join(directories.output, 'release-manifest.json'), manifest);
  return manifest;
}

function normalizeCommitSha(value, label, allowEmpty = false) {
  const sha = String(value || '').trim().toLowerCase();
  if (!sha && allowEmpty) return '';
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`${label} 不是有效的 Git commit SHA`);
  }
  return sha;
}

function resolveReleaseAction(options) {
  const currentSha = normalizeCommitSha(options.currentSha, '当前提交');
  const tagCommitSha = normalizeCommitSha(options.tagCommitSha, 'Tag 提交', true);
  const releaseExists = options.releaseExists === true;
  if (releaseExists && !tagCommitSha) {
    throw new Error('GitHub Release 已存在但 Tag 不存在');
  }
  if (tagCommitSha && tagCommitSha !== currentSha) {
    throw new Error(`GitHub Release Tag 已指向不同提交: ${tagCommitSha}`);
  }
  return releaseExists ? 'update' : 'create';
}

module.exports = {
  RELEASE_ASSET_KINDS,
  collectReleaseAssets,
  normalizeReleaseAssetName,
  readCargoPackageVersion,
  readReleaseDescriptor,
  releaseAssetKind,
  resolveReleaseAction,
  stageReleaseAssets,
};
