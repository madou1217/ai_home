'use strict';
const { generateAliasId, normalizeAliasRecord, saveAliases } = require('./model-alias-store');

async function handleWebUiModelAliasRoutes(ctx) {
  const { req, res, method, pathname, state, deps } = ctx;
  const { writeJson, readRequestBody, fs, aiHomeDir } = deps;

  if (pathname === '/v0/webui/model-aliases') {
    if (method === 'GET') {
      const aliases = state.modelAliases ? state.modelAliases.aliases : [];
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
        enabled: true
      });

      if (!newAlias.alias || !newAlias.target) {
        writeJson(res, 400, { ok: false, error: 'missing_fields' });
        return true;
      }

      if (!state.modelAliases) state.modelAliases = { aliases: [] };
      state.modelAliases.aliases.push(newAlias);

      try {
        await saveAliases(fs, aiHomeDir, state.modelAliases);
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

    if (!state.modelAliases || !Array.isArray(state.modelAliases.aliases)) {
      writeJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }

    const index = state.modelAliases.aliases.findIndex(a => a.id === id);
    if (index === -1) {
      writeJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }

    if (method === 'DELETE') {
      state.modelAliases.aliases.splice(index, 1);
      try {
        await saveAliases(fs, aiHomeDir, state.modelAliases);
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

      state.modelAliases.aliases[index] = normalizeAliasRecord(payload, state.modelAliases.aliases[index]);

      if (!state.modelAliases.aliases[index].alias || !state.modelAliases.aliases[index].target) {
        writeJson(res, 400, { ok: false, error: 'missing_fields' });
        return true;
      }

      try {
        await saveAliases(fs, aiHomeDir, state.modelAliases);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: 'save_failed' });
        return true;
      }
      writeJson(res, 200, { ok: true, alias: state.modelAliases.aliases[index] });
      return true;
    }

    if (method === 'POST' && isToggle) {
      state.modelAliases.aliases[index].enabled = !state.modelAliases.aliases[index].enabled;
      try {
        await saveAliases(fs, aiHomeDir, state.modelAliases);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: 'save_failed' });
        return true;
      }
      writeJson(res, 200, { ok: true, alias: state.modelAliases.aliases[index] });
      return true;
    }
  }

  return false;
}

module.exports = {
  handleWebUiModelAliasRoutes
};
