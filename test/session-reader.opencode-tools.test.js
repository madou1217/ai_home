const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { ensureOpenCodeSessionTestSchema, openOpenCodeDb } = require('../lib/sessions/opencode-session-store');

// opencode 历史 tool part 渲染 + Task 子代理产出回读 + 子会话列表过滤。
// 背景:opencode 历史 reader 此前只渲染 text/reasoning、把 tool part 全丢了 → 并行 Task 子代理
// 在父会话里完全不可见("看着没处理完");且被断连中断的 task part output 为空,需要回读子会话产出。

function seedDb(hostHome) {
  fs.mkdirSync(path.join(hostHome, '.local', 'share', 'opencode'), { recursive: true });
  ensureOpenCodeSessionTestSchema(hostHome);
  const db = openOpenCodeDb(hostHome, { readOnly: false });
  const now = Date.now();
  const insSession = db.prepare(`
    INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, model)
    VALUES (?, 'proj', ?, ?, '/tmp/demo', ?, '1', ?, ?, ?)
  `);
  insSession.run('ses_parent', null, 'parent', '父会话', now, now, JSON.stringify({ id: 'glm-5.2', providerID: 'opencode-go' }));
  insSession.run('ses_child', 'ses_parent', 'child', 'Review lib (@general subagent)', now, now, null);

  const insMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');

  // 父会话:user 提问 + assistant(text + read 工具 + 被中断的 task 工具)
  insMessage.run('m_u', 'ses_parent', now, now, JSON.stringify({
    role: 'user',
    model: { providerID: 'opencode-go', modelID: 'glm-5.2' }
  }));
  insPart.run('p_u', 'm_u', 'ses_parent', now, now, JSON.stringify({ type: 'text', text: 'review 这个项目' }));

  insMessage.run('m_a', 'ses_parent', now + 1, now + 1, JSON.stringify({
    role: 'assistant',
    providerID: 'opencode-go',
    modelID: 'glm-5.2'
  }));
  insPart.run('p_t', 'm_a', 'ses_parent', now + 1, now + 1, JSON.stringify({ type: 'text', text: '让我用并行任务 review。' }));
  insPart.run('p_read', 'm_a', 'ses_parent', now + 2, now + 2, JSON.stringify({
    type: 'tool', tool: 'read', callID: 'c1',
    state: { status: 'completed', input: { filePath: '/tmp/demo' }, output: '<entries>lib/ test/</entries>', metadata: {}, title: 'demo' }
  }));
  insPart.run('p_task', 'm_a', 'ses_parent', now + 3, now + 3, JSON.stringify({
    type: 'tool', tool: 'task', callID: 'c2',
    // 被断连中断:status 停在 running、output 空——需回读子会话产出。
    state: { status: 'running', input: { description: 'Review lib 核心模块', prompt: '深入 review lib/' }, metadata: { parentSessionId: 'ses_parent', sessionId: 'ses_child' }, title: 'Review lib 核心模块' }
  }));

  // 子会话:子代理产出了完整报告
  insMessage.run('m_c', 'ses_child', now + 10, now + 10, JSON.stringify({ role: 'assistant' }));
  // 子代理按 opencode 任务模板包裹回复——渲染时应剥掉 <task_result>/</task> 包装标签。
  insPart.run('p_c', 'm_c', 'ses_child', now + 10, now + 10, JSON.stringify({ type: 'text', text: '子代理审查报告:lib/ 结构清晰,发现 2 处可优化。\n</task_result>\n</task>' }));

  db.close();
}

test('opencode 历史渲染 tool part,task 中断时回读子代理产出,子会话不进列表', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oc-tools-'));
  const prevRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHome;
  // REAL_HOME 变了,清掉 session-reader 的模块缓存重新加载。
  delete require.cache[require.resolve('../lib/sessions/session-reader')];
  const { readSessionMessages, readProjectsFromHostByProviders } = require('../lib/sessions/session-reader');
  t.after(() => {
    if (prevRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = prevRealHome;
    delete require.cache[require.resolve('../lib/sessions/session-reader')];
    fs.rmSync(hostHome, { recursive: true, force: true });
  });

  seedDb(hostHome);

  const messages = readSessionMessages('opencode', { sessionId: 'ses_parent' });
  const rereadMessages = readSessionMessages('opencode', { sessionId: 'ses_parent' });
  assert.notStrictEqual(
    rereadMessages,
    messages,
    'OpenCode SQLite history must bypass transcript stat caching because WAL writes do not reliably change the main DB file'
  );
  const assistant = messages.find((m) => m.role === 'assistant');
  const user = messages.find((m) => m.role === 'user');
  assert.ok(assistant, '父会话 assistant 消息在');
  assert.equal(user.model, 'opencode-go/glm-5.2');
  assert.equal(assistant.model, 'opencode-go/glm-5.2');
  // 普通工具:与实时流一致的 :::tool/:::tool-result 标签
  assert.match(assistant.content, /:::tool\{name="read"\}/);
  assert.match(assistant.content, /<entries>lib\/ test\/<\/entries>/);
  // task 工具:卡片在 + 中断时回读到了子代理的报告
  assert.match(assistant.content, /:::tool\{name="task"\}/);
  assert.match(assistant.content, /Review lib 核心模块/);
  assert.match(assistant.content, /子代理会话 ses_child 的产出/);
  assert.match(assistant.content, /子代理审查报告:lib\/ 结构清晰/);
  // 任务模板包装标签被剥掉,不再有裸露的未闭合 </task_result>/</task>
  assert.doesNotMatch(assistant.content, /<\/task(_result)?>/);

  // 子会话(parent_id 非空)不作为顶层会话出现在列表
  const projects = readProjectsFromHostByProviders(['opencode']);
  const allIds = projects.flatMap((p) => p.sessions.map((s) => s.id));
  assert.ok(allIds.includes('ses_parent'));
  assert.ok(!allIds.includes('ses_child'), '子代理会话被过滤');
});
