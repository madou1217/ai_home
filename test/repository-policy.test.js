const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.aih',
  '.spec-workflow',
  'cli',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tmp',
  'logs'
]);

const ALLOWED_MARKDOWN = new Set([
  'AGENTS.md',
  'README.md'
]);

const GENERATED_ROOT_BUNDLE_PATTERNS = [
  /^app-session-[A-Za-z0-9_-]+\.js(?:\.map)?$/,
  /^main-[A-Za-z0-9_-]+\.js(?:\.map)?$/,
  /^workspace-root-drop-handler-[A-Za-z0-9_-]+\.js(?:\.map)?$/
];

function collectFiles(rootDir, options = {}) {
  const files = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        walk(absolutePath);
        continue;
      }

      if (entry.isFile() && options.include(relativePath, entry.name)) {
        files.push(relativePath);
      }
    }
  }

  walk(rootDir);
  return files.sort();
}

test('repository policy keeps only root AGENTS and README markdown files', () => {
  const markdownFiles = collectFiles(repoRoot, {
    include: (_relativePath, fileName) => fileName.toLowerCase().endsWith('.md')
  });

  assert.deepEqual(markdownFiles, Array.from(ALLOWED_MARKDOWN).sort());
});

test('repository policy rejects generated Codex/Electron root bundles', () => {
  const rootGeneratedBundles = fs.readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => GENERATED_ROOT_BUNDLE_PATTERNS.some((pattern) => pattern.test(fileName)))
    .sort();

  assert.deepEqual(rootGeneratedBundles, []);
});
