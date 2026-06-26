'use strict';
const {
  generateAliasId,
  loadAliases,
  normalizeAliasRecord,
  saveAliases
} = require('./model-alias-store');
const {
  buildModelCapabilityIndex
} = require('./model-capability-index');
const {
  validateAliasRecordForSave
} = require('./model-alias-validation');
const {
  getWebUiModelsCache
} = require('./webui-model-cache');

async function readAliasState(state, fs, aiHomeDir) {
  const data = await loadAliases(fs, aiHomeDir);
  state.modelAliases = data;
  return data;
}

async function writeAliasState(state, fs, aiHomeDir, data) {
  const saved = await saveAliases(fs, aiHomeDir, data);
  state.modelAliases = saved;
  return saved;
}

function writeAliasValidationError(writeJson, res, validation) {
  writeJson(res, 400, {
    ok: false,
    error: validation && validation.error || 'invalid_model_alias',
    detail: validation && validation.detail || 'invalid model alias',
    model: validation && validation.model || undefined,
    providers: validation && validation.providers || undefined
  });
}

async function createAliasValidationContext(ctx, aliases) {
  const { state, options, deps } = ctx;
  await getWebUiModelsCache(state, options || {}, {
    fs: ctx.fs || deps && deps.fs,
    aiHomeDir: ctx.aiHomeDir || deps && deps.aiHomeDir,
    fetchModelsForAccount: deps && deps.fetchModelsForAccount
  }).catch(() => null);
  return {
    aliases,
    state,
    options: options || {},
    modelCapabilityIndex: buildModelCapabilityIndex(state, options || {})
  };
}

async function handleWebUiModelAliasRoutes(ctx) {
  const { req, res, method, pathname, state, deps } = ctx;
  const { writeJson, readRequestBody, fs, aiHomeDir } = deps;

  if (pathname === '/v0/webui/model-aliases') {
    if (method === 'GET') {
      const data = await readAliasState(state, fs, aiHomeDir);
      const aliases = data.aliases;
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
        await writeAliasState(state, fs, aiHomeDir, current);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: 'save_failed' });
        return true;
      }

      writeJson(res, 200, { ok: true, alias: newAlias });
      return true;
    }
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
        await writeAliasState(state, fs, aiHomeDir, current);
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
        await writeAliasState(state, fs, aiHomeDir, current);
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
        await writeAliasState(state, fs, aiHomeDir, current);
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
  handleWebUiModelAliasRoutes
};
