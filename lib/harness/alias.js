'use strict';

const {
  getModelAliasDbPath,
  loadAliasesSync,
  resolveAliasCandidates
} = require('../server/model-alias-store');

// 跨 Provider 的请求带 x-account-ref 钉选头；网关对该类请求不做 alias 改写
// （否则一个别名可能把请求带到另一个账号）。因此 alias 必须在启动器里先解析成
// 身份账号能路由的真实模型名，解析不了的明确失败，绝不把 alias 发给上游。
function resolveHarnessLaunchModel(input = {}) {
  const requested = String(input.model || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!requested || !provider) {
    return { ok: true, requested, model: requested, alias: null };
  }
  let aliases = [];
  let canRead = true;
  try {
    // 探针 fs 可能只是内存实现（没有 SQLite 所需的 realpath/lstat）。仓库里
    // 的启动器测试就用这种 fs，别名读取失败不应让「不是别名」的模型无法启动。
    const dbPath = getModelAliasDbPath(String(input.aiHomeDir || '').trim());
    if (!dbPath || !input.fs || typeof input.fs.existsSync !== 'function' || !input.fs.existsSync(dbPath)) {
      canRead = false;
    }
  } catch (_error) {
    canRead = false;
  }
  if (!canRead) {
    return { ok: true, requested, model: requested, alias: null };
  }
  try {
    const loaded = loadAliasesSync(input.fs, input.aiHomeDir, input.deps || {});
    aliases = Array.isArray(loaded && loaded.aliases) ? loaded.aliases : [];
  } catch (error) {
    return {
      ok: false,
      requested,
      model: '',
      alias: null,
      error: 'model_alias_lookup_failed',
      message: String(error && error.message || error || 'alias lookup failed')
    };
  }
  const candidates = resolveAliasCandidates(aliases, requested, provider);
  if (!candidates.length) {
    return { ok: true, requested, model: requested, alias: null };
  }
  const candidate = candidates[0];
  const targetProvider = String(candidate.targetProvider || 'auto').trim().toLowerCase();
  if (targetProvider && targetProvider !== 'auto' && targetProvider !== provider) {
    return {
      ok: false,
      requested,
      model: '',
      alias: candidate,
      error: 'model_alias_target_provider_mismatch',
      message: `alias ${candidate.alias} targets ${targetProvider}, but the pinned account is ${provider}`
    };
  }
  const target = String(candidate.target || '').trim();
  if (!target) {
    return { ok: true, requested, model: requested, alias: null };
  }
  return { ok: true, requested, model: target, alias: candidate };
}

function rewriteModelFlagInArgs(args, resolveModel) {
  const source = Array.isArray(args) ? args : [];
  const next = source.slice();
  for (let index = 0; index < next.length; index += 1) {
    const token = String(next[index] || '');
    if (token === '--') break;
    if (token === '--model') {
      if (index + 1 < next.length) next[index + 1] = resolveModel(next[index + 1]);
      continue;
    }
    if (token.startsWith('--model=')) {
      const value = token.slice('--model='.length);
      next[index] = `--model=${resolveModel(value)}`;
    }
  }
  return next;
}

module.exports = {
  resolveHarnessLaunchModel,
  rewriteModelFlagInArgs
};
