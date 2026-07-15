'use strict';

// aih-collab skill installer: every interactive provider launch installs the
// built-in cross-provider collaboration skill (assets/provider-skills/
// aih-collab) into the account's provider config, so the running agent knows
// it can borrow vision / image-generation from other providers via the local
// aih gateway.
//
// Install shapes:
//   claude / codex  → symlink {config}/skills/aih-collab → repo asset dir
//                     (repo updates propagate to every account instantly;
//                     Windows falls back to a copied dir with a version stamp)
//   opencode / agy  → managed marker block appended to the CLI's global
//                     instruction file (no native skills mechanism)
//   gemini          → skipped (CLI discontinued)
//
// Escape hatch: AIH_SKILL_INJECT=0 uninstalls (unlink / strip block) instead.
// Best-effort throughout — a session launch must never fail because of this.

const nodeFs = require('fs');
const nodePath = require('path');

const SKILL_NAME = 'aih-collab';
const MANAGED_VERSION = 'v1';
const MANAGED_BEGIN_PATTERN = /<!-- aih-collab:v\d+:begin -->/;
const MANAGED_BEGIN = `<!-- aih-collab:${MANAGED_VERSION}:begin -->`;
const MANAGED_END = '<!-- aih-collab:end -->';
const COPY_STAMP_FILE = '.aih-managed';

function resolveSkillAssetDir(pathImpl = nodePath) {
  return pathImpl.resolve(__dirname, '..', '..', '..', '..', 'assets', 'provider-skills', SKILL_NAME);
}

function isSkillInjectDisabled(env = {}) {
  return String(env.AIH_SKILL_INJECT || '') === '0';
}

// Where a native skills directory install lands for this provider, or ''.
function getSkillLinkPath(ctx) {
  const pathImpl = ctx.path || nodePath;
  if (ctx.cliName === 'claude') {
    return pathImpl.join(ctx.sandboxDir, '.claude', 'skills', SKILL_NAME);
  }
  if (ctx.cliName === 'codex') {
    return pathImpl.join(ctx.codexConfigDir || pathImpl.join(ctx.sandboxDir, '.codex'), 'skills', SKILL_NAME);
  }
  return '';
}

// Where the managed instruction block lands for skills-less providers, or ''.
function getManagedInstructionPath(ctx) {
  const pathImpl = ctx.path || nodePath;
  if (ctx.cliName === 'opencode') {
    // OpenCode reads the global AGENTS.md from XDG config, which aih points at
    // the REAL host home (accounts share global config; only auth is scoped).
    return ctx.hostHomeDir ? pathImpl.join(ctx.hostHomeDir, '.config', 'opencode', 'AGENTS.md') : '';
  }
  if (ctx.cliName === 'agy') {
    // agy is home-redirected to the sandbox; the gemini-family global
    // instruction file lives under $HOME/.gemini/GEMINI.md.
    return pathImpl.join(ctx.sandboxDir, '.gemini', 'GEMINI.md');
  }
  return '';
}

function isManagedCopyDir(fsImpl, pathImpl, dirPath) {
  try {
    return fsImpl.existsSync(pathImpl.join(dirPath, COPY_STAMP_FILE));
  } catch (_error) {
    return false;
  }
}

