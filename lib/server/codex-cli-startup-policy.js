'use strict';

const crypto = require('node:crypto');
const nodePath = require('node:path');
const {
  buildCodexStartupWarningArgs,
  injectCodexProviderArgs
} = require('../cli/services/ai-cli/codex-provider-args');
const {
  projectCodexModelCatalog
} = require('./codex-model-metadata-projection');

function readRootTomlString(configText, key) {
  const escapedKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`^${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*$`);
  for (const line of String(configText || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const match = trimmed.match(keyPattern);
    if (match) return String(match[1] || '').trim();
  }
  return '';
}

function resolveCodexHome(env = {}, options = {}) {
  const pathImpl = options.path || nodePath;
  const explicit = String(env.CODEX_HOME || '').trim();
  if (explicit) return explicit;
  const homeDir = String(env.HOME || env.USERPROFILE || '').trim();
  return homeDir ? pathImpl.join(homeDir, '.codex') : '';
}

function resolveModelArg(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '').trim();
    if (token === '-m' || token === '--model') {
      return String(args[index + 1] || '').trim();
    }
    if (token.startsWith('--model=')) {
      return token.slice('--model='.length).trim();
    }
  }
  return '';
}

function readCodexStartupContext(fs, env, args, options = {}) {
  const pathImpl = options.path || nodePath;
  const codexHome = resolveCodexHome(env, { path: pathImpl });
  if (!codexHome) return null;
  try {
    const configText = fs.readFileSync(pathImpl.join(codexHome, 'config.toml'), 'utf8');
    let catalog = null;
    try {
      catalog = JSON.parse(fs.readFileSync(pathImpl.join(codexHome, 'models_cache.json'), 'utf8'));
    } catch (_error) {}
    return {
      codexHome,
      modelId: resolveModelArg(args) || readRootTomlString(configText, 'model'),
      serviceTier: readRootTomlString(configText, 'service_tier'),
      models: Array.isArray(catalog && catalog.models) ? catalog.models : []
    };
  } catch (_error) {
    return null;
  }
}

function normalizeServiceTier(value) {
  const tier = String(value || '').trim().toLowerCase();
  return tier === 'fast' ? 'priority' : tier;
}

function modelSupportsServiceTier(model, serviceTier) {
  const requested = normalizeServiceTier(serviceTier);
  if (!requested || requested === 'default') return true;
  return Array.isArray(model && model.service_tiers)
    && model.service_tiers.some((tier) => String(tier && tier.id || '').trim() === requested);
}

function buildUnsupportedServiceTierArgs(context) {
  if (!context || !context.modelId || !context.serviceTier) return [];
  if (normalizeServiceTier(context.serviceTier) === 'default') return [];
  const model = context.models.find((item) => String(item && item.slug || '').trim() === context.modelId);
  return modelSupportsServiceTier(model, context.serviceTier)
    ? []
    : ['-c', 'service_tier="default"'];
}

function escapeTomlString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function readFileIfPresent(fs, filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function writeModelCatalogAtomically(fs, catalogDir, content, options = {}) {
  const pathImpl = options.path || nodePath;
  const fileId = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const catalogPath = pathImpl.join(catalogDir, `${fileId}.json`);
  if (readFileIfPresent(fs, catalogPath) === content) return catalogPath;

  const processObj = options.processObj || process;
  const nonce = crypto.randomBytes(6).toString('hex');
  const tempPath = `${catalogPath}.${Number(processObj.pid) || process.pid}-${nonce}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  try {
    fs.renameSync(tempPath, catalogPath);
  } catch (error) {
    // Native Windows does not replace an existing destination during rename.
    // A concurrent writer that won the race is safe when the content matches.
    if (readFileIfPresent(fs, catalogPath) !== content) throw error;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_error) {}
  }
  return catalogPath;
}

function buildModelCatalogProjectionArgs(fs, context, options = {}) {
  if (!context || !context.modelId || context.models.length < 1) return [];
  if (context.models.some((item) => String(item && item.slug || '').trim() === context.modelId)) {
    return [];
  }
  const modelIds = context.models
    .map((model) => String(model && model.slug || '').trim())
    .filter(Boolean);
  const projectedModels = projectCodexModelCatalog(
    [...modelIds, context.modelId],
    context.models
  );
  if (!projectedModels.some((model) => model.slug === context.modelId)) return [];

  const pathImpl = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return [];
  const catalogDir = pathImpl.join(aiHomeDir, 'run', 'codex', 'model-catalogs');
  const projected = {
    models: projectedModels
  };
  const content = `${JSON.stringify(projected)}\n`;
  fs.mkdirSync(catalogDir, { recursive: true });
  const catalogPath = writeModelCatalogAtomically(fs, catalogDir, content, {
    ...options,
    path: pathImpl
  });
  return ['-c', `model_catalog_json="${escapeTomlString(catalogPath)}"`];
}

function buildCodexDefaultCliArgs(fs, env, args, authMode, options = {}) {
  const policyArgs = buildCodexStartupWarningArgs();
  if (authMode === 'apikey') {
    const context = readCodexStartupContext(fs, env, args, options);
    policyArgs.push(...buildUnsupportedServiceTierArgs(context));
    policyArgs.push(...buildModelCatalogProjectionArgs(fs, context, options));
  }
  return injectCodexProviderArgs(args, policyArgs);
}

module.exports = {
  buildCodexDefaultCliArgs,
  buildModelCatalogProjectionArgs,
  buildUnsupportedServiceTierArgs,
  readCodexStartupContext,
  writeModelCatalogAtomically
};
