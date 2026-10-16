'use strict';

// 布局迁移 P1：opencode 会话历史 reader 必须消费布局表（lib/sessions/opencode-db-layouts.js）。
// 真机取证的三条硬事实在这里逐条钉住：
//   1. 两代可同时存在且两侧都有独有行 → 消息面必须并集（二选一必丢）；
//   2. 同一 id 两侧都可渲染时新代优先（角色/类型以新代为准），但新代渲染为空时不遮挡旧代；
//   3. 旧表在布局迁移后仍被 WebUI chat 代理写入 → 会话面也并集，且归档/子会话过滤放在合并之后
//      （新代标归档时，旧代冻结的 NULL 副本不能把会话捞回列表）。

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { ensureOpenCodeSessionTestSchema, openOpenCodeDb } = require('../lib/sessions/opencode-session-store');

function seedDb(hostHome) {
  fs.mkdirSync(path.join(hostHome, '.local', 'share', 'opencode'), { recursive: true });
  ensureOpenCodeSessionTestSchema(hostHome);
  const db = openOpenCodeDb(hostHome, { readOnly: false });
  const now = Date.now();

  const insLegacySession = db.prepare(`
    INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, model)
    VALUES (?, 'proj', ?, ?, ?, ?, '1', ?, ?, ?, ?)
  `);
  const insV2Session = db.prepare(`
    INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, model)
    VALUES (?, 'proj', ?, ?, ?, ?, '1', ?, ?, ?, ?)
  `);
  const insMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  const insV2Message = db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data, seq) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let seq = 0;

  // —— 会话面 ——
  // ses_mixed：两代都有；v2 副本更新更晚且 model 不同（断言取新代）。
  insLegacySession.run('ses_mixed', null, 'mixed', '/tmp/mixed', '混合会话', now, now, null, JSON.stringify({ id: 'legacy-model', providerID: 'legacy' }));
  insV2Session.run('ses_mixed', null, 'mixed', '/tmp/mixed', '混合会话', now, now + 100, null, JSON.stringify({ id: 'glm-5.2', providerID: 'opencode-go' }));
  // ses_v2only / ses_legacyonly：迁移后的新会话只写新代；迁移前 WebUI 会话只写旧代。
  insV2Session.run('ses_v2only', null, 'v2only', '/tmp/v2only', '新代独有', now, now, null, JSON.stringify({ id: 'deepseek-v4.1-flash-free', providerID: 'opencode' }));
  insLegacySession.run('ses_legacyonly', null, 'legacyonly', '/tmp/legacyonly', '旧代独有', now, now, null, JSON.stringify({ id: 'old-model', providerID: 'opencode-go' }));
  // ses_child_v2：新代才有的子代理会话，旧代影子行 parent_id 为 NULL（合并后按新代排除）。
  insLegacySession.run('ses_child_v2', null, 'child', '/tmp/mixed', 'Review lib (@general subagent)', now, now, null, null);
  insV2Session.run('ses_child_v2', 'ses_mixed', 'child', '/tmp/mixed', 'Review lib (@general subagent)', now, now + 100, null, null);
  // ses_archived_shadow：新代标记归档、旧代冻结为未归档（合并后按新代排除）。
  insLegacySession.run('ses_archived_shadow', null, 'arch', '/tmp/arch', '归档影子会话', now, now, null, null);
  insV2Session.run('ses_archived_shadow', null, 'arch', '/tmp/arch', '归档影子会话', now, now + 100, now + 200, null);

  // —— ses_mixed 消息面 ——
  // T0 旧代独有：迁移前 WebUI 写入的提问（旧表独有，必须兜底可见）。
  insMessage.run('msg_legacy_only', 'ses_mixed', now, now, JSON.stringify({
    role: 'user',
    model: { providerID: 'opencode-go', modelID: 'legacy-model' }
  }));
  insPart.run('p_legacy_only', 'msg_legacy_only', 'ses_mixed', now, now, JSON.stringify({ type: 'text', text: 'legacy 独有提问' }));

  // T1 两代同 id：v2 与旧代内容不同，断言取新代（旧代是冻结副本）。
  insMessage.run('msg_shared', 'ses_mixed', now + 1000, now + 1000, JSON.stringify({
    role: 'assistant',
    model: { providerID: 'opencode-go', modelID: 'legacy-model' }
  }));
  insPart.run('p_shared', 'msg_shared', 'ses_mixed', now + 1000, now + 1000, JSON.stringify({ type: 'text', text: 'legacy 版本的回复' }));
  seq += 1;
  insV2Message.run('msg_shared', 'ses_mixed', 'assistant', now + 1000, now + 1000, JSON.stringify({
    agent: 'build',
    model: { id: 'glm-5.2', providerID: 'opencode-go', variant: 'max' },
    content: [{ type: 'text', text: 'v2 版本的回复' }]
  }), seq);

  // T2 新代独有：content 内嵌 text + tool 条目（产出在 state.content 里，不在 state.output）。
  seq += 1;
  insV2Message.run('msg_v2_tool', 'ses_mixed', 'assistant', now + 2000, now + 2000, JSON.stringify({
    agent: 'build',
    model: { id: 'glm-5.2', providerID: 'opencode-go' },
    content: [
      { type: 'text', text: '让我调用工具。' },
      { type: 'reasoning', text: '先看目录' },
      {
        type: 'tool',
        id: 'call_read_1',
        name: 'read',
        state: { status: 'completed', input: { filePath: '/tmp/demo' }, content: [{ type: 'text', text: '0x 文件内容' }] }
      }
    ]
  }), seq);

  // T3 新代独有：synthetic（自动续写）在旧代就是 role=user 的 text part，展示口径保持 user。
  seq += 1;
  insV2Message.run('msg_v2_synthetic', 'ses_mixed', 'synthetic', now + 3000, now + 3000, JSON.stringify({
    text: 'The previous response was interrupted. Continue…',
    time: { created: now + 3000 }
  }), seq);

  // T4 新代独有：compaction（自动压缩摘要）是运行时标记，迁移前后都不进历史时间线。
  seq += 1;
  insV2Message.run('msg_v2_compaction', 'ses_mixed', 'compaction', now + 4000, now + 4000, JSON.stringify({
    status: 'completed',
    reason: 'auto',
    summary: '## Objective\n自动压缩摘要不该出现'
  }), seq);

  // T5 旧代独有：被中断的 task 工具（output 空）→ 回读子会话产出；子会话只在 v2 里。
  insMessage.run('msg_legacy_task', 'ses_mixed', now + 5000, now + 5000, JSON.stringify({ role: 'assistant' }));
  insPart.run('p_legacy_task', 'msg_legacy_task', 'ses_mixed', now + 5000, now + 5000, JSON.stringify({
    type: 'tool',
    tool: 'task',
    callID: 'call_task_1',
    state: { status: 'running', input: { description: 'Review lib' }, metadata: { sessionId: 'ses_child_v2' }, output: '' }
  }));

  // —— ses_child_v2（新代独有子会话）：子代理产出 ——
  seq += 1;
  insV2Message.run('msg_child_v2', 'ses_child_v2', 'assistant', now + 6000, now + 6000, JSON.stringify({
    agent: 'general',
    content: [{ type: 'text', text: '子代理在 v2 里的产出' }]
  }), seq);

  // —— ses_v2only：新代独有会话的提问（旧代读取器完全读不到的历史） ——
  seq = 1;
  insV2Message.run('msg_v2only_user', 'ses_v2only', 'user', now + 7000, now + 7000, JSON.stringify({
    text: 'User: 新代独有的提问',
    time: { created: now + 7000 }
  }), seq);

  // —— ses_legacyonly：旧代独有会话 ——
  insMessage.run('msg_legacyonly_user', 'ses_legacyonly', now + 8000, now + 8000, JSON.stringify({ role: 'user' }));
  insPart.run('p_legacyonly_user', 'msg_legacyonly_user', 'ses_legacyonly', now + 8000, now + 8000, JSON.stringify({ type: 'text', text: 'User: 旧代独有的提问' }));

  db.close();
}

