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

const PRODUCTION_SOURCE_PREFIXES = ['bin/', 'lib/', 'scripts/'];
const LEGACY_AIH_PROFILE_STORAGE_RULES = [
  {
    name: 'legacy profile directory identifier',
    pattern: /\b(?:PROFILES_DIR|profilesDir)\b/
  },
  {
    name: 'legacy profile path construction',
    pattern: /\b(?:path|pathImpl)\.(?:join|resolve)\s*\([\s\S]{0,240}?['"`]profiles['"`][\s\S]{0,120}?\)/
  },
  {
    name: 'literal AIH profiles path',
    pattern: /(?:\.ai_home|\$AIH_HOME|\$\{AIH_HOME\})[\\/]profiles\b/
  }
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

// assets/provider-skills/ ships runtime skill content (SKILL.md is the skill
// format itself), not documentation — exempt like docs/.
function isProviderSkillAsset(relativePath) {
  return relativePath.startsWith('assets/provider-skills/');
}

// .ahr/ is agent-task scratch output, ignored going forward (user decision).
function isAhrTaskFile(relativePath) {
  return relativePath.startsWith('.ahr/');
}

test('repository policy keeps only root AGENTS and README markdown files (docs/ excepted)', () => {
  const markdownFiles = collectFiles(repoRoot, {
    include: (relativePath, fileName) => fileName.toLowerCase().endsWith('.md')
      && !isDocsMarkdown(relativePath)
      && !isProviderSkillAsset(relativePath)
      && !isAhrTaskFile(relativePath)
  });

  const unexpectedMarkdown = markdownFiles.filter((relativePath) => (
    !ALLOWED_MARKDOWN.has(relativePath)
  ));
  assert.deepEqual(unexpectedMarkdown, []);
});

test('repository policy rejects generated Codex/Electron root bundles', () => {
  const rootGeneratedBundles = fs.readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => GENERATED_ROOT_BUNDLE_PATTERNS.some((pattern) => pattern.test(fileName)))
    .sort();

  assert.deepEqual(rootGeneratedBundles, []);
});

test('repository policy rejects legacy AIH profiles storage access in production code', () => {
  const sourceFiles = collectFiles(repoRoot, {
    include: (relativePath, fileName) => PRODUCTION_SOURCE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
      && /\.(?:cjs|js|mjs|ts)$/.test(fileName)
  });
  const violations = [];

  sourceFiles.forEach((relativePath) => {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    LEGACY_AIH_PROFILE_STORAGE_RULES.forEach((rule) => {
      if (rule.pattern.test(source)) violations.push(`${relativePath}: ${rule.name}`);
    });
  });

  assert.deepEqual(violations, []);
});