function ensureSkillLink(linkPath, assetDir, deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  if (!fsImpl.existsSync(assetDir)) return 'asset_missing';
  fsImpl.mkdirSync(pathImpl.dirname(linkPath), { recursive: true });

  let stat = null;
  try { stat = fsImpl.lstatSync(linkPath); } catch (_error) {}
  if (stat) {
    if (stat.isSymbolicLink()) {
      try {
        if (pathImpl.resolve(fsImpl.readlinkSync(linkPath)) === pathImpl.resolve(assetDir)) return 'linked';
      } catch (_error) {}
      fsImpl.unlinkSync(linkPath);
    } else if (stat.isDirectory() && isManagedCopyDir(fsImpl, pathImpl, linkPath)) {
      fsImpl.rmSync(linkPath, { recursive: true, force: true });
    } else {
      // Not ours (user's own skill dir/file with the same name) — leave it be.
      return 'skipped_existing';
    }
  }

  try {
    fsImpl.symlinkSync(assetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return 'linked';
  } catch (_error) {
    // No symlink permission (typical on Windows): copy + stamp so future runs
    // recognise the dir as managed and can refresh it.
    try {
      fsImpl.cpSync(assetDir, linkPath, { recursive: true });
      fsImpl.writeFileSync(pathImpl.join(linkPath, COPY_STAMP_FILE), `${MANAGED_VERSION}\n`, 'utf8');
      return 'copied';
    } catch (_copyError) {
      return 'failed';
    }
  }
}

function removeSkillLink(linkPath, deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  let stat = null;
  try { stat = fsImpl.lstatSync(linkPath); } catch (_error) { return 'absent'; }
  if (stat.isSymbolicLink()) {
    fsImpl.unlinkSync(linkPath);
    return 'removed';
  }
  if (stat.isDirectory() && isManagedCopyDir(fsImpl, pathImpl, linkPath)) {
    fsImpl.rmSync(linkPath, { recursive: true, force: true });
    return 'removed';
  }
  return 'kept_foreign';
}

function buildManagedBlock(content) {
  return `${MANAGED_BEGIN}\n${String(content || '').trim()}\n${MANAGED_END}`;
}

function stripManagedBlock(text) {
  const begin = text.search(MANAGED_BEGIN_PATTERN);
  if (begin === -1) return { text, found: false };
  const endMarker = text.indexOf(MANAGED_END, begin);
  if (endMarker === -1) return { text, found: false };
  const before = text.slice(0, begin).replace(/\n+$/, '\n');
  const after = text.slice(endMarker + MANAGED_END.length).replace(/^\n+/, '\n');
  return { text: `${before}${after}`.replace(/^\n+/, ''), found: true };
}

function ensureManagedBlock(filePath, content, deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const block = buildManagedBlock(content);
  let current = '';
  try { current = String(fsImpl.readFileSync(filePath, 'utf8')); } catch (_error) {}
  if (current.includes(block)) return 'present';
  const stripped = stripManagedBlock(current).text;
  const joined = stripped.trim().length > 0 ? `${stripped.replace(/\n+$/, '')}\n\n${block}\n` : `${block}\n`;
  fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, joined, 'utf8');
  return 'written';
}

function removeManagedBlock(filePath, deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  let current = '';
  try { current = String(fsImpl.readFileSync(filePath, 'utf8')); } catch (_error) { return 'absent'; }
  const { text, found } = stripManagedBlock(current);
  if (!found) return 'absent';
  fsImpl.writeFileSync(filePath, text, 'utf8');
  return 'removed';
}

function readInstructionContent(pathImpl, fsImpl) {
  try {
    return String(fsImpl.readFileSync(pathImpl.join(resolveSkillAssetDir(pathImpl), 'instructions.md'), 'utf8'));
  } catch (_error) {
    return '';
  }
}

// Main entry — called from prepareProviderRuntime on every interactive launch.
function ensureProviderSkillInstalled(ctx, deps = {}) {
  const fsImpl = deps.fs || ctx.fs || nodeFs;
  const pathImpl = deps.path || ctx.path || nodePath;
  try {
    if (!ctx || !ctx.cliName || !ctx.sandboxDir) return { status: 'skipped', reason: 'no_context' };
    if (ctx.isLogin) return { status: 'skipped', reason: 'login_flow' };
    const disabled = isSkillInjectDisabled(deps.env || ctx.baseEnv || {});

    const linkPath = getSkillLinkPath(ctx);
    if (linkPath) {
      const result = disabled
        ? removeSkillLink(linkPath, { fs: fsImpl, path: pathImpl })
        : ensureSkillLink(linkPath, resolveSkillAssetDir(pathImpl), { fs: fsImpl, path: pathImpl });
      return { status: disabled ? 'uninstalled' : 'installed', mode: 'link', result, target: linkPath };
    }

    const instructionPath = getManagedInstructionPath(ctx);
    if (instructionPath) {
      const result = disabled
        ? removeManagedBlock(instructionPath, { fs: fsImpl })
        : ensureManagedBlock(instructionPath, readInstructionContent(pathImpl, fsImpl), { fs: fsImpl, path: pathImpl });
      return { status: disabled ? 'uninstalled' : 'installed', mode: 'managed-block', result, target: instructionPath };
    }

    return { status: 'skipped', reason: 'provider_unsupported' };
  } catch (error) {
    return { status: 'failed', reason: String((error && error.message) || error) };
  }
}

module.exports = {
  SKILL_NAME,
  MANAGED_BEGIN,
  MANAGED_END,
  buildManagedBlock,
  ensureManagedBlock,
  ensureProviderSkillInstalled,
  ensureSkillLink,
  getManagedInstructionPath,
  getSkillLinkPath,
  isSkillInjectDisabled,
  removeManagedBlock,
  removeSkillLink,
  resolveSkillAssetDir,
  stripManagedBlock
};
