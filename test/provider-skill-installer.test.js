const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SKILL_NAME,
  ensureManagedBlock,
  ensureProviderSkillInstalled,
  ensureSkillLink,
  getManagedInstructionPath,
  getSkillLinkPath,
  removeManagedBlock,
  removeSkillLink,
  resolveSkillAssetDir,
  stripManagedBlock
} = require('../lib/cli/services/ai-cli/provider-skill-installer');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-skill-'));
}

function ctxFor(cliName, sandboxDir, extra = {}) {
  return {
    cliName,
    sandboxDir,
    codexConfigDir: path.join(sandboxDir, '.codex'),
    hostHomeDir: extra.hostHomeDir || path.join(sandboxDir, 'host-home'),
    path,
    fs,
    baseEnv: extra.baseEnv || {},
    isLogin: Boolean(extra.isLogin)
  };
}

test('skill asset dir exists in repo and contains SKILL.md + instructions.md', () => {
  const assetDir = resolveSkillAssetDir(path);
  assert.equal(fs.existsSync(path.join(assetDir, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(assetDir, 'instructions.md')), true);
});

test('link paths per provider: claude/codex link, opencode/agy managed, gemini skipped', () => {
  const sandbox = tmpdir();
  const claude = ctxFor('claude', sandbox);
  const codex = ctxFor('codex', sandbox);
  const opencode = ctxFor('opencode', sandbox);
  const agy = ctxFor('agy', sandbox);
  const gemini = ctxFor('gemini', sandbox);
  assert.equal(getSkillLinkPath(claude), path.join(sandbox, '.claude', 'skills', SKILL_NAME));
  assert.equal(getSkillLinkPath(codex), path.join(sandbox, '.codex', 'skills', SKILL_NAME));
  assert.equal(getSkillLinkPath(opencode), '');
  assert.equal(getManagedInstructionPath(opencode), path.join(opencode.hostHomeDir, '.config', 'opencode', 'AGENTS.md'));
  assert.equal(getManagedInstructionPath(agy), path.join(sandbox, '.gemini', 'GEMINI.md'));
  assert.equal(getSkillLinkPath(gemini), '');
  assert.equal(getManagedInstructionPath(gemini), '');
});

test('ensureSkillLink creates symlink to asset dir and is idempotent', () => {
  const sandbox = tmpdir();
  const linkPath = path.join(sandbox, '.claude', 'skills', SKILL_NAME);
  const assetDir = resolveSkillAssetDir(path);
  assert.equal(ensureSkillLink(linkPath, assetDir), 'linked');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(path.resolve(fs.readlinkSync(linkPath)), path.resolve(assetDir));
  assert.equal(ensureSkillLink(linkPath, assetDir), 'linked');
  assert.equal(fs.existsSync(path.join(linkPath, 'SKILL.md')), true);
});

test('ensureSkillLink never clobbers a foreign dir; removeSkillLink unlinks ours only', () => {
  const sandbox = tmpdir();
  const linkPath = path.join(sandbox, '.codex', 'skills', SKILL_NAME);
  fs.mkdirSync(linkPath, { recursive: true });
  fs.writeFileSync(path.join(linkPath, 'SKILL.md'), 'user own skill', 'utf8');
  assert.equal(ensureSkillLink(linkPath, resolveSkillAssetDir(path)), 'skipped_existing');
  assert.equal(removeSkillLink(linkPath), 'kept_foreign');
  assert.equal(fs.readFileSync(path.join(linkPath, 'SKILL.md'), 'utf8'), 'user own skill');
});

test('managed block: append, idempotent, version-replace, strip preserves user text', () => {
  const dir = tmpdir();
  const filePath = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(filePath, '# my rules\n\nbe nice\n', 'utf8');

  assert.equal(ensureManagedBlock(filePath, 'collab body v1'), 'written');
  assert.equal(ensureManagedBlock(filePath, 'collab body v1'), 'present');
  let text = fs.readFileSync(filePath, 'utf8');
  assert.match(text, /# my rules/);
  assert.match(text, /collab body v1/);

  // 内容变更（如版本升级）→ 原块被替换，不重复追加
  assert.equal(ensureManagedBlock(filePath, 'collab body v2'), 'written');
  text = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(text, /collab body v1/);
  assert.match(text, /collab body v2/);
  assert.equal((text.match(/aih-collab:v\d+:begin/g) || []).length, 1);

  assert.equal(removeManagedBlock(filePath), 'removed');
  text = fs.readFileSync(filePath, 'utf8');
  assert.match(text, /# my rules/);
  assert.doesNotMatch(text, /aih-collab/);
});

test('stripManagedBlock is a no-op without markers', () => {
  const { text, found } = stripManagedBlock('plain text');
  assert.equal(found, false);
  assert.equal(text, 'plain text');
});

test('ensureProviderSkillInstalled: claude installs link, opencode writes block, login skips', () => {
  const sandbox = tmpdir();
  const claudeResult = ensureProviderSkillInstalled(ctxFor('claude', sandbox));
  assert.equal(claudeResult.status, 'installed');
  assert.equal(claudeResult.mode, 'link');
  assert.equal(fs.existsSync(path.join(sandbox, '.claude', 'skills', SKILL_NAME, 'SKILL.md')), true);

  const opencodeCtx = ctxFor('opencode', sandbox);
  const opencodeResult = ensureProviderSkillInstalled(opencodeCtx);
  assert.equal(opencodeResult.mode, 'managed-block');
  const agents = fs.readFileSync(path.join(opencodeCtx.hostHomeDir, '.config', 'opencode', 'AGENTS.md'), 'utf8');
  assert.match(agents, /aih-collab/);
  assert.match(agents, /AIH_GATEWAY_BASE_URL/);

  const loginResult = ensureProviderSkillInstalled(ctxFor('codex', sandbox, { isLogin: true }));
  assert.equal(loginResult.status, 'skipped');
});

test('AIH_SKILL_INJECT=0 uninstalls both shapes', () => {
  const sandbox = tmpdir();
  ensureProviderSkillInstalled(ctxFor('claude', sandbox));
  const opencodeCtx = ctxFor('opencode', sandbox);
  ensureProviderSkillInstalled(opencodeCtx);

  const off = { baseEnv: { AIH_SKILL_INJECT: '0' } };
  const claudeOff = ensureProviderSkillInstalled(ctxFor('claude', sandbox, off));
  assert.equal(claudeOff.status, 'uninstalled');
  assert.equal(fs.existsSync(path.join(sandbox, '.claude', 'skills', SKILL_NAME)), false);

  const opencodeOff = ensureProviderSkillInstalled(ctxFor('opencode', sandbox, off));
  assert.equal(opencodeOff.status, 'uninstalled');
  const agents = fs.readFileSync(path.join(opencodeCtx.hostHomeDir, '.config', 'opencode', 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /aih-collab/);
});
