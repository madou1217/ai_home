'use strict';

/**
 * CodeBuddy 家族（codebuddy / codebuddycn / workbuddy / workbuddycn）会话读取适配器测试。
 *
 * 用临时目录构造四个 Provider 的宿主数据根，验证本轮的核心口径：
 *   1. 同一站点的两个产品（WorkBuddy + CodeBuddy）合并成**一份**地区历史；
 *   2. workbuddy / codebuddy 两个入口读到的是同一批会话（真正"打通"）；
 *   3. 读的是宿主地区目录，所以**切换选中账号不改变可见历史**；
 *   4. 国际站与国内站互不串味；
 *   5. ACP/CodeBuddy JSONL 能解析成 aih 统一的消息形态（含 thinking / tool 标记）；
 *   6. 展示层按会话 id 去重，同一批会话只出现一次。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  readProjectsFromHostByProviders,
  readSessionMessages,
  resolveSessionFilePath
} = require('../lib/sessions/session-reader');
const { buildProjectsSnapshot } = require('../lib/server/webui-project-cache');

// --- fixture -------------------------------------------------------------

// 一条最简的 ACP/CodeBuddy 记录序列：user → ai-title → reasoning → assistant
// → function_call → function_call_result。timestamp 是毫秒（原生形态）。
function buildSessionLines(options) {
  const {
    sessionId,
    cwd,
    userText,
    aiTitle,
    includeAiTitle = true,
    includeTools = true
  } = options;
  const base = 1789364428121;
  const lines = [
    {
      id: 'u1',
      timestamp: base,
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: `<system-reminder data-role="user-context">\nOS Version: darwin\n</system-reminder>\n${userText}`
      }],
      sessionId,
      cwd
    }
  ];
  if (includeAiTitle) {
    lines.push({ id: 't1', timestamp: base + 10, type: 'ai-title', aiTitle, sessionId, cwd });
  }
  lines.push({
    id: 'r1',
    timestamp: base + 20,
    type: 'reasoning',
    providerData: { model: 'deepseek-test-model' },
    content: [],
    rawContent: [{ type: 'reasoning_text', text: 'brief thought' }],
    sessionId,
    cwd
  });
  lines.push({
    id: 'a1',
    timestamp: base + 30,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'done' }],
    providerData: { model: 'deepseek-test-model' },
    sessionId,
    cwd
  });
  if (includeTools) {
    lines.push({
      id: 'c1',
      timestamp: base + 40,
      type: 'function_call',
      name: 'Bash',
      callId: 'call-1',
      arguments: '{"cmd":"ls"}',
      sessionId,
      cwd
    });
    lines.push({
      id: 'c2',
      timestamp: base + 50,
      type: 'function_call_result',
      name: 'Bash',
      callId: 'call-1',
      status: 'completed',
      output: { type: 'text', text: 'file-a\nfile-b' },
      sessionId,
      cwd
    });
  }
  lines.push({ id: 's1', timestamp: base + 60, type: 'file-history-snapshot', cwd, snapshot: {} });
  return lines.map((record) => JSON.stringify(record)).join('\n');
}

function writeSession(root, projectDirName, sessionId, options) {
  const projectDir = path.join(root, 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    buildSessionLines({ sessionId, ...options })
  );
  // 旁挂元数据：永远是会话消息之外的东西，必须被忽略。
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.meta.json`),
    JSON.stringify({ 'codebuddy.ai/hostKind': 'unopted', acpConnectionId: 'x' })
  );
  fs.writeFileSync(path.join(projectDir, `${sessionId}.file-rollback.ndjson`), '{"a":1}\n');
  return path.join(projectDir, `${sessionId}.jsonl`);
}

const WORKSPACE = { cnApp: '/tmp/aih-fixture/WorkBuddy-cn', cnCli: '/tmp/aih-fixture/codebuddy-cn' };

function createFixture() {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-reader-'));
  const hostHomeDir = path.join(aiHomeDir, 'host');
  fs.mkdirSync(hostHomeDir, { recursive: true });

  // 国内站：WorkBuddy.app 数据根 + CodeBuddy CN 根，两个产品各写一条会话。
  const cnWorkbuddy = writeSession(
    path.join(hostHomeDir, '.workbuddy'),
    'Users-model-WorkBuddy-cn',
    'cn-workbuddy-session',
    { cwd: WORKSPACE.cnApp, userText: 'cn workbuddy question', aiTitle: 'CN WorkBuddy session' }
  );
  const cnCodebuddy = writeSession(
    path.join(hostHomeDir, '.codebuddy-cn'),
    'tmp-aih-fixture-codebuddy-cn',
    'cn-codebuddy-session',
    { cwd: WORKSPACE.cnCli, userText: 'cn codebuddy question', includeAiTitle: false }
  );

  // 国际站：WorkBuddy AI.app 数据根 + CodeBuddy 根。
  const intlWorkbuddy = writeSession(
    path.join(hostHomeDir, '.workbuddy-ai'),
    'Users-model-WorkBuddy-ai',
    'intl-workbuddy-session',
    { cwd: '/tmp/aih-fixture/WorkBuddy-ai', userText: 'intl workbuddy question', aiTitle: 'Intl WorkBuddy session' }
  );
  const intlCodebuddy = writeSession(
    path.join(hostHomeDir, '.codebuddy'),
    'tmp-aih-fixture-codebuddy',
    'intl-codebuddy-session',
    { cwd: '/tmp/aih-fixture/codebuddy', userText: 'intl codebuddy question', aiTitle: 'Intl CodeBuddy session' }
  );

  return {
    aiHomeDir,
    hostHomeDir,
    paths: { cnWorkbuddy, cnCodebuddy, intlWorkbuddy, intlCodebuddy }
  };
}

function writeCodebuddySessionDatabase(root, rows) {
  const db = new DatabaseSync(path.join(root, 'workbuddy.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    title TEXT,
    custom_title TEXT,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER
  )`);
  const insert = db.prepare(
    'INSERT INTO sessions (id, cwd, title, custom_title, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.cwd,
      row.title || null,
      row.customTitle || null,
      row.updatedAt,
      row.lastActivityAt || null
    );
  }
  db.close();
}

function collectSessionIds(projects) {
  return projects.flatMap((project) => project.sessions.map((session) => session.id)).sort();
}

// --- 1. 按地区合并 -------------------------------------------------------

test('domestic region merges the WorkBuddy and CodeBuddy roots into one history', () => {
  const fixture = createFixture();
  const projects = readProjectsFromHostByProviders(['codebuddycn'], { hostHomeDir: fixture.hostHomeDir });

  // 两个数据根各一条会话，合并后是同一份历史。
  assert.deepEqual(collectSessionIds(projects), ['cn-codebuddy-session', 'cn-workbuddy-session']);
  // 项目路径取自记录里的 cwd，而不是目录名。
  const paths = projects.map((project) => project.path).sort();
  assert.deepEqual(paths, [WORKSPACE.cnApp, WORKSPACE.cnCli].sort());
});

test('international region merges its own two roots and never leaks the domestic one', () => {
  const fixture = createFixture();
  const projects = readProjectsFromHostByProviders(['codebuddy'], { hostHomeDir: fixture.hostHomeDir });
  assert.deepEqual(collectSessionIds(projects), ['intl-codebuddy-session', 'intl-workbuddy-session']);
  // 国内站的会话不出现在国际站列表里。
  const titles = projects.flatMap((project) => project.sessions.map((session) => session.title));
  assert.equal(titles.some((title) => String(title).includes('CN WorkBuddy')), false);
});

// --- 2. 同一地区两个入口读到同一批会话（打通） ----------------------------

test('both providers of a region expose the identical unified history', () => {
  const fixture = createFixture();
  const cn = readProjectsFromHostByProviders(['codebuddycn'], { hostHomeDir: fixture.hostHomeDir });
  const cnWorkbuddy = readProjectsFromHostByProviders(['workbuddycn'], { hostHomeDir: fixture.hostHomeDir });
  const intl = readProjectsFromHostByProviders(['codebuddy'], { hostHomeDir: fixture.hostHomeDir });
  const intlWorkbuddy = readProjectsFromHostByProviders(['workbuddy'], { hostHomeDir: fixture.hostHomeDir });

  assert.deepEqual(collectSessionIds(cnWorkbuddy), collectSessionIds(cn));
  assert.deepEqual(collectSessionIds(intlWorkbuddy), collectSessionIds(intl));
  assert.deepEqual(collectSessionIds(cn), ['cn-codebuddy-session', 'cn-workbuddy-session']);
});

// --- 3. 切换账号不改变可见历史 -------------------------------------------

test('switching the selected account does not change the visible history', () => {
  const fixture = createFixture();
  const forAccount = (accountRef) => readProjectsFromHostByProviders(['workbuddycn'], {
    hostHomeDir: fixture.hostHomeDir,
    aiHomeDir: fixture.aiHomeDir,
    accountRef
  });
  const first = forAccount('acct_aaaaaaaaaaaaaaaaaaaa');
  const second = forAccount('acct_bbbbbbbbbbbbbbbbbbbb');
  // 读的是宿主地区目录而不是账号沙箱：换个账号选中的会话列表完全一致。
  assert.deepEqual(collectSessionIds(second), collectSessionIds(first));
  assert.deepEqual(first.map((project) => project.path).sort(), second.map((project) => project.path).sort());
});

// --- 4. 会话文件定位跨 Provider 生效 --------------------------------------

test('a session found through one provider of the region resolves for the other', () => {
  const fixture = createFixture();
  // 会话由 WorkBuddy.app 产生，但从 codebuddycn 入口续聊也能定位到同一个文件。
  assert.equal(
    resolveSessionFilePath('codebuddycn', { sessionId: 'cn-workbuddy-session' }, { hostHomeDir: fixture.hostHomeDir }),
    fixture.paths.cnWorkbuddy
  );
  assert.equal(
    resolveSessionFilePath('workbuddycn', { sessionId: 'cn-codebuddy-session' }, { hostHomeDir: fixture.hostHomeDir }),
    fixture.paths.cnCodebuddy
  );
  // 跨地区不解析：国内站的会话用国际站入口找不到。
  assert.equal(
    resolveSessionFilePath('codebuddy', { sessionId: 'cn-workbuddy-session' }, { hostHomeDir: fixture.hostHomeDir }),
    ''
  );
});

// --- 5. 消息解析 ----------------------------------------------------------

test('ACP records map onto the shared message shape', () => {
  const fixture = createFixture();
  const messages = readSessionMessages('workbuddycn', {
    sessionId: 'cn-workbuddy-session',
    projectDirName: 'Users-model-WorkBuddy-cn'
  }, { hostHomeDir: fixture.hostHomeDir });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
  // system-reminder 前导块必须被剥离，只留用户真正说的话。
  assert.equal(messages[0].content, 'cn workbuddy question');
  assert.match(messages[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  const assistant = messages[1];
  assert.equal(assistant.model, 'deepseek-test-model');
  assert.match(assistant.content, /:::thinking\nbrief thought\n:::/);
  assert.match(assistant.content, /:::tool\{name="Bash"\}/);
  assert.match(assistant.content, /:::tool-result\nfile-a\nfile-b\n:::/);
  assert.match(assistant.content, /done/);
});

test('the session title prefers ai-title and falls back to the first user message', () => {
  const fixture = createFixture();
  const projects = readProjectsFromHostByProviders(['codebuddycn'], { hostHomeDir: fixture.hostHomeDir });
  const titles = Object.fromEntries(
    projects.flatMap((project) => project.sessions.map((session) => [session.id, session.title]))
  );
  assert.equal(titles['cn-workbuddy-session'], 'CN WorkBuddy session');
  // 没有 ai-title 记录的会话也不能被丢掉：退回首条用户消息。
  assert.equal(titles['cn-codebuddy-session'], 'cn codebuddy question');
});

test('native WorkBuddy metadata overrides JSONL title and activity time', () => {
  const fixture = createFixture();
  writeCodebuddySessionDatabase(path.join(fixture.hostHomeDir, '.workbuddy'), [{
    id: 'cn-workbuddy-session',
    cwd: WORKSPACE.cnApp,
    title: 'database title',
    customTitle: 'renamed from WorkBuddy',
    updatedAt: 1789364430999,
    lastActivityAt: 1789364430888
  }]);

  const session = readProjectsFromHostByProviders(['workbuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  }).flatMap((project) => project.sessions)
    .find((item) => item.id === 'cn-workbuddy-session');

  assert.equal(session.title, 'renamed from WorkBuddy');
  assert.equal(session.updatedAt, 1789364430888);
});

test('database title falls back from custom_title to title and JSONL remains the no-database fallback', () => {
  const fixture = createFixture();
  writeCodebuddySessionDatabase(path.join(fixture.hostHomeDir, '.workbuddy'), [{
    id: 'cn-workbuddy-session',
    cwd: WORKSPACE.cnApp,
    title: 'database generated title',
    updatedAt: 1789364431999,
    lastActivityAt: 1789364431888
  }]);

  const projects = readProjectsFromHostByProviders(['workbuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  });
  const sessions = Object.fromEntries(
    projects.flatMap((project) => project.sessions).map((session) => [session.id, session])
  );
  assert.equal(sessions['cn-workbuddy-session'].title, 'database generated title');
  assert.equal(sessions['cn-workbuddy-session'].updatedAt, 1789364431888);
  // 该数据根没有数据库，JSONL 标题继续作为兼容回退。
  assert.equal(sessions['cn-codebuddy-session'].title, 'cn codebuddy question');
});

test('new JSONL activity remains visible when the desktop database has not caught up', () => {
  const fixture = createFixture();
  writeCodebuddySessionDatabase(path.join(fixture.hostHomeDir, '.workbuddy'), [{
    id: 'cn-workbuddy-session', cwd: WORKSPACE.cnApp, title: 'database title',
    updatedAt: 1789369999999, lastActivityAt: 1789364428000
  }]);
  const session = readProjectsFromHostByProviders(['workbuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  }).flatMap((project) => project.sessions).find((item) => item.id === 'cn-workbuddy-session');
  assert.equal(session.updatedAt, 1789364428181);
});

test('a dated task uses database title and cwd even without JSONL project metadata', () => {
  const fixture = createFixture();
  const cwd = path.join(fixture.hostHomeDir, 'WorkBuddy AI', '2026-09-15-18-52-42');
  fs.writeFileSync(fixture.paths.intlWorkbuddy, JSON.stringify({
    type: 'message', role: 'user', timestamp: 1789364428000,
    content: [{ type: 'input_text', text: 'initial prompt' }]
  }));
  writeCodebuddySessionDatabase(path.join(fixture.hostHomeDir, '.workbuddy-ai'), [{
    id: 'intl-workbuddy-session', cwd, title: 'generated title', customTitle: '我的任务',
    updatedAt: 1789364430000, lastActivityAt: 1789364429000
  }]);
  const project = readProjectsFromHostByProviders(['codebuddy'], {
    hostHomeDir: fixture.hostHomeDir
  }).find((item) => item.sessions.some((session) => session.id === 'intl-workbuddy-session'));
  assert.equal(project.name, '我的任务');
  assert.equal(project.path, cwd);
  assert.equal(project.sessions[0].updatedAt, 1789364429000);
});

test('unreadable and older native databases preserve JSONL compatibility', () => {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.hostHomeDir, '.workbuddy', 'workbuddy.db'), 'invalid sqlite');
  const db = new DatabaseSync(path.join(fixture.hostHomeDir, '.workbuddy-ai', 'workbuddy.db'));
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)');
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)')
      .run('intl-workbuddy-session', 'older native title');
  } finally {
    db.close();
  }
  const sessions = readProjectsFromHostByProviders(['workbuddycn', 'workbuddy'], {
    hostHomeDir: fixture.hostHomeDir
  }).flatMap((project) => project.sessions);
  assert.equal(sessions.find((session) => session.id === 'cn-workbuddy-session').title, 'CN WorkBuddy session');
  assert.equal(sessions.find((session) => session.id === 'intl-workbuddy-session').title, 'older native title');
  assert.equal(sessions.find((session) => session.id === 'intl-workbuddy-session').updatedAt, 1789364428181);
});

test('CLI titles track later renames, incomplete append and transcript replacement', () => {
  const fixture = createFixture();
  const sessionPath = fixture.paths.cnWorkbuddy;
  const read = () => readProjectsFromHostByProviders(['codebuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  }).flatMap((project) => project.sessions).find((item) => item.id === 'cn-workbuddy-session');
  assert.equal(read().title, 'CN WorkBuddy session');
  fs.appendFileSync(sessionPath, `\n${JSON.stringify({ type: 'custom-title', customTitle: '第一次改名' })}\n`);
  // 改名后还有大段工具输出，标题不一定在头部或 64KB 的尾部。
  fs.appendFileSync(sessionPath, `${JSON.stringify({ type: 'function_call_result', output: 'x'.repeat(128 * 1024) })}\n`);
  assert.equal(read().title, '第一次改名');
  fs.appendFileSync(sessionPath, '{"type":"custom-title","customTitle":"第二次');
  assert.equal(read().title, '第一次改名');
  fs.appendFileSync(sessionPath, '改名"}\n');
  assert.equal(read().title, '第二次改名');
  fs.writeFileSync(sessionPath, JSON.stringify({ type: 'ai-title', aiTitle: '替换后的会话标题', cwd: WORKSPACE.cnApp }));
  assert.equal(read().title, '替换后的会话标题');
});

test('session ordering uses the last native JSONL timestamp before file mtime', () => {
  const fixture = createFixture();
  const sessionPath = fixture.paths.cnWorkbuddy;
  // 恢复/复制后的 mtime 不再反映对话时间，原生记录仍是真值。
  const staleMtime = new Date(1700000000000);
  fs.utimesSync(sessionPath, staleMtime, staleMtime);

  const projects = readProjectsFromHostByProviders(['workbuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  });
  const session = projects
    .flatMap((project) => project.sessions)
    .find((item) => item.id === 'cn-workbuddy-session');

  assert.equal(session.updatedAt, 1789364428181);
});

test('native activity survives long tool records and an unfinished trailing JSONL line', () => {
  const fixture = createFixture();
  const sessionPath = fixture.paths.cnWorkbuddy;
  const timestamp = '2026-09-16T08:30:00.123Z';
  fs.appendFileSync(sessionPath, `\n${JSON.stringify({
    type: 'function_call_result', timestamp,
    output: { type: 'text', text: 'x'.repeat(256 * 1024) }
  })}\n{"type":"message","timestamp":`);
  const session = readProjectsFromHostByProviders(['codebuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  }).flatMap((project) => project.sessions).find((item) => item.id === 'cn-workbuddy-session');

  assert.equal(session.updatedAt, Date.parse(timestamp));
});

test('native numeric-string timestamps take precedence and invalid records use mtime as a fallback', () => {
  const fixture = createFixture();
  fs.writeFileSync(fixture.paths.cnWorkbuddy, JSON.stringify({
    type: 'message', role: 'user', timestamp: '1789364429000',
    cwd: WORKSPACE.cnApp, content: [{ type: 'input_text', text: 'valid native time' }]
  }));
  fs.writeFileSync(fixture.paths.cnCodebuddy, JSON.stringify({
    type: 'message', role: 'user', timestamp: 'not-a-date',
    cwd: WORKSPACE.cnCli, content: [{ type: 'input_text', text: 'missing native time' }]
  }));
  const fallbackTime = new Date(1789364428000);
  fs.utimesSync(fixture.paths.cnCodebuddy, fallbackTime, fallbackTime);
  const sessions = Object.fromEntries(readProjectsFromHostByProviders(['workbuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  }).flatMap((project) => project.sessions).map((session) => [session.id, session]));

  assert.equal(sessions['cn-workbuddy-session'].updatedAt, 1789364429000);
  assert.equal(sessions['cn-codebuddy-session'].updatedAt, fallbackTime.getTime());
});

test('a WorkBuddy dated task is displayed by its clean session title while retaining its path', () => {
  const fixture = createFixture();
  const cwd = path.join(fixture.hostHomeDir, 'WorkBuddy', '2026-09-15-16-08-49');
  const projectDirName = 'Users-model-WorkBuddy-2026-09-15-16-08-49';
  writeSession(path.join(fixture.hostHomeDir, '.workbuddy'), projectDirName, 'dated-task', {
    cwd, userText: '<user_query>整理今日工作\n和项目进度</user_query>', includeAiTitle: false
  });
  const project = readProjectsFromHostByProviders(['codebuddycn'], {
    hostHomeDir: fixture.hostHomeDir
  }).find((item) => item.id === projectDirName);

  assert.equal(project.path, cwd);
  assert.equal(project.name, '整理今日工作 和项目进度');
  assert.equal(project.sessions[0].title, '整理今日工作 和项目进度');
  const messages = readSessionMessages('workbuddycn', { sessionId: 'dated-task', projectDirName }, {
    hostHomeDir: fixture.hostHomeDir
  });
  assert.equal(messages[0].content, '整理今日工作\n和项目进度');
});

test('an ordinary project retains its directory name even when it looks like a date', () => {
  const fixture = createFixture();
  const cwd = path.join(fixture.hostHomeDir, 'repo', '2026-09-15-16-08-49');
  writeSession(path.join(fixture.hostHomeDir, '.workbuddy-ai'), 'ordinary-dated-project', 'ordinary-task', {
    cwd, userText: '普通工程', aiTitle: '独立会话标题'
  });
  const project = readProjectsFromHostByProviders(['workbuddy'], {
    hostHomeDir: fixture.hostHomeDir
  }).find((item) => item.id === 'ordinary-dated-project');

  assert.equal(project.name, path.basename(cwd));
  assert.equal(project.sessions[0].title, '独立会话标题');
});

// --- 6. 展示层去重 --------------------------------------------------------

test('the project snapshot reports a shared region store exactly once', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-snapshot-'));
  const projectPath = path.join(aiHomeDir, 'workspace');
  fs.mkdirSync(projectPath, { recursive: true });

  const session = {
    id: 'shared-session',
    title: 'shared session',
    updatedAt: 1789364428121,
    projectDirName: 'workspace',
    provider: 'codebuddycn'
  };
  // 同一份地区会话被两个 Provider 各报一次。
  const hostProjects = [
    { id: 'workspace', name: 'workspace', path: projectPath, provider: 'codebuddycn', sessions: [session] },
    { id: 'workspace', name: 'workspace', path: projectPath, provider: 'workbuddycn', sessions: [{ ...session, provider: 'workbuddycn' }] }
  ];

  const snapshot = buildProjectsSnapshot(hostProjects, { fs, aiHomeDir }, {});
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0].providers.slice().sort(), ['codebuddycn', 'workbuddycn']);
  // 会话只出现一次，目录 Provider 身份保持稳定，续聊可选择同地区的运行账号。
  assert.equal(snapshot[0].sessions.length, 1);
  assert.equal(snapshot[0].sessions[0].id, 'shared-session');
  assert.equal(snapshot[0].sessions[0].provider, 'codebuddycn');
});

test('a refreshed shared session updates activity without changing its directory identity', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-snapshot-'));
  const projectPath = path.join(aiHomeDir, 'workspace');
  fs.mkdirSync(projectPath, { recursive: true });
  const previous = { id: 'shared-session', title: 'older title', updatedAt: 1789364428121 };
  const latest = { ...previous, title: 'renamed after resume', updatedAt: 1789364528121 };
  const projects = [
    { id: 'cli-dir', name: 'workspace', path: projectPath, provider: 'codebuddycn', sessions: [previous] },
    { id: 'app-dir', name: 'workspace', path: projectPath, provider: 'workbuddycn', sessions: [latest] }
  ];
  const [snapshot] = buildProjectsSnapshot(projects, { fs, aiHomeDir });
  assert.deepEqual(snapshot.sessions, [{
    ...latest,
    provider: 'codebuddycn',
    projectDirName: 'cli-dir',
    projectPath
  }]);
  assert.equal(snapshot.sessionTotal, 1);
  const [reversed] = buildProjectsSnapshot([...projects].reverse(), { fs, aiHomeDir });
  assert.equal(reversed.sessions[0].updatedAt, latest.updatedAt);
  assert.equal(reversed.sessions[0].title, latest.title);
  assert.equal(reversed.sessions[0].provider, 'workbuddycn');
});
