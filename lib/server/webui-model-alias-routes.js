'use strict';
const {
  generateAliasId,
  loadAliases,
  normalizeAliasRecord,
  saveAliases
} = require('./model-alias-store');
const {
  buildModelCapabilityIndex,
  listProviderModelIds,
  modelHasCatalogProvider
} = require('./model-capability-index');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  validateAliasRecordForSave
} = require('./model-alias-validation');
const {
  getWebUiModelsCache
} = require('./webui-model-cache');
const { notifyGoCoreProjection } = require('./go-core-projection-sync');
const { compareAliasSets } = require('./model-alias-shadow');
const { aliasRoutesGoOwned, handleAliasRouteViaGo } = require('./alias-go-owner');

async function readAliasState(state, fs, aiHomeDir) {
  const data = await loadAliases(fs, aiHomeDir);
  state.modelAliases = data;
  return data;
}

/**
 * 保存别名表并立刻把新表推给 Go。
 *
 * 别名只由 Node 定义（含插件代次别名），Go 侧没有别名就无法解析请求，所以「保存后等
 * 兜底定时器」这段时间里，新别名在 Go 上是完全未知的（会被判成不可路由而交还 Node）。
 */
async function writeAliasState(ctx, state, fs, aiHomeDir, data) {
  const saved = await saveAliases(fs, aiHomeDir, data);
  state.modelAliases = saved;
  notifyGoCoreProjection(ctx, 'modelAliases');
  return saved;
}

function writeAliasValidationError(writeJson, res, validation) {
  writeJson(res, 400, {
    ok: false,
    error: validation && validation.error || 'invalid_model_alias',
    detail: validation && validation.detail || 'invalid model alias',
    model: validation && validation.model || undefined,
    providers: validation && validation.providers || undefined,
    diagnostics: validation && validation.diagnostics || undefined
  });
}

async function createAliasValidationContext(ctx, aliases) {
  const { state, options, deps } = ctx;
  await getWebUiModelsCache(state, options || {}, {
    fs: ctx.fs || deps && deps.fs,
    aiHomeDir: ctx.aiHomeDir || deps && deps.aiHomeDir,
    fetchModelsForAccount: deps && deps.fetchModelsForAccount,
    accountStateService: deps && deps.accountStateService
  }).catch(() => null);
  return {
    aliases,
    state,
    options: options || {},
    modelCapabilityIndex: buildModelCapabilityIndex(state, options || {})
  };
}

/**
 * 别名接口的 4xx/5xx 写进 server.log（kind=model_alias_rejected）：access 日志只有状态码，
 * 此前 WebUI 报 400 时无从得知是哪条记录、因为什么被拒。
 */
function createLoggedWriteJson(deps, method, pathname) {
  const writeJson = deps.writeJson;
  const appendLog = deps.appendProxyRequestLog;
  if (typeof appendLog !== 'function') return writeJson;
  return (res, status, payload) => {
    if (Number(status) >= 400) {
      try {
        appendLog({
          at: new Date().toISOString(),
          kind: 'model_alias_rejected',
          method,
          path: pathname,
          status,
          error: payload && payload.error,
          detail: payload && payload.detail,
          model: payload && payload.model,
          providers: payload && payload.providers,
          diagnostics: payload && payload.diagnostics
        });
      } catch (_error) { /* 日志出口失败不影响响应 */ }
    }
    return writeJson(res, status, payload);
  };
}

// scheduleAliasShadowCompare 异步核对 Go 侧副本。
//
// 刻意不 await：对账失败不能拖慢也不能影响列表响应；Go 不可用时静默跳过。
function scheduleAliasShadowCompare(ctx, nodeAliases) {
  const deps = (ctx && ctx.deps) || {};
  const goHost = deps.goCoreSync;
  if (!goHost || typeof goHost.listModelAliases !== 'function') return;
  if (typeof goHost.isEnabled === 'function' && !goHost.isEnabled()) return;
  Promise.resolve()
    .then(() => goHost.listModelAliases())
    .then((response) => {
      if (!response || response.ok !== true) return null;
      const payload = response.data && typeof response.data === 'object' ? response.data : {};
      const goAliases = Array.isArray(payload.aliases) ? payload.aliases : [];
      const diff = compareAliasSets(nodeAliases, goAliases);
      reportAliasShadow(ctx, diff);
      return diff;
    })
    .catch(() => {});
}

