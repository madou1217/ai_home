'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createImageStudioStore } = require('../lib/server/image-studio-store');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-image-studio-store-'));
  let clock = 1000;
  return {
    root,
    store: createImageStudioStore({
      fs,
      aiHomeDir: root,
      now: () => ++clock
    })
  };
}

function queryImageStudioDatabase(root, query, ...params) {
  const db = new DatabaseSync(path.join(root, 'app-state.db'));
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

function countStoredAssets(root) {
  const rows = queryImageStudioDatabase(
    root,
    'SELECT COUNT(*) AS count FROM image_studio_assets'
  );
  return Number(rows[0] && rows[0].count) || 0;
}

function countStoredSessions(root) {
  const rows = queryImageStudioDatabase(
    root,
    'SELECT COUNT(*) AS count FROM image_studio_sessions'
  );
  return Number(rows[0] && rows[0].count) || 0;
}

test('image studio store persists session summaries and title updates', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession();
  assert.match(session.id, /^img_/);
  assert.equal(session.title, '未命名影像会话');
  assert.equal(store.listSessions()[0].revisionCount, 0);

  store.renameSession(session.id, '产品海报探索');
  const reloaded = createImageStudioStore({ fs, aiHomeDir: root }).getSession(session.id);
  assert.equal(reloaded.title, '产品海报探索');
  assert.equal(fs.existsSync(path.join(root, 'studio')), false);
  assert.deepEqual(
    queryImageStudioDatabase(
      root,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'image_studio_%' ORDER BY name"
    ).map((row) => row.name),
    ['image_studio_assets', 'image_studio_sessions']
  );
});

test('image studio store records a generation revision and durable output asset', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession();
  const started = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'A graphite product portrait',
    parameters: { n: 1, quality: 'high' }
  });
  assert.equal(started.revision.status, 'running');
  assert.equal(started.session.title, 'A graphite product portrait');

  const completed = store.completeRevision(session.id, started.revision.id, {
    accountRef: 'acct_codex',
    images: [{ mimeType: 'image/png', bytes: PNG_BYTES, revisedPrompt: 'A refined product portrait' }]
  });
  assert.equal(completed.revision.status, 'succeeded');
  assert.equal(completed.revision.accountRef, 'acct_codex');
  assert.equal(completed.revision.outputAssetIds.length, 1);

  const asset = store.readAsset(session.id, completed.revision.outputAssetIds[0]);
  assert.equal(asset.asset.mimeType, 'image/png');
  assert.equal(asset.asset.revisedPrompt, 'A refined product portrait');
  assert.deepEqual(asset.bytes, PNG_BYTES);

  const persisted = createImageStudioStore({ fs, aiHomeDir: root }).getSession(session.id);
  assert.equal(persisted.revisions[0].status, 'succeeded');
  assert.equal(store.listSessions()[0].previewAssetId, completed.revision.outputAssetIds[0]);
});

test('image studio store settles running revisions left behind by a server restart', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession();
  store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'interrupted frame'
  });

  const restored = createImageStudioStore({ fs, aiHomeDir: root }).getSession(session.id);
  assert.equal(restored.revisions[0].status, 'failed');
  assert.equal(restored.revisions[0].error.code, 'image_studio_run_interrupted');
  assert.match(restored.revisions[0].error.message, /server restarted/i);
  assert.ok(restored.revisions[0].completedAt > 0);
});

test('image studio store preserves ordered edit sources, optional masks and output parameters', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession({ title: '迭代链' });
  const generated = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'agy',
    model: 'gemini-3.1-flash-image',
    prompt: 'base frame'
  });
  const first = store.completeRevision(session.id, generated.revision.id, {
    images: [{ mimeType: 'image/png', bytes: PNG_BYTES }]
  });
  const sourceAssetId = first.revision.outputAssetIds[0];

  const edit = store.beginRevision(session.id, {
    mode: 'edit',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'add warm light',
    parentRevisionId: generated.revision.id,
    sources: [
      { assetId: sourceAssetId },
      { image: { mimeType: 'image/png', bytes: PNG_BYTES } }
    ],
    parameters: {
      background: 'transparent',
      outputFormat: 'webp',
      outputCompression: 74,
      moderation: 'low'
    },
    maskImage: { mimeType: 'image/png', bytes: PNG_BYTES }
  });
  assert.equal(edit.revision.sourceAssetIds.length, 2);
  assert.equal(edit.revision.sourceAssetIds[0], sourceAssetId);
  assert.match(edit.revision.sourceAssetIds[1], /^asset_/);
  assert.deepEqual(edit.revision.parameters, {
    n: 1,
    size: '',
    quality: '',
    background: 'transparent',
    outputFormat: 'webp',
    outputCompression: 74,
    moderation: 'low'
  });
  assert.match(edit.revision.maskAssetId, /^asset_/);
  assert.equal(edit.revision.parentRevisionId, generated.revision.id);
  assert.equal(store.getSession(session.id).assets.length, 3);
});

test('image studio store keeps null output compression unset across writes and reloads', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession();
  const started = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'lossless png output',
    parameters: { outputCompression: null }
  });

  assert.equal(started.revision.parameters.outputCompression, null);
  assert.equal(
    createImageStudioStore({ fs, aiHomeDir: root })
      .getSession(session.id)
      .revisions[0]
      .parameters.outputCompression,
    null
  );
});

