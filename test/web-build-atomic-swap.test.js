'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { swapIntoPlace, verifyBuildOutput, STAGING_DIR } = require('../web/scripts/build-locked.cjs');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeBuild(dir, { scripts = ['umi.abc.js'], missing = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), scripts.map((s) => `<script src="/ui/${s}"></script>`).join(''));
  for (const s of scripts) if (!missing.includes(s)) fs.writeFileSync(path.join(dir, s), '//');
}

test('the build goes to a staging dir, never straight into dist', () => {
  assert.equal(STAGING_DIR, 'dist.next');
  const source = fs.readFileSync(require.resolve('../web/scripts/build-locked.cjs'), 'utf8');
  assert.match(source, /AIH_WEB_OUT_DIR: staging/);
  assert.match(fs.readFileSync(require.resolve('../web/config/config.ts'), 'utf8'), /outputPath: process\.env\.AIH_WEB_OUT_DIR \|\| "dist"/);
});

test('a complete build replaces dist and leaves no leftovers', async (t) => {
  const root = tmp(t);
  writeBuild(path.join(root, 'dist'), { scripts: ['umi.old.js'] });
  writeBuild(path.join(root, 'dist.next'), { scripts: ['umi.new.js'] });
  await verifyBuildOutput(path.join(root, 'dist.next'));
  await swapIntoPlace(path.join(root, 'dist.next'), path.join(root, 'dist'));
  assert.ok(fs.existsSync(path.join(root, 'dist', 'umi.new.js')));
  assert.ok(!fs.existsSync(path.join(root, 'dist', 'umi.old.js')));
  assert.ok(!fs.existsSync(path.join(root, 'dist.next')));
  assert.ok(!fs.existsSync(path.join(root, 'dist.prev')));
});

test('an incomplete build is rejected so the live dist stays intact', async (t) => {
  const root = tmp(t);
  await assert.rejects(verifyBuildOutput(path.join(root, 'missing')), /no index\.html/);
  writeBuild(path.join(root, 'half'), { scripts: ['umi.a.js', 'vendors.b.js'], missing: ['vendors.b.js'] });
  await assert.rejects(verifyBuildOutput(path.join(root, 'half')), /missing vendors\.b\.js/);
  fs.mkdirSync(path.join(root, 'empty')); fs.writeFileSync(path.join(root, 'empty', 'index.html'), '<html></html>');
  await assert.rejects(verifyBuildOutput(path.join(root, 'empty')), /references no scripts/);
});

test('first build (no previous dist) still swaps in', async (t) => {
  const root = tmp(t);
  writeBuild(path.join(root, 'dist.next'));
  await swapIntoPlace(path.join(root, 'dist.next'), path.join(root, 'dist'));
  assert.ok(fs.existsSync(path.join(root, 'dist', 'index.html')));
});
