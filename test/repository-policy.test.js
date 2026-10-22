const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.claude',
  '.aih',
  '.omo',
  '.spec-workflow',
  'cli',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'third_party',
  'tmp',
  'logs',
  // output/ is the gitignored scratch dir for agent deliverables and Playwright
  // evidence (`.gitignore:53`; the docs call these files 运行产物，不提交). Nothing
  // under it can ever be committed, so the root-markdown allowlist must not police
  // it — same rationale as the .ahr/ and .workbuddy/ exemptions below.
  'output'
]);

const ALLOWED_MARKDOWN = new Set([
  'AGENTS.md',
  'README.md',
  'web/DESIGN.md',
  'web/DESIGN_SYSTEM.md',
  // Tolerance entry: web/TODO_REFACTOR.md is an untracked, machine-local file that
  // may still exist in other checkouts. The file was removed from this working copy.
  'web/TODO_REFACTOR.md',
  'CLAUDE.md'
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
    // 锚定**第一个参数是 aih 数据根**，而不是靠「240 字符窗口内出现 profiles」：
    // 后者会误伤任何 `<某个自有目录>/profiles/<名字>` 布局。实例（2026-10-22）：
    // lib/harness/dsh.js 的 `pathImpl.join(dshHome, 'profiles', PROFILE_NAME)` 里的 dshHome
    // 是 harness 投影根（`<aiHomeDir>/run/harness/<id>/<ref>`，见 lib/harness/projection.js），
    // 与 aih 的旧 profile 存储无关，却被旧规则判成违规。
    //
    // 旧 profile 存储的真实形态是 `path.join(aiHomeDir, 'profiles', …)`——第一个参数就是
    // aih 数据根本身（对照 lib/cli/services/account/codex-rekey-storage.js 的
    // `path.join(aiHomeDir, root)`）。因此这里要求「第一参数像 aih 数据根」：
    // aiHomeDir / aiHome / AIH_HOME_DIR / AIH_HOME。
    name: 'legacy profile path construction',
    pattern: /\b(?:path|pathImpl)\.(?:join|resolve)\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?(?:aiHomeDir|aiHome|AIH_HOME_DIR|AIH_HOME)\b[^)]{0,120}?['"`]profiles['"`]/
  },
  {
    name: 'literal AIH profiles path',
    pattern: /(?:\.ai_home|\$AIH_HOME_DIR|\$\{AIH_HOME_DIR\})[\\/]profiles\b/
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

// .agents/ is the task orchestrator's scratch output (task.json + review.md).
// Its Markdown is already gitignored via `*.md`; like .ahr/ it is not repository
// documentation, so the root-markdown allowlist does not apply.
function isAgentTaskFile(relativePath) {
  return relativePath.startsWith('.agents/');
}

// .workbuddy/ and .workbuddy-ai/ are the agent tooling's own working state (memory
// notes, automations, skills) and are gitignored via `*.md`. They are not repository
// documentation, so the root-markdown allowlist does not apply — same rationale as
// .ahr/ above. Without this exemption every agent session that writes a memory note
// turns this test red. The two names are the domestic/global site data roots of the
// same product (see docs/architecture/codebuddy-family-credential-model.md §13).
function isWorkBuddyAgentData(relativePath) {
  return relativePath.startsWith('.workbuddy/') || relativePath.startsWith('.workbuddy-ai/');
}

test('repository policy keeps only root AGENTS and README markdown files (docs/ excepted)', () => {
  const markdownFiles = collectFiles(repoRoot, {
    include: (relativePath, fileName) => fileName.toLowerCase().endsWith('.md')
      && !isDocsMarkdown(relativePath)
      && !isProviderSkillAsset(relativePath)
      && !isAhrTaskFile(relativePath)
      && !isAgentTaskFile(relativePath)
      && !isWorkBuddyAgentData(relativePath)
  });

  const unexpectedMarkdown = markdownFiles.filter((relativePath) => (
    !ALLOWED_MARKDOWN.has(relativePath)
  ));
  assert.deepEqual(unexpectedMarkdown, []);
});

// IGNORED_DIR_NAMES 里的 scratch 目录豁免只有在「这些目录确实被 gitignore」时才成立：
// 一旦某条 gitignore 规则被删掉，豁免就会掩盖一个其实可以被提交的文件。
test('repository policy scratch-dir exemptions stay gitignored', () => {
  const gitignoreEntries = new Set(fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')));

  for (const dirName of ['output']) {
    assert.equal(
      gitignoreEntries.has(`${dirName}/`),
      true,
      `${dirName}/ 必须在 .gitignore 中，否则不能列入 IGNORED_DIR_NAMES`,
    );
  }
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
