'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { createImageStudioDatabase } = require('./image-studio-database');

const STORE_VERSION = 2;
const SESSION_ID_PATTERN = /^img_[0-9a-f-]{36}$/i;
const REVISION_ID_PATTERN = /^rev_[0-9a-f-]{36}$/i;
const ASSET_ID_PATTERN = /^asset_[0-9a-f-]{36}$/i;
const MAX_STUDIO_ASSET_BYTES = 20 * 1024 * 1024;
const DEFAULT_SESSION_TITLE = '未命名影像会话';
const MIME_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
});

function createStoreError(statusCode, code, detail) {
  const error = new Error(String(detail || code || 'image_studio_store_error'));
  error.name = 'ImageStudioStoreError';
  error.statusCode = Number(statusCode) || 500;
  error.code = String(code || 'image_studio_store_error');
  error.detail = String(detail || error.message);
  return error;
}

function normalizeText(value, maxLength) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeTitle(value) {
  return normalizeText(value, 120) || DEFAULT_SESSION_TITLE;
}

function normalizeMimeType(value) {
  const mimeType = normalizeText(value, 80).toLowerCase();
  return MIME_EXTENSIONS[mimeType] ? mimeType : '';
}

function normalizeOutputCompression(value) {
  if (value == null || value === '') return null;
  const compression = Number(value);
  return Number.isInteger(compression) && compression >= 0 && compression <= 100
    ? compression
    : null;
}

function createId(prefix, randomUUID = crypto.randomUUID) {
  return `${prefix}_${randomUUID()}`;
}

function assertId(value, pattern, code) {
  const id = normalizeText(value, 80);
  if (!pattern.test(id)) throw createStoreError(400, code, `invalid ${code.replace(/^invalid_/, '').replace(/_/g, ' ')}`);
  return id;
}

function parseSessionPayload(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!parsed || typeof parsed !== 'object') return null;
    parsed.version = STORE_VERSION;
    parsed.revisions = (Array.isArray(parsed.revisions) ? parsed.revisions : []).map((revision) => {
      if (!revision || typeof revision !== 'object') return revision;
      const legacySourceAssetId = normalizeText(revision.sourceAssetId, 80);
      revision.sourceAssetIds = (Array.isArray(revision.sourceAssetIds)
        ? revision.sourceAssetIds
        : legacySourceAssetId ? [legacySourceAssetId] : [])
        .map((assetId) => normalizeText(assetId, 80))
        .filter(Boolean);
      delete revision.sourceAssetId;
      const parameters = revision.parameters && typeof revision.parameters === 'object'
        ? revision.parameters
        : {};
      revision.parameters = {
        n: Math.max(1, Number(parameters.n) || 1),
        size: normalizeText(parameters.size, 40),
        quality: normalizeText(parameters.quality, 40),
        background: normalizeText(parameters.background, 40),
        outputFormat: normalizeText(parameters.outputFormat, 40),
        outputCompression: normalizeOutputCompression(parameters.outputCompression),
        moderation: normalizeText(parameters.moderation, 40)
      };
      return revision;
    });
    return parsed;
  } catch (_error) {
    return null;
  }
}

function summarizeSession(session) {
  const revisions = Array.isArray(session.revisions) ? session.revisions : [];
  const latest = revisions[revisions.length - 1] || null;
  const previewAssetId = revisions
    .slice()
    .reverse()
    .flatMap((revision) => Array.isArray(revision.outputAssetIds) ? revision.outputAssetIds.slice().reverse() : [])
    .find(Boolean) || '';
  const previewAsset = (Array.isArray(session.assets) ? session.assets : [])
    .find((asset) => asset && asset.id === previewAssetId);
  return {
    id: session.id,
    title: normalizeTitle(session.title),
    createdAt: Number(session.createdAt) || 0,
    updatedAt: Number(session.updatedAt) || 0,
    revisionCount: revisions.length,
    assetCount: Array.isArray(session.assets) ? session.assets.length : 0,
    activeRevisionId: normalizeText(session.activeRevisionId, 80),
    latestStatus: normalizeText(latest && latest.status, 32),
    latestModel: normalizeText(latest && latest.model, 160),
    latestProvider: normalizeText(latest && latest.provider, 64),
    previewAssetId,
    previewMimeType: normalizeMimeType(previewAsset && previewAsset.mimeType) || 'image/png'
  };
}