function loadSessionReaderForHome(t, hostHome) {
  const previousRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHome;
  delete require.cache[require.resolve('../lib/sessions/session-reader')];
  const reader = require('../lib/sessions/session-reader');
  t.after(() => {
    if (previousRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = previousRealHome;
    delete require.cache[require.resolve('../lib/sessions/session-reader')];
  });
  return reader;
}

test('opencode 历史两代并集：同 id 新代优先、单代独有行兜底、标记类消息不渲染', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oc-v2-reader-'));
  seedDb(hostHome);
  const {
    readSessionMessages,
    readSessionLastModel,
    readProjectsFromHostByProviders
  } = loadSessionReaderForHome(t, hostHome);
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));

  const messages = readSessionMessages('opencode', { sessionId: 'ses_mixed' });
  const contents = messages.map((message) => message.content).join('\n---\n');

  // 旧代独有行（迁移前 WebUI 写入）兜底可见。
  assert.match(contents, /legacy 独有提问/, '旧代独有消息必须保留');
  // 两代同 id：取新代渲染，旧代冻结副本不重复出现。
  assert.match(contents, /v2 版本的回复/);
  assert.doesNotMatch(contents, /legacy 版本的回复/, '同 id 以新代为准');
  // 新代工具条目：name 字段 + state.content 产出，与旧代共用 :::tool 渲染。
  assert.match(contents, /:::tool\{name="read"\}/);
  assert.match(contents, /0x 文件内容/);
  assert.match(contents, /:::thinking\n先看目录/);
  // synthetic（自动续写）保持 user 展示口径；compaction 摘要不进时间线。
  const synthetic = messages.find((message) => /interrupted/.test(message.content));
  assert.ok(synthetic, 'synthetic 消息按旧代口径可见');
  assert.equal(synthetic.role, 'user');
  assert.doesNotMatch(contents, /自动压缩摘要不该出现/, 'compaction 是运行时标记');
  // 旧代 task 工具（output 空）回读的却是只存在于新代的子会话产出。
  assert.match(contents, /:::tool\{name="task"\}/);
  assert.match(contents, /子代理会话 ses_child_v2 的产出/);
  assert.match(contents, /子代理在 v2 里的产出/);
  // 时间序保持升序（跨两代合并后按消息时间排序）。
  const timestamps = messages.map((message) => Date.parse(message.timestamp));
  for (let index = 1; index < timestamps.length; index += 1) {
    assert.ok(timestamps[index] >= timestamps[index - 1], '消息保持时间升序');
  }
  // 两代同 id 的 assistant 模型取新代值。
  const shared = messages.find((message) => message.content.includes('v2 版本的回复'));
  assert.equal(shared.model, 'opencode-go/glm-5.2');

  // 会话面：新代独有的会话也能读历史（旧读取器完全读不到）。
  const v2OnlyMessages = readSessionMessages('opencode', { sessionId: 'ses_v2only' });
  assert.equal(v2OnlyMessages.length, 1);
  assert.equal(v2OnlyMessages[0].content, '新代独有的提问');

  // 会话模型：两代都有时取新代；单代会话各自兜底。
  assert.equal(readSessionLastModel('opencode', { sessionId: 'ses_mixed' }), 'opencode-go/glm-5.2');
  assert.equal(readSessionLastModel('opencode', { sessionId: 'ses_v2only' }), 'opencode/deepseek-v4.1-flash-free');
  assert.equal(readSessionLastModel('opencode', { sessionId: 'ses_legacyonly' }), 'opencode-go/old-model');

  // 会话列表：两代并集，归档/子会话过滤在合并之后（旧代冻结副本不能复活它们）。
  const projects = readProjectsFromHostByProviders(['opencode']);
  const allIds = projects.flatMap((project) => project.sessions.map((session) => session.id));
  assert.ok(allIds.includes('ses_mixed'));
  assert.ok(allIds.includes('ses_v2only'));
  assert.ok(allIds.includes('ses_legacyonly'));
  assert.ok(!allIds.includes('ses_child_v2'), '新代才有的子代理会话不进列表');
  assert.ok(!allIds.includes('ses_archived_shadow'), '新代归档不被旧代未归档副本复活');
});
