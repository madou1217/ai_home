'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeReleaseFixture(workspaceRoot) {
  const version = '1.2.3';
  writeFile(path.join(workspaceRoot, 'package.json'), `${JSON.stringify({ version })}\n`);
  writeFile(path.join(workspaceRoot, 'web', 'package.json'), `${JSON.stringify({ version })}\n`);
  writeFile(
    path.join(workspaceRoot, 'src-tauri', 'tauri.conf.json'),
    `${JSON.stringify({ package: { productName: 'AI Home', version } })}\n`,
  );
  writeFile(
    path.join(workspaceRoot, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "ai-home"\nversion = "${version}"\n`,
  );
  const inputRoot = path.join(workspaceRoot, 'downloaded-artifacts');
  for (const fileName of [
    `AI Home_${version}_aarch64.dmg`,
    `AI Home_${version}_x64_en-US.msi`,
    `ai-home_${version}_amd64.deb`,
    `ai-home_${version}_amd64.AppImage`,
  ]) {
    writeFile(path.join(inputRoot, fileName), `fixture:${fileName}`);
  }
  return {
    inputRoot,
    outputRoot: path.join(workspaceRoot, 'release-assets'),
  };
}

test('prepare-release-assets CLI writes the guarded installer manifest', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-release-cli-'));
  try {
    const fixture = writeReleaseFixture(workspaceRoot);
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'scripts', 'desktop', 'prepare-release-assets.js'),
      '--workspace-root', workspaceRoot,
      '--input', fixture.inputRoot,
      '--output', fixture.outputRoot,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(fixture.outputRoot, 'release-manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.tag, 'v1.2.3');
    assert.equal(manifest.assets.length, 4);
    assert.equal(manifest.distributionSigning, 'unsigned');
  } finally {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test('resolve-release-action CLI updates only the same commit tag', () => {
  const script = path.resolve(__dirname, '..', 'scripts', 'desktop', 'resolve-release-action.js');
  const currentSha = 'a'.repeat(40);
  const update = spawnSync(process.execPath, [
    script,
    '--current-sha', currentSha,
    '--tag-sha', currentSha,
    '--release-exists', 'true',
  ], { encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr);
  assert.equal(update.stdout.trim(), 'update');

  const conflict = spawnSync(process.execPath, [
    script,
    '--current-sha', currentSha,
    '--tag-sha', 'b'.repeat(40),
    '--release-exists', 'true',
  ], { encoding: 'utf8' });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /已指向不同提交/u);
});