function createImageStudioStore(deps = {}) {
  const fsImpl = deps.fs || fs;
  const aiHomeDir = normalizeText(deps.aiHomeDir, 2048);
  const randomUUID = deps.randomUUID || crypto.randomUUID;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  if (!aiHomeDir) throw createStoreError(500, 'image_studio_home_missing', 'AIH home directory is required');

  const database = createImageStudioDatabase({
    fs: fsImpl,
    aiHomeDir,
    ...(deps.DatabaseSync === undefined ? {} : { DatabaseSync: deps.DatabaseSync })
  });

  function currentTimestamp() {
    return Number(now()) || Date.now();
  }

  function resolveSessionId(sessionId) {
    return assertId(sessionId, SESSION_ID_PATTERN, 'invalid_image_session_id');
  }

  function readSessionFromDb(db, sessionId) {
    const id = resolveSessionId(sessionId);
    const row = db.prepare(
      'SELECT payload_json FROM image_studio_sessions WHERE session_id = ?'
    ).get(id);
    const session = row && parseSessionPayload(row.payload_json);
    if (!session || session.id !== id) {
      throw createStoreError(404, 'image_session_not_found', 'image session ' + id + ' was not found');
    }
    return session;
  }

  function insertSession(db, session) {
    db.prepare(
      'INSERT INTO image_studio_sessions '
      + '(session_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(
      session.id,
      JSON.stringify(session),
      Number(session.createdAt) || 0,
      Number(session.updatedAt) || 0
    );
    return session;
  }

  function updateSession(db, session) {
    const result = db.prepare(
      'UPDATE image_studio_sessions '
      + 'SET payload_json = ?, created_at = ?, updated_at = ? WHERE session_id = ?'
    ).run(
      JSON.stringify(session),
      Number(session.createdAt) || 0,
      Number(session.updatedAt) || 0,
      session.id
    );
    if (Number(result && result.changes) < 1) {
      throw createStoreError(404, 'image_session_not_found', 'image session ' + session.id + ' was not found');
    }
    return session;
  }

  function createSession(input = {}) {
    return database.withTransaction((db) => {
      const id = createId('img', randomUUID);
      const createdAt = currentTimestamp();
      return insertSession(db, {
        version: STORE_VERSION,
        id,
        title: normalizeTitle(input.title),
        createdAt,
        updatedAt: createdAt,
        activeRevisionId: '',
        revisions: [],
        assets: []
      });
    });
  }

  function listSessions() {
    return database.withConnection((db) => db.prepare(
      'SELECT payload_json FROM image_studio_sessions '
      + 'ORDER BY updated_at DESC, created_at DESC, session_id'
    ).all()
      .map((row) => parseSessionPayload(row && row.payload_json))
      .filter((session) => session && SESSION_ID_PATTERN.test(String(session.id || '')))
      .map(summarizeSession)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt));
  }

  function readSession(sessionId) {
    return database.withConnection((db) => readSessionFromDb(db, sessionId));
  }

  function renameSession(sessionId, title) {
    return database.withTransaction((db) => {
      const session = readSessionFromDb(db, sessionId);
      session.title = normalizeTitle(title);
      session.updatedAt = currentTimestamp();
      return updateSession(db, session);
    });
  }

  function deleteSession(sessionId) {
    return database.withTransaction((db) => {
      const session = readSessionFromDb(db, sessionId);
      const running = (Array.isArray(session.revisions) ? session.revisions : [])
        .some((revision) => revision && revision.status === 'running');
      if (running) {
        throw createStoreError(409, 'image_session_running', 'image session has a running revision');
      }
      const result = db.prepare(
        'DELETE FROM image_studio_sessions WHERE session_id = ?'
      ).run(session.id);
      if (Number(result && result.changes) < 1) {
        throw createStoreError(404, 'image_session_not_found', 'image session ' + session.id + ' was not found');
      }
      return session;
    });
  }

  function findAsset(session, assetId) {
    const id = assertId(assetId, ASSET_ID_PATTERN, 'invalid_image_asset_id');
    const asset = (Array.isArray(session.assets) ? session.assets : [])
      .find((item) => item && item.id === id);
    if (!asset) throw createStoreError(404, 'image_asset_not_found', 'image asset ' + id + ' was not found');
    return asset;
  }

  function insertAsset(db, sessionId, revisionId, role, image) {
    const mimeType = normalizeMimeType(image && image.mimeType);
    if (!mimeType) throw createStoreError(400, 'invalid_image_asset_mime', 'image asset mime type is not supported');
    const bytes = Buffer.isBuffer(image && image.bytes)
      ? image.bytes
      : Buffer.from(image && image.bytes || []);
    if (bytes.length < 1) throw createStoreError(400, 'empty_image_asset', 'image asset is empty');
    if (bytes.length > MAX_STUDIO_ASSET_BYTES) {
      throw createStoreError(413, 'image_asset_too_large', 'image asset exceeds 20 MiB limit');
    }
    const id = createId('asset', randomUUID);
    const createdAt = currentTimestamp();
    db.prepare(
      'INSERT INTO image_studio_assets '
      + '(asset_id, session_id, content, byte_length, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, sessionId, bytes, bytes.length, createdAt);
    const revisedPrompt = normalizeText(image && image.revisedPrompt, 12000);
    return {
      id,
      revisionId,
      role,
      mimeType,
      byteLength: bytes.length,
      createdAt,
      ...(revisedPrompt ? { revisedPrompt } : {})
    };
  }

  function beginRevision(sessionId, input = {}) {
    return database.withTransaction((db) => {
      const session = readSessionFromDb(db, sessionId);
      const mode = input.mode === 'edit' ? 'edit' : 'generation';
      const prompt = normalizeText(input.prompt, 12000);
      const model = normalizeText(input.model, 160);
      const provider = normalizeText(input.provider, 64).toLowerCase();
      if (!prompt) throw createStoreError(400, 'prompt_required', 'prompt is required');
      if (!model) throw createStoreError(400, 'model_required', 'model is required');
      if (!provider) throw createStoreError(400, 'provider_required', 'provider is required');

      const id = createId('rev', randomUUID);
      let maskAssetId = normalizeText(input.maskAssetId, 80);
      if (maskAssetId) findAsset(session, maskAssetId);

      const sources = Array.isArray(input.sources)
        ? input.sources
        : input.sourceAssetId || input.sourceImage
          ? [{ assetId: input.sourceAssetId, image: input.sourceImage }]
          : [];
      if (mode === 'edit' && sources.length < 1) {
        throw createStoreError(400, 'image_required', 'an image asset is required for image edits');
      }

      const parentRevisionId = normalizeText(input.parentRevisionId, 80);
      if (parentRevisionId && !(Array.isArray(session.revisions) ? session.revisions : [])
        .some((revision) => revision && revision.id === parentRevisionId)) {
        throw createStoreError(400, 'invalid_parent_revision', 'parent revision does not exist in this session');
      }

      const newAssets = [];
      const sourceAssetIds = sources.map((source) => {
        const assetId = normalizeText(source && source.assetId, 80);
        const image = source && source.image;
        if (assetId && image) {
          throw createStoreError(400, 'ambiguous_image_input', 'each source must use either assetId or image');
        }
        if (assetId) {
          findAsset(session, assetId);
          return assetId;
        }
        if (image) {
          const asset = insertAsset(db, session.id, id, 'source', image);
          newAssets.push(asset);
          return asset.id;
        }
        throw createStoreError(400, 'invalid_image_source', 'each source must include assetId or image');
      });
      if (input.maskImage) {
        const asset = insertAsset(db, session.id, id, 'mask', input.maskImage);
        newAssets.push(asset);
        maskAssetId = asset.id;
      }

      const createdAt = currentTimestamp();
      const revision = {
        id,
        parentRevisionId,
        mode,
        prompt,
        provider,
        model,
        modelKey: normalizeText(input.modelKey, 240) || provider + ':' + model,
        parameters: {
          n: Math.max(1, Number(input.parameters && input.parameters.n) || 1),
          size: normalizeText(input.parameters && input.parameters.size, 40),
          quality: normalizeText(input.parameters && input.parameters.quality, 40),
          background: normalizeText(input.parameters && input.parameters.background, 40),
          outputFormat: normalizeText(input.parameters && input.parameters.outputFormat, 40),
          outputCompression: normalizeOutputCompression(
            input.parameters && input.parameters.outputCompression
          ),
          moderation: normalizeText(input.parameters && input.parameters.moderation, 40)
        },
        sourceAssetIds,
        maskAssetId,
        outputAssetIds: [],
        status: 'running',
        createdAt,
        completedAt: 0,
        accountRef: '',
        error: null
      };
      session.revisions = Array.isArray(session.revisions) ? session.revisions : [];
      session.assets = Array.isArray(session.assets) ? session.assets : [];
      session.revisions.push(revision);
      session.assets.push(...newAssets);
      session.activeRevisionId = id;
      session.updatedAt = createdAt;
      if (session.revisions.length === 1 && normalizeTitle(session.title) === DEFAULT_SESSION_TITLE) {
        session.title = normalizeTitle(prompt);
      }
      updateSession(db, session);
      return { session, revision };
    });
  }

  function findRevision(session, revisionId) {
    const id = assertId(revisionId, REVISION_ID_PATTERN, 'invalid_image_revision_id');
    const revision = (Array.isArray(session.revisions) ? session.revisions : [])
      .find((item) => item && item.id === id);
    if (!revision) throw createStoreError(404, 'image_revision_not_found', 'image revision ' + id + ' was not found');
    return revision;
  }

  function assertRevisionRunning(revision) {
    if (revision && revision.status === 'running') return;
    throw createStoreError(409, 'image_revision_not_running', 'image revision is already settled');
  }

  function completeRevision(sessionId, revisionId, input = {}) {
    const images = Array.isArray(input.images) ? input.images : [];
    if (images.length < 1) throw createStoreError(502, 'image_output_missing', 'image generation returned no persistent output');
    return database.withTransaction((db) => {
      const session = readSessionFromDb(db, sessionId);
      const revision = findRevision(session, revisionId);
      assertRevisionRunning(revision);
      const writtenAssets = images.map((image) => (
        insertAsset(db, session.id, revision.id, 'output', image)
      ));
      session.assets = Array.isArray(session.assets) ? session.assets : [];
      session.assets.push(...writtenAssets);
      revision.outputAssetIds = writtenAssets.map((asset) => asset.id);
      revision.status = 'succeeded';
      revision.completedAt = currentTimestamp();
      revision.accountRef = normalizeText(input.accountRef, 120);
      revision.error = null;
      if (!session.activeRevisionId) session.activeRevisionId = revision.id;
      session.updatedAt = revision.completedAt;
      updateSession(db, session);
      return { session, revision };
    });
  }

  function failRevision(sessionId, revisionId, error) {
    return database.withTransaction((db) => {
      const session = readSessionFromDb(db, sessionId);
      const revision = findRevision(session, revisionId);
      assertRevisionRunning(revision);
      revision.status = 'failed';
      revision.completedAt = currentTimestamp();
      revision.error = {
        code: normalizeText(error && error.code, 120) || 'image_generation_failed',
        message: normalizeText(error && (error.detail || error.message), 1000) || 'image generation failed',
        statusCode: Number(error && error.statusCode) || 500
      };
      session.updatedAt = revision.completedAt;
      updateSession(db, session);
      return { session, revision };
    });
  }

  function readAsset(sessionId, assetId) {
    return database.withConnection((db) => {
      const session = readSessionFromDb(db, sessionId);
      const asset = findAsset(session, assetId);
      const row = db.prepare(
        'SELECT content, byte_length FROM image_studio_assets '
        + 'WHERE asset_id = ? AND session_id = ?'
      ).get(asset.id, session.id);
      if (!row) {
        throw createStoreError(404, 'image_asset_not_found', 'image asset ' + asset.id + ' was not found');
      }
      const bytes = Buffer.from(row.content || []);
      if (bytes.length !== Number(row.byte_length) || bytes.length !== Number(asset.byteLength)) {
        throw createStoreError(500, 'image_asset_corrupt', 'image asset content length is inconsistent');
      }
      return { asset, bytes };
    });
  }

  function recoverInterruptedRevisions() {
    database.withTransaction((db) => {
      const recoveredAt = currentTimestamp();
      db.prepare('SELECT payload_json FROM image_studio_sessions').all().forEach((row) => {
        const session = parseSessionPayload(row && row.payload_json);
        if (!session || !SESSION_ID_PATTERN.test(String(session.id || '')) || !Array.isArray(session.revisions)) {
          return;
        }
        let changed = false;
        session.revisions.forEach((revision) => {
          if (!revision || revision.status !== 'running') return;
          revision.status = 'failed';
          revision.completedAt = recoveredAt;
          revision.error = {
            code: 'image_studio_run_interrupted',
            message: 'image Studio run was interrupted because the server restarted',
            statusCode: 503
          };
          changed = true;
        });
        if (!changed) return;
        session.updatedAt = recoveredAt;
        updateSession(db, session);
      });
    });
  }

  recoverInterruptedRevisions();

  return {
    beginRevision,
    completeRevision,
    createSession,
    deleteSession,
    failRevision,
    getSession: readSession,
    listSessions,
    readAsset,
    renameSession
  };
}

module.exports = {
  createImageStudioStore,
  __private: {
    ASSET_ID_PATTERN,
    DEFAULT_SESSION_TITLE,
    MAX_STUDIO_ASSET_BYTES,
    REVISION_ID_PATTERN,
    SESSION_ID_PATTERN,
    STORE_VERSION,
    createStoreError,
    normalizeMimeType,
    summarizeSession
  }
};
