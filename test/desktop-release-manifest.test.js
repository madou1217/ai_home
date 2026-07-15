'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readReleaseDescriptor,
  resolveReleaseAction,
  stageReleaseAssets,
} = require('../scripts/desktop/lib/release-manifest');

const VERSION = '1.0.0';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeVersionSources(workspaceRoot, versions = {}) {
  const rootVersion = versions.root || VERSION;
  const webVersion = versions.web || rootVersion;
  const tauriVersion = versions.tauri || rootVersion;
  const cargoVersion = versions.cargo || rootVersion;
  writeJson(path.join(workspaceRoot, 'package.json'), { name: 'ai-home', version: rootVersion });
  writeJson(path.join(workspaceRoot, 'web', 'package.json'), { name: 'ai-home-web', version: webVersion });
  writeJson(path.join(workspaceRoot, 'src-tauri', 'tauri.conf.json'), {
    package: { productName: 'AI Home', version: tauriVersion },
  });
  fs.writeFileSync(
    path.join(workspaceRoot, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "ai-home"\nversion = "${cargoVersion}"\n\n[dependencies]\n`,
    'utf8',
  );
}

function writeReleaseBundles(inputRoot) {
  const bundles = [
    ['macos', `AI Home_${VERSION}_aarch64.dmg`],
    ['windows', `AI Home_${VERSION}_x64_en-US.msi`],
    ['linux', `ai-home_${VERSION}_amd64.deb`],
    ['linux', `ai-home_${VERSION}_amd64.AppImage`],
  ];
  for (const [directory, fileName] of bundles) {
    const filePath = path.join(inputRoot, directory, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(`fixture:${fileName}`, 'utf8'));
  }
  fs.writeFileSync(path.join(inputRoot, 'linux', 'release-evidence.json'), '{}\n', 'utf8');
}

function createFixture() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-release-manifest-'));
  const inputRoot = path.join(workspaceRoot, 'downloaded-artifacts');
  const outputRoot = path.join(workspaceRoot, 'release-assets');
  writeVersionSources(workspaceRoot);
  writeReleaseBundles(inputRoot);
  return { inputRoot, outputRoot, workspaceRoot };
}

test('release descriptor requires every package version to match one SemVer', () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(readReleaseDescriptor(fixture.workspaceRoot), {
      productName: 'AI Home',
      version: VERSION,
      tag: `v${VERSION}`,
      title: `AI Home v${VERSION} (Unsigned Preview)`,
      prerelease: true,
    });

    writeVersionSources(fixture.workspaceRoot, { web: '1.0.1' });
    assert.throws(
      () => readReleaseDescriptor(fixture.workspaceRoot),
      /版本不一致/u,
    );

    writeVersionSources(fixture.workspaceRoot, { root: 'latest' });
    assert.throws(
      () => readReleaseDescriptor(fixture.workspaceRoot),
      /SemVer/u,
    );

    writeVersionSources(fixture.workspaceRoot, { root: '1.0.0-01' });
    assert.throws(
      () => readReleaseDescriptor(fixture.workspaceRoot),
      /SemVer/u,
    );

    writeVersionSources(fixture.workspaceRoot, { root: '1.0.0+build-01' });
    assert.equal(readReleaseDescriptor(fixture.workspaceRoot).version, '1.0.0+build-01');
  } finally {
    fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
  }
});

test('release asset staging publishes only one non-empty installer per platform kind', () => {
  const fixture = createFixture();
  try {
    const manifest = stageReleaseAssets(fixture);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.tag, `v${VERSION}`);
    assert.deepEqual(
      manifest.assets.map((asset) => asset.kind),
      ['dmg', 'msi', 'deb', 'appimage'],
    );
    assert.equal(manifest.assets.every((asset) => asset.sizeBytes > 0), true);
    assert.equal(manifest.assets.every((asset) => /^[a-f0-9]{64}$/u.test(asset.sha256)), true);

    const stagedNames = fs.readdirSync(fixture.outputRoot).sort();
    assert.deepEqual(stagedNames, [
      `AI Home_${VERSION}_aarch64.dmg`,
      `AI Home_${VERSION}_x64_en-US.msi`,
      'SHA256SUMS.txt',
      `ai-home_${VERSION}_amd64.AppImage`,
      `ai-home_${VERSION}_amd64.deb`,
      'release-manifest.json',
    ].sort());
    const checksums = fs.readFileSync(
      path.join(fixture.outputRoot, 'SHA256SUMS.txt'),
      'utf8',
    );
    for (const asset of manifest.assets) {
      assert.match(checksums, new RegExp(`${asset.sha256}  ${asset.fileName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(fixture.outputRoot, 'release-manifest.json'), 'utf8')),
      manifest,
    );
  } finally {
    fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
  }
});

