'use strict';

// opencode 会话库布局表（lib/sessions/opencode-db-layouts.js）的契约测试：
// 描述符形状、存在性探测、查询构造的跨布局行形状一致性。

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  LAYOUTS,
  hasOpenCodeTable,
  detectOpenCodeDbLayouts,
  buildOpenCodeMessageQuery
} = require('../lib/sessions/opencode-db-layouts');

const LEGACY_SCHEMA = `
  CREATE TABLE session (id TEXT);
  CREATE TABLE message (id TEXT);
  CREATE TABLE part (id TEXT);
`;

const V2_SCHEMA = `
  CREATE TABLE session_v2 (id TEXT);
  CREATE TABLE session_message (id TEXT, type TEXT);
`;

function openDb(schema) {
  const db = new DatabaseSync(':memory:');
  if (schema) db.exec(schema);
  return db;
}

test('布局表按新→旧声明两代存储布局（新增布局 = 加一条描述符）', () => {
  assert.deepEqual(LAYOUTS.map((layout) => layout.id), ['session_v2', 'session_legacy']);
  const [v2, legacy] = LAYOUTS;
  assert.equal(v2.sessionTable, 'session_v2');
  assert.equal(v2.messageTable, 'session_message');
  assert.equal(v2.messageTypeColumn, 'type');
  assert.equal(v2.contentModel, 'inline');
  assert.equal(legacy.sessionTable, 'session');
  assert.equal(legacy.messageTable, 'message');
  assert.equal(legacy.messageTypeColumn, null);
  assert.equal(legacy.contentModel, 'parts');
  assert.equal(legacy.partTable, 'part');
});

test('detectOpenCodeDbLayouts 只认「会话 + 消息表同时存在」的布局，双代并存按新→旧', () => {
  const pureLegacy = openDb(LEGACY_SCHEMA);
  assert.deepEqual(detectOpenCodeDbLayouts(pureLegacy).map((layout) => layout.id), ['session_legacy']);

  const pureV2 = openDb(V2_SCHEMA);
  assert.deepEqual(detectOpenCodeDbLayouts(pureV2).map((layout) => layout.id), ['session_v2']);

  const both = openDb(`${LEGACY_SCHEMA}${V2_SCHEMA}`);
  assert.deepEqual(detectOpenCodeDbLayouts(both).map((layout) => layout.id), ['session_v2', 'session_legacy']);

  // 单侧表（只有 message，没有 session）不算一个布局。
  const half = openDb('CREATE TABLE message (id TEXT);');
  assert.deepEqual(detectOpenCodeDbLayouts(half), []);

  assert.equal(hasOpenCodeTable(both, 'session_v2'), true);
  assert.equal(hasOpenCodeTable(both, 'missing_table'), false);
  assert.equal(hasOpenCodeTable(null, 'session'), false);
});

test('buildOpenCodeMessageQuery 的跨布局行形状一致：角色列只在新代取 type 列', () => {
  const [v2, legacy] = LAYOUTS;
  const v2Query = buildOpenCodeMessageQuery(v2, { hasProjectTable: true });
  assert.ok(v2Query.includes('session_message.type AS message_type'));
  assert.ok(v2Query.includes('FROM session_message'));
  assert.ok(v2Query.includes('LEFT JOIN session_v2 ON session_v2.id = session_message.session_id'));
  assert.ok(v2Query.includes('LEFT JOIN project ON project.id = session_v2.project_id'));

  const legacyQuery = buildOpenCodeMessageQuery(legacy, {});
  assert.ok(legacyQuery.includes('NULL AS message_type'));
  assert.ok(legacyQuery.includes('FROM message'));
  assert.ok(legacyQuery.includes('LEFT JOIN session ON session.id = message.session_id'));
  assert.ok(!legacyQuery.includes('LEFT JOIN project'));

  assert.throws(() => buildOpenCodeMessageQuery({}, {}), /opencode_db_layout_invalid/);
});