// reportAliasShadow 把最近一次对账结果留在内存里（供诊断读取），并只在有 logger 时记一条。
//
// 为什么不默认 console：这是一次页面请求的副作用，没有漂移时不该产生任何输出；
// 有漂移时也只记一行摘要，不打印整份集合。
function reportAliasShadow(ctx, diff) {
  const deps = (ctx && ctx.deps) || {};
  const snapshot = {
    checkedAt: Date.now(),
    equal: diff.equal,
    missing: diff.missing,
    extra: diff.extra,
    changed: diff.changed
  };
  if (ctx && ctx.state && typeof ctx.state === 'object') {
    ctx.state.aliasShadow = snapshot;
  }
  if (typeof deps.onAliasShadowResult === 'function') {
    deps.onAliasShadowResult(diff);
    return;
  }
  if (!diff.equal && deps.logger && typeof deps.logger.warn === 'function') {
    deps.logger.warn(
      '[aih:alias-shadow] Node 与 Go 的别名副本不一致: missing=' + diff.missing.length +
      ' extra=' + diff.extra.length + ' changed=' + diff.changed.length
    );
  }
}

async function handleWebUiModelAliasRoutes(ctx) {
  const { req, res, method, pathname, state, deps } = ctx;
  // 写入口只有一个：Go Core 可用时由它接管（含列表读），Node 只维护读投影。
  if (aliasRoutesGoOwned(deps)) {
    const handled = await handleAliasRouteViaGo(ctx);
    if (handled) return true;
  }
  const { readRequestBody, fs, aiHomeDir } = deps;
  const writeJson = createLoggedWriteJson(deps, method, pathname);

  if (pathname === '/v0/webui/model-aliases') {
    if (method === 'GET') {
      const data = await readAliasState(state, fs, aiHomeDir);
      const aliases = data.aliases;
      // 影子对账：不改变响应，只把漂移交给观察者（默认无操作）。
      // Node 仍是 owner，这里攒的是「能不能把所有权翻到 Go」的证据。
      scheduleAliasShadowCompare(ctx, aliases);
      writeJson(res, 200, { ok: true, aliases });
      return true;
    }

    if (method === 'POST') {
      const bodyBufferResult = await readRequestBody(req, { maxBytes: 1024 * 1024 }).catch((error) => ({ __error: error }));
      if (!bodyBufferResult || bodyBufferResult.__error) {
        writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
        return true;
      }

      let payload;
      try {
        payload = JSON.parse(bodyBufferResult.toString('utf8'));
      } catch (e) {
        writeJson(res, 400, { ok: false, error: 'invalid_json' });
        return true;
      }

      const newAlias = normalizeAliasRecord(payload, {
        id: generateAliasId(),
        provider: 'all',
        targetProvider: 'auto',
        priority: 0,
        enabled: true
      });

      if (!newAlias.alias || !newAlias.target) {
        writeJson(res, 400, { ok: false, error: 'missing_fields' });
        return true;
      }

      const current = await readAliasState(state, fs, aiHomeDir);
      const validationContext = await createAliasValidationContext(ctx, current.aliases);
      const validation = validateAliasRecordForSave(newAlias, validationContext);
      if (!validation.ok) {
        writeAliasValidationError(writeJson, res, validation);
        return true;
      }
      current.aliases.push(newAlias);

      try {
        await writeAliasState(ctx, state, fs, aiHomeDir, current);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: 'save_failed' });
        return true;
      }

      writeJson(res, 200, { ok: true, alias: newAlias });
      return true;
    }
  }

  // 别名目标候选：与保存时的校验同一份能力索引、同一个判据（modelHasCatalogProvider）。
  // WebUI 下拉只列这里给出的 (provider, model)，选得到的就一定存得进去。
  if (pathname === '/v0/webui/model-aliases/targets' && method === 'GET') {
    const current = await readAliasState(state, fs, aiHomeDir);
    const { modelCapabilityIndex } = await createAliasValidationContext(ctx, current.aliases);
    const targets = {};
    SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
      const models = listProviderModelIds(modelCapabilityIndex, provider)
        .filter((model) => modelHasCatalogProvider(modelCapabilityIndex, model, provider));
      if (models.length > 0) targets[provider] = models;
    });
    writeJson(res, 200, { ok: true, targets });
    return true;
  }

  // 聚合行（同一 alias 的多条记录）整体替换：先校验全部新记录，再一次性删旧写新。
  // 编辑与删除都走这里，避免「先删旧记录、新记录校验失败」把别名删没，
  // 也避免逐条 DELETE 中途失败留下半截状态。records 为空即删除整组。
  if (pathname === '/v0/webui/model-aliases/replace' && method === 'POST') {
    const bodyBufferResult = await readRequestBody(req, { maxBytes: 1024 * 1024 }).catch((error) => ({ __error: error }));
    if (!bodyBufferResult || bodyBufferResult.__error) {
      writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(bodyBufferResult.toString('utf8'));
    } catch (e) {
      writeJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const replaceIds = new Set((Array.isArray(payload && payload.replaceIds) ? payload.replaceIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean));
    const rawRecords = Array.isArray(payload && payload.records) ? payload.records : [];

    const current = await readAliasState(state, fs, aiHomeDir);
    const kept = current.aliases.filter((alias) => !replaceIds.has(alias.id));
    const nextRecords = rawRecords.map((record) => normalizeAliasRecord({ ...record, id: '' }, {
      provider: 'all',
      targetProvider: 'auto',
      priority: 0,
      enabled: true
    })).map((record) => ({ ...record, id: generateAliasId() }));

    if (nextRecords.length > 0) {
      const validationContext = await createAliasValidationContext(ctx, kept.concat(nextRecords));
      for (const record of nextRecords) {
        const validation = validateAliasRecordForSave(record, validationContext);
        if (!validation.ok) {
          writeAliasValidationError(writeJson, res, validation);
          return true;
        }
      }
    }

    try {
      await writeAliasState(ctx, state, fs, aiHomeDir, { ...current, aliases: kept.concat(nextRecords) });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: 'save_failed' });
      return true;
    }
    writeJson(res, 200, { ok: true, removed: current.aliases.length - kept.length, aliases: nextRecords });
    return true;
  }

  const matchId = pathname.match(/^\/v0\/webui\/model-aliases\/([a-zA-Z0-9_-]+)(?:\/(toggle))?$/);
  if (matchId) {
    const id = matchId[1];
    const isToggle = matchId[2] === 'toggle';

    const current = await readAliasState(state, fs, aiHomeDir);
    if (!current || !Array.isArray(current.aliases)) {
      writeJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }

    const index = current.aliases.findIndex(a => a.id === id);
    if (index === -1) {
      writeJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }

    if (method === 'DELETE') {
      current.aliases.splice(index, 1);
      try {
        await writeAliasState(ctx, state, fs, aiHomeDir, current);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: 'save_failed' });
        return true;
      }
      writeJson(res, 200, { ok: true });
      return true;
    }

    if (method === 'PUT' && !isToggle) {
      const bodyBufferResult = await readRequestBody(req, { maxBytes: 1024 * 1024 }).catch((error) => ({ __error: error }));
      if (!bodyBufferResult || bodyBufferResult.__error) {
        writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
        return true;
      }
      let payload;
      try {
        payload = JSON.parse(bodyBufferResult.toString('utf8'));
      } catch (e) {
        writeJson(res, 400, { ok: false, error: 'invalid_json' });
        return true;
      }

      current.aliases[index] = normalizeAliasRecord(payload, current.aliases[index]);

      if (!current.aliases[index].alias || !current.aliases[index].target) {
        writeJson(res, 400, { ok: false, error: 'missing_fields' });
        return true;
      }
      const validationContext = await createAliasValidationContext(ctx, current.aliases);
      const validation = validateAliasRecordForSave(current.aliases[index], validationContext);
      if (!validation.ok) {
        writeAliasValidationError(writeJson, res, validation);
        return true;
      }

      try {
        await writeAliasState(ctx, state, fs, aiHomeDir, current);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: 'save_failed' });
        return true;
      }
      writeJson(res, 200, { ok: true, alias: current.aliases[index] });
      return true;
    }

    if (method === 'POST' && isToggle) {
      current.aliases[index].enabled = !current.aliases[index].enabled;
      try {
        await writeAliasState(ctx, state, fs, aiHomeDir, current);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: 'save_failed' });
        return true;
      }
      writeJson(res, 200, { ok: true, alias: current.aliases[index] });
      return true;
    }
  }

  return false;
}

module.exports = {
  scheduleAliasShadowCompare,
  handleWebUiModelAliasRoutes
};
