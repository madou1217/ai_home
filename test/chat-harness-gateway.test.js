'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensurePrivateModelCatalogDir
} = require('../lib/server/chat-runtime/chat-harness-gateway');

function makeCatalogDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-harness-'));
  return {
    root,
    catalogDir: path.join(root, 'model-catalogs')
  };
}

test('replaces a dangling model-catalogs symlink with a real directory', () => {
  const { root, catalogDir } = makeCatalogDir();
  try {
    fs.symlinkSync(path.join(root, 'missing-target'), catalogDir, 'dir');

    ensurePrivateModelCatalogDir(fs, catalogDir);

    const stat = fs.lstatSync(catalogDir);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replaces a valid model-catalogs symlink instead of sharing its target', () => {
  const { root, catalogDir } = makeCatalogDir();
  const target = path.join(root, 'shared-target');
  try {
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, catalogDir, 'dir');

    ensurePrivateModelCatalogDir(fs, catalogDir);

    const catalogStat = fs.lstatSync(catalogDir);
    assert.equal(catalogStat.isDirectory(), true);
    assert.equal(catalogStat.isSymbolicLink(), false);
    assert.equal(fs.lstatSync(target).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps an existing real model-catalogs directory', () => {
  const { root, catalogDir } = makeCatalogDir();
  try {
    fs.mkdirSync(catalogDir, { mode: 0o700 });
    const before = fs.lstatSync(catalogDir);

    ensurePrivateModelCatalogDir(fs, catalogDir);

    const after = fs.lstatSync(catalogDir);
    assert.equal(after.isDirectory(), true);
    assert.equal(after.isSymbolicLink(), false);
    assert.equal(after.ino, before.ino);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a regular file at model-catalogs with a ChatRuntimeError', () => {
  const { root, catalogDir } = makeCatalogDir();
  try {
    fs.writeFileSync(catalogDir, 'occupied');

    assert.throws(
      () => ensurePrivateModelCatalogDir(fs, catalogDir),
      (error) => {
        assert.equal(error.name, 'ChatRuntimeError');
        assert.equal(error.code, 'chat_harness_model_catalog_path_conflict');
        assert.equal(error.statusCode, 409);
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
