'use strict';

const { isCodebuddyFamilyProvider } = require('../sessions/session-reader-codebuddy');
const { refreshAccountTokenUsage } = require('../usage/model-usage-refresh');
const { updateCachedAccountTokenUsage } = require('./webui-account-live');

async function refreshCodebuddySessionUsage(ctx, run) {
  const service = ctx.deps && ctx.deps.modelUsageService;
  if (!isCodebuddyFamilyProvider(run.provider) || !service
    || typeof service.scanCodebuddySessionUsage !== 'function') return null;
  try {
    const result = await service.scanCodebuddySessionUsage(run.provider, run.sessionId, {
      provider: run.provider, accountRef: run.accountRef,
      startedAtMs: run.startedAt, completedAtMs: Date.now()
    });
    const queriedAt = Date.now();
    await refreshAccountTokenUsage(service, (usage, cacheOptions) => updateCachedAccountTokenUsage({
      state: ctx.state, fs: ctx.fs || ctx.deps.fs, aiHomeDir: ctx.aiHomeDir || ctx.deps.aiHomeDir
    }, usage, cacheOptions), { provider: run.provider, nowMs: queriedAt, generatedAt: queriedAt });
    return result;
  } catch (error) {
    const warn = ctx.deps && ctx.deps.logWarn || console.warn;
    warn(`CodeBuddy usage refresh failed: ${String(error.message || error)}`);
    return null;
  }
}

module.exports = { refreshCodebuddySessionUsage };
