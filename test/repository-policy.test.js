const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.claude',
  '.aih',
  '.spec-workflow',
  'cli',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'third_party',
  'tmp',
  'logs'
]);

const ALLOWED_MARKDOWN = new Set([
  'AGENTS.md',
  'README.md',
  'web/DESIGN.md',
  'web/DESIGN_SYSTEM.md',
  'web/TODO_REFACTOR.md',
  'web/src/styles/DESIGN_SPECIFICATION.md',
  'web/src/styles/UI_WIREFRAMES_AND_MOCKUPS.md',
  'CLAUDE.md',
  'GEMINI.md'
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

// Documentation lives under docs/ (root markdown stays on the strict allowlist
// below). Engineering notes / root-cause writeups belong in docs/, not scattered
// across the tree, so docs/**/*.md is exempt from the root allowlist check.
function isDocsMarkdown(relativePath) {
  return relativePath.startsWith('docs/');
}

test('repository policy keeps only root AGENTS and README markdown files (docs/ excepted)', () => {
  const markdownFiles = collectFiles(repoRoot, {
    include: (relativePath, fileName) => fileName.toLowerCase().endsWith('.md')
      && !isDocsMarkdown(relativePath)
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
