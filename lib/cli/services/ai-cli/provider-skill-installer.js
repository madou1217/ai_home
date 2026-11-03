'use strict';

// Compatibility entry for launch preparation. The manager owns all state and
// projections; explicit disable/removal survives subsequent interactive launches.
const path = require('node:path');
const { readCliFeature } = require('../../config/cli-features');
const { createSkillManager } = require('../../../native-resources/skill-manager');
const SKILL_NAME = 'aih-collab';
function resolveSkillAssetDir(pathImpl = path) {
  return pathImpl.resolve(__dirname, '..', '..', '..', '..', 'assets', 'provider-skills', SKILL_NAME);
}
function isSkillInjectDisabled(env = {}) {
  return String(readCliFeature(env, 'skillInject')) === '0';
}
function ensureProviderSkillInstalled(ctx, deps = {}) {
  if (!ctx?.cliName || !ctx.sandboxDir || !ctx.aiHomeDir || !ctx.hostHomeDir) return { status: 'skipped', reason: 'no_context' };
  if (ctx.isLogin) return { status: 'skipped', reason: 'login_flow' };
  try {
    const manager = createSkillManager({ aiHomeDir: ctx.aiHomeDir, hostHomeDir: ctx.hostHomeDir });
    const source = resolveSkillAssetDir();
    const selection = { provider: ctx.cliName, legacySource: source };
    let record = manager.reconcileBuiltin(source, selection);
    if (isSkillInjectDisabled(deps.env || ctx.baseEnv) && !record.removed) {
      record = manager.disable(SKILL_NAME, selection);
    }
    return { status: record.enabled ? 'installed' : 'uninstalled', mode: record.mode, target: record.target, enabled: record.enabled };
  } catch (error) {
    return { status: error.code === 'skill_provider_unsupported' ? 'skipped' : 'failed', reason: error.code || 'skill_install_failed' };
  }
}
module.exports = { SKILL_NAME, resolveSkillAssetDir, isSkillInjectDisabled, ensureProviderSkillInstalled };
