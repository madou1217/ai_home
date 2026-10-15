'use strict';

// opencode 会话库的存储布局表（Layout Table）——与 `lib/runtime/opencode-run-layouts.js`（CLI 参数布局）、
// `lib/server/opencode-serve-api-layouts.js`（serve API 布局）同族：把 opencode 换代造成的形状差异
// 声明成数据，消费方不再各自写表名判断。
//
// 两代表布局（2026-10-16 真机取证，opencode 2.0.29）：
//   新代 `session_v2` / `session_message` —— 角色在 message 行的 `type` 列（user 消息没有 role 字段），
//        消息内容内嵌在 `data.content` 数组（text / reasoning / tool 条目），会话内 `seq` 自增；
//   旧代 `session` / `message` / `part` —— 角色在 `data.role`，内容在独立的 `part` 表，没有 seq。
//
// 三条硬事实决定消费方式（真机数据，勿凭直觉改写）：
//   1. 两代可同时存在且**两侧都有独有行**（本机实测：3931 条消息两表同 id，旧表独有 76 条、新表独有 1459 条）
//      —— 读取方必须「扫全部存在的布局再按 id 合并」，二选一必丢数据；
//   2. `session_v2` ⊇ 旧 `session`（会话面 0 独有行），消息面不是 —— 会话侧可直读新代，消息侧必须并集；
//   3. opencode 2.x 的旧表迁移只在升级时跑一次，之后写进旧表的行不会进新表 —— 写入方（WebUI chat 代理）
//      必须写「当前活跃布局」（新代优先；未升级的纯旧库写旧代），不能固定写某一代。
//
// 本表只声明「布局是什么」；「怎么合并」（用量扫描按 token 总量、历史渲染按内容非空）是各消费方
// 自己的策略，不在这里替消费方决定。
//
// 新增一代布局 = 加一条描述符；消费方（用量扫描、会话历史读取、WebUI chat 代理写入）不改派发逻辑。

const LAYOUTS = Object.freeze([
  Object.freeze({
    id: 'session_v2',
    sessionTable: 'session_v2',
    messageTable: 'session_message',
    // 角色列：新代在 message 行的 `type` 列；旧代没有该列（null，角色在 data.role）。
    messageTypeColumn: 'type',
    // 内容形态：'inline' = 消息行 data.content 内嵌数组；'parts' = 独立 part 表（每行一个 part）。
    contentModel: 'inline',
    partTable: null
  }),
  Object.freeze({
    id: 'session_legacy',
    sessionTable: 'session',
    messageTable: 'message',
    messageTypeColumn: null,
    contentModel: 'parts',
    partTable: 'part'
  })
]);

const SQLITE_MASTER_QUERY = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1";

/** 某张表是否存在（sqlite_master 探测；探测异常按不存在处理，读取方 fail-closed 口径一致）。 */
function hasOpenCodeTable(db, tableName) {
  const name = String(tableName || '').trim();
  if (!db || !name) return false;
  try {
    const row = db.prepare(SQLITE_MASTER_QUERY).get(name);
    return Boolean(row && row.name);
  } catch (_error) {
    return false;
  }
}

/**
 * 当前库里实际存在的布局（会话表 + 消息表同时存在才算），顺序 = 表声明顺序（新代在前）。
 * 读取方对返回值里的**全部**布局扫描；写入方取第一个（当前活跃布局）。
 */
function detectOpenCodeDbLayouts(db) {
  return LAYOUTS.filter((layout) => (
    hasOpenCodeTable(db, layout.sessionTable) && hasOpenCodeTable(db, layout.messageTable)
  ));
}

/**
 * 按布局构造消息行查询。列别名与语义对所有布局一致（`message_type` 在旧代为 NULL），
 * 因此读取方拿到的行形状相同、合并逻辑不需要认识布局；角色判定的第一来源是
 * `row.message_type || data.role`。
 */
function buildOpenCodeMessageQuery(layout, options = {}) {
  const target = layout && typeof layout === 'object' ? layout : {};
  const sessionTable = String(target.sessionTable || '').trim();
  const messageTable = String(target.messageTable || '').trim();
  if (!sessionTable || !messageTable) {
    throw new Error('opencode_db_layout_invalid');
  }
  const messageTypeColumn = target.messageTypeColumn
    ? `${messageTable}.${target.messageTypeColumn} AS message_type`
    : 'NULL AS message_type';
  const hasProjectTable = Boolean(options.hasProjectTable);
  return `
    SELECT
      ${messageTable}.id AS message_id,
      ${messageTable}.session_id AS session_id,
      ${messageTypeColumn},
      ${messageTable}.time_created AS message_time_created,
      ${messageTable}.time_updated AS message_time_updated,
      ${messageTable}.data AS message_data,
      ${sessionTable}.project_id AS session_project_id,
      ${sessionTable}.directory AS session_directory,
      ${sessionTable}.path AS session_path,
      ${sessionTable}.title AS session_title,
      ${sessionTable}.model AS session_model,
      ${sessionTable}.version AS session_version,
      ${sessionTable}.time_created AS session_time_created,
      ${sessionTable}.time_updated AS session_time_updated,
      ${hasProjectTable ? 'project.worktree AS project_worktree' : 'NULL AS project_worktree'},
      ${hasProjectTable ? 'project.name AS project_name' : 'NULL AS project_name'}
    FROM ${messageTable}
    LEFT JOIN ${sessionTable} ON ${sessionTable}.id = ${messageTable}.session_id
    ${hasProjectTable ? `LEFT JOIN project ON project.id = ${sessionTable}.project_id` : ''}
    ORDER BY ${messageTable}.time_created ASC, ${messageTable}.id ASC
  `;
}

module.exports = {
  LAYOUTS,
  hasOpenCodeTable,
  detectOpenCodeDbLayouts,
  buildOpenCodeMessageQuery
};