test('image studio store persists failed revisions without losing the session', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession();
  const started = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'grok',
    model: 'grok-imagine-image-2.0',
    prompt: 'failure trace'
  });
  const failed = store.failRevision(session.id, started.revision.id, {
    statusCode: 429,
    code: 'upstream_failed',
    detail: 'quota exhausted'
  });
  assert.equal(failed.revision.status, 'failed');
  assert.deepEqual(failed.revision.error, {
    code: 'upstream_failed',
    message: 'quota exhausted',
    statusCode: 429
  });
});

test('image studio store keeps succeeded and failed revisions terminal', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession();
  const completedStart = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'terminal success'
  });
  store.completeRevision(session.id, completedStart.revision.id, {
    images: [{ mimeType: 'image/png', bytes: PNG_BYTES }]
  });
  assert.throws(
    () => store.failRevision(session.id, completedStart.revision.id, new Error('late observer failure')),
    (error) => error.code === 'image_revision_not_running' && error.statusCode === 409
  );
  assert.equal(store.getSession(session.id).revisions[0].status, 'succeeded');

  const failedStart = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'grok',
    model: 'grok-imagine-image-2.0',
    prompt: 'terminal failure'
  });
  store.failRevision(session.id, failedStart.revision.id, new Error('upstream failed'));
  const assetsBeforeLateCompletion = countStoredAssets(root);
  assert.throws(
    () => store.completeRevision(session.id, failedStart.revision.id, {
      images: [{ mimeType: 'image/png', bytes: PNG_BYTES }]
    }),
    (error) => error.code === 'image_revision_not_running' && error.statusCode === 409
  );
  assert.equal(store.getSession(session.id).revisions[1].status, 'failed');
  assert.equal(countStoredAssets(root), assetsBeforeLateCompletion);
});

test('image studio store keeps the newest started revision active when concurrent runs settle out of order', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession({ title: '并发修订' });
  const first = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'first window'
  });
  const second = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'second window'
  });

  store.completeRevision(session.id, second.revision.id, {
    images: [{ mimeType: 'image/png', bytes: PNG_BYTES }]
  });
  store.completeRevision(session.id, first.revision.id, {
    images: [{ mimeType: 'image/png', bytes: PNG_BYTES }]
  });

  const persisted = store.getSession(session.id);
  assert.equal(persisted.revisions.length, 2);
  assert.deepEqual(persisted.revisions.map((revision) => revision.status), ['succeeded', 'succeeded']);
  assert.equal(persisted.activeRevisionId, second.revision.id);
  assert.equal(countStoredAssets(root), 2);
});

test('image studio store deletes a settled session and cascades its durable assets', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession({ title: '待清理会话' });
  const started = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'durable output'
  });
  store.completeRevision(session.id, started.revision.id, {
    images: [{ mimeType: 'image/png', bytes: PNG_BYTES }]
  });
  assert.equal(countStoredSessions(root), 1);
  assert.equal(countStoredAssets(root), 1);

  const deleted = store.deleteSession(session.id);
  assert.equal(deleted.id, session.id);
  assert.equal(countStoredSessions(root), 0);
  assert.equal(countStoredAssets(root), 0);
  assert.throws(
    () => store.getSession(session.id),
    (error) => error.code === 'image_session_not_found' && error.statusCode === 404
  );
});

test('image studio store refuses to delete a session while any revision is running', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = store.createSession();
  store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'still running'
  });

  assert.throws(
    () => store.deleteSession(session.id),
    (error) => error.code === 'image_session_running' && error.statusCode === 409
  );
  assert.equal(countStoredSessions(root), 1);
});

test('image studio store rejects invalid cross-session asset identifiers', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = store.createSession();
  assert.throws(
    () => store.readAsset(session.id, '../../secret'),
    (error) => error.code === 'invalid_image_asset_id' && error.statusCode === 400
  );
});

test('image studio store validates revision links before writes and removes partial input assets', (t) => {
  const { root, store } = makeStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = store.createSession();

  assert.throws(
    () => store.beginRevision(session.id, {
      mode: 'edit',
      provider: 'codex',
      model: 'gpt-image-2',
      prompt: 'invalid parent',
      parentRevisionId: 'rev_00000000-0000-0000-0000-000000000000',
      sources: [{ image: { mimeType: 'image/png', bytes: PNG_BYTES } }]
    }),
    (error) => error.code === 'invalid_parent_revision' && error.statusCode === 400
  );
  assert.equal(countStoredAssets(root), 0);

  assert.throws(
    () => store.beginRevision(session.id, {
      mode: 'edit',
      provider: 'codex',
      model: 'gpt-image-2',
      prompt: 'invalid mask',
      sources: [{ image: { mimeType: 'image/png', bytes: PNG_BYTES } }],
      maskImage: { mimeType: 'image/svg+xml', bytes: PNG_BYTES }
    }),
    (error) => error.code === 'invalid_image_asset_mime' && error.statusCode === 400
  );
  assert.equal(countStoredAssets(root), 0);
  assert.equal(store.getSession(session.id).revisions.length, 0);
  assert.equal(store.getSession(session.id).assets.length, 0);
});