test('release asset staging rejects missing, duplicate, empty, and unsafe bundles', async (context) => {
  await context.test('missing kind', () => {
    const fixture = createFixture();
    try {
      fs.rmSync(path.join(fixture.inputRoot, 'linux', `ai-home_${VERSION}_amd64.deb`));
      assert.throws(() => stageReleaseAssets(fixture), /deb.*实际找到 0/u);
    } finally {
      fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
    }
  });

  await context.test('duplicate kind', () => {
    const fixture = createFixture();
    try {
      fs.writeFileSync(path.join(fixture.inputRoot, 'macos', `duplicate-${VERSION}.dmg`), 'duplicate');
      assert.throws(() => stageReleaseAssets(fixture), /dmg.*实际找到 2/u);
    } finally {
      fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
    }
  });

  await context.test('empty bundle', () => {
    const fixture = createFixture();
    try {
      fs.writeFileSync(path.join(fixture.inputRoot, 'linux', `ai-home_${VERSION}_amd64.AppImage`), '');
      assert.throws(() => stageReleaseAssets(fixture), /不能为空/u);
    } finally {
      fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
    }
  });

  await context.test('ambiguous version substring', () => {
    for (const wrongVersion of ['11.0.0', '1.0.0.1', '1.0.0-alpha']) {
      const fixture = createFixture();
      try {
        const sourcePath = path.join(fixture.inputRoot, 'macos', `AI Home_${VERSION}_aarch64.dmg`);
        fs.renameSync(
          sourcePath,
          path.join(fixture.inputRoot, 'macos', `AI Home_${wrongVersion}_aarch64.dmg`),
        );
        assert.throws(() => stageReleaseAssets(fixture), /文件名不含版本/u);
      } finally {
        fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
      }
    }
  });

  await context.test('output nested inside downloaded artifacts', () => {
    const fixture = createFixture();
    try {
      assert.throws(
        () => stageReleaseAssets({
          ...fixture,
          outputRoot: path.join(fixture.inputRoot, 'release-assets'),
        }),
        /输出目录不能位于制品输入目录内/u,
      );
    } finally {
      fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
    }
  });

  await context.test('input symlink escapes the workspace', () => {
    const fixture = createFixture();
    const externalInput = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-release-external-'));
    try {
      fs.rmSync(fixture.inputRoot, { force: true, recursive: true });
      writeReleaseBundles(externalInput);
      fs.symlinkSync(
        externalInput,
        fixture.inputRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      assert.throws(() => stageReleaseAssets(fixture), /必须位于工作区内/u);
    } finally {
      fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
      fs.rmSync(externalInput, { force: true, recursive: true });
    }
  });
});

test('release action planning is idempotent and never moves an existing tag', () => {
  const currentSha = 'a'.repeat(40);
  assert.equal(resolveReleaseAction({ currentSha, tagCommitSha: '', releaseExists: false }), 'create');
  assert.equal(resolveReleaseAction({ currentSha, tagCommitSha: currentSha, releaseExists: false }), 'create');
  assert.equal(resolveReleaseAction({ currentSha, tagCommitSha: currentSha, releaseExists: true }), 'update');
  assert.throws(
    () => resolveReleaseAction({
      currentSha,
      tagCommitSha: 'b'.repeat(40),
      releaseExists: true,
    }),
    /已指向不同提交/u,
  );
  assert.throws(
    () => resolveReleaseAction({
      currentSha,
      tagCommitSha: 'b'.repeat(40),
      releaseExists: false,
    }),
    /已指向不同提交/u,
  );
  assert.throws(
    () => resolveReleaseAction({ currentSha, tagCommitSha: '', releaseExists: true }),
    /Release 已存在但 Tag 不存在/u,
  );
});
