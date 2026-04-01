const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseExportNonInteractiveArgs,
  buildExportExecutionPlan
} = require('../lib/migration/exporter');
const {
  parseImportNonInteractiveArgs,
  restoreProfilesWithConflictPolicy
} = require('../lib/migration/importer');

function createAccount(rootDir, tool, id, markerText) {
  const profileDir = path.join(rootDir, 'profiles', tool, String(id));
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'marker.txt'), markerText);
}

function createFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-migration-'));
  const srcProfiles = path.join(tempRoot, 'src', 'profiles');
  const dstProfiles = path.join(tempRoot, 'dst', 'profiles');
  fs.mkdirSync(srcProfiles, { recursive: true });
  fs.mkdirSync(dstProfiles, { recursive: true });

  createAccount(path.join(tempRoot, 'src'), 'codex', 1, 'src-codex-1');
  createAccount(path.join(tempRoot, 'src'), 'codex', 2, 'src-codex-2');
  createAccount(path.join(tempRoot, 'src'), 'gemini', 1, 'src-gemini-1');
  createAccount(path.join(tempRoot, 'dst'), 'codex', 1, 'dst-codex-1');

  return {
    tempRoot,
    srcProfiles,
    dstProfiles
  };
}

test('parseExportNonInteractiveArgs supports selectors, output, and conflict policy', () => {
  const parsed = parseExportNonInteractiveArgs(
    ['--non-interactive', '--output', 'backup', 'codex:1,2', '--selector', 'gemini', '--conflict', 'overwrite'],
    { knownTools: ['codex', 'gemini'] }
  );

  assert.equal(parsed.nonInteractive, true);
  assert.equal(parsed.targetFile, 'backup.aes');
  assert.deepEqual(parsed.selectors, ['codex:1,2', 'gemini']);
  assert.equal(parsed.conflictPolicy, 'overwrite');
});

test('buildExportExecutionPlan respects report strategy when output file exists', () => {
  const plan = buildExportExecutionPlan({
    targetFile: 'backup.aes',
    selectors: ['codex:2', 'codex:1'],
    conflictPolicy: 'report',
    resolveSelectors: (selectors) => selectors.slice().sort(),
    fileExists: () => true
  });

  assert.equal(plan.outputExists, true);
  assert.equal(plan.outputAction, 'reported');
  assert.equal(plan.shouldWrite, false);
  assert.deepEqual(plan.selectedTargets, ['codex:1', 'codex:2']);
});

test('parseImportNonInteractiveArgs supports both overwrite switch and conflict option', () => {
  const overwriteMode = parseImportNonInteractiveArgs(['-o', 'backup.aes']);
  assert.equal(overwriteMode.targetFile, 'backup.aes');
  assert.equal(overwriteMode.conflictPolicy, 'overwrite');

  const reportMode = parseImportNonInteractiveArgs(['--non-interactive', '--file', 'backup.aes', '--conflict', 'report']);
  assert.equal(reportMode.nonInteractive, true);
  assert.equal(reportMode.conflictPolicy, 'report');
});

test('restoreProfilesWithConflictPolicy skip keeps destination account and imports non-conflicts', () => {
  const fixture = createFixture();
  try {
    const summary = restoreProfilesWithConflictPolicy({
      srcProfilesDir: fixture.srcProfiles,
      dstProfilesDir: fixture.dstProfiles,
      conflictPolicy: 'skip'
    });

    assert.equal(summary.totalAccounts, 3);
    assert.equal(summary.imported, 2);
    assert.equal(summary.overwritten, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.conflicts, 1);
    const existingContent = fs.readFileSync(path.join(fixture.dstProfiles, 'codex', '1', 'marker.txt'), 'utf8');
    assert.equal(existingContent, 'dst-codex-1');
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('restoreProfilesWithConflictPolicy overwrite replaces destination account', () => {
  const fixture = createFixture();
  try {
    const summary = restoreProfilesWithConflictPolicy({
      srcProfilesDir: fixture.srcProfiles,
      dstProfilesDir: fixture.dstProfiles,
      conflictPolicy: 'overwrite'
    });

    assert.equal(summary.totalAccounts, 3);
    assert.equal(summary.imported, 2);
    assert.equal(summary.overwritten, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.reported, 0);
    const replacedContent = fs.readFileSync(path.join(fixture.dstProfiles, 'codex', '1', 'marker.txt'), 'utf8');
    assert.equal(replacedContent, 'src-codex-1');
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('restoreProfilesWithConflictPolicy report does not mutate conflicted account', () => {
  const fixture = createFixture();
  try {
    const summary = restoreProfilesWithConflictPolicy({
      srcProfilesDir: fixture.srcProfiles,
      dstProfilesDir: fixture.dstProfiles,
      conflictPolicy: 'report'
    });

    assert.equal(summary.totalAccounts, 3);
    assert.equal(summary.imported, 2);
    assert.equal(summary.overwritten, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.reported, 1);
    assert.equal(summary.conflicts, 1);
    const untouchedContent = fs.readFileSync(path.join(fixture.dstProfiles, 'codex', '1', 'marker.txt'), 'utf8');
    assert.equal(untouchedContent, 'dst-codex-1');
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});
