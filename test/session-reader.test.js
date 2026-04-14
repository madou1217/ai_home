const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const sessionReader = require('../lib/sessions/session-reader');

test('readSessionMessages reads codex session messages without full file utf8 read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadFileSync = fs.readFileSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '019c9889-13a4-7191-a40d-94c83b91bd72';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '02', '26');
    const sessionFile = path.join(sessionDir, `rollout-2026-02-26T14-00-46-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      JSON.stringify({
        id: sessionId,
        thread_name: '查阅文档需求内容内容无法重复 maybe',
        updated_at: '2026-02-26T14:00:46.000Z'
      }) + '\n'
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-02-26T14:00:46.000Z',
          type: 'session_meta',
          payload: {
            id: sessionId,
            cwd: '/Users/model/projects/edu-en'
          }
        }),
        JSON.stringify({
          timestamp: '2026-02-26T14:00:47.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '查一下这个项目的文档'
          }
        }),
        JSON.stringify({
          timestamp: '2026-02-26T14:00:48.000Z',
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [
              { type: 'output_text', text: '我先看一下项目结构。' }
            ]
          }
        })
      ].join('\n') + '\n'
    );

    fs.readFileSync = function patchedReadFileSync(targetPath, ...args) {
      if (targetPath === sessionFile && args[0] === 'utf8') {
        const error = new Error('Cannot create a string longer than 0x1fffffe8 characters');
        error.code = 'ERR_STRING_TOO_LONG';
        throw error;
      }
      return originalReadFileSync.call(this, targetPath, ...args);
    };

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((item) => ({ role: item.role, content: item.content })),
      [
        { role: 'user', content: '查一下这个项目的文档' },
        { role: 'assistant', content: '我先看一下项目结构。' }
      ]
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost keeps codex session projects even when config.toml registered project list is incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-projects-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const keptProject = path.join(root, 'kept-project');
    const removedProject = path.join(root, 'removed-project');
    fs.ensureDirSync(keptProject);
    fs.ensureDirSync(removedProject);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '12'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      `[projects."${keptProject}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );

    const keptSessionId = '11111111-1111-4111-8111-111111111111';
    const removedSessionId = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({ id: keptSessionId, thread_name: '保留项目会话', updated_at: '2026-04-12T10:00:00.000Z' }),
        JSON.stringify({ id: removedSessionId, thread_name: '被移除项目会话', updated_at: '2026-04-12T11:00:00.000Z' })
      ].join('\n') + '\n',
      'utf8'
    );

    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-12T10-00-00-${keptSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-12T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: keptSessionId, cwd: keptProject }
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-12T11-00-00-${removedSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-12T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: removedSessionId, cwd: removedProject }
      }) + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    assert.equal(projects.some((project) => project.path === keptProject), true);
    assert.equal(projects.some((project) => project.path === removedProject), true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost ignores codex worktree sessions but keeps unrelated real projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-worktree-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProject = path.join(root, 'real-project');
    const worktreeProject = path.join(root, '.codex', 'worktrees', 'abcd', 'real-project');
    fs.ensureDirSync(realProject);
    fs.ensureDirSync(worktreeProject);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '13'));

    const realSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const worktreeSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({ id: realSessionId, thread_name: '真实项目会话', updated_at: '2026-04-13T10:00:00.000Z' }),
        JSON.stringify({ id: worktreeSessionId, thread_name: 'worktree 项目会话', updated_at: '2026-04-13T11:00:00.000Z' })
      ].join('\n') + '\n',
      'utf8'
    );

    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '13');
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-13T10-00-00-${realSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: realSessionId, cwd: realProject }
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-13T11-00-00-${worktreeSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: worktreeSessionId, cwd: worktreeProject }
      }) + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    assert.equal(projects.some((project) => project.path === realProject), true);
    assert.equal(projects.some((project) => project.path === worktreeProject), false);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost falls back to first codex user message when session_index thread_name is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-title-fallback-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectPath = path.join(root, 'feature-project');
    fs.ensureDirSync(projectPath);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '12'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      `[projects."${projectPath}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );

    const sessionId = '33333333-4444-4555-8666-777777777777';
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      JSON.stringify({ id: sessionId, updated_at: '2026-04-12T10:00:00.000Z' }) + '\n',
      'utf8'
    );

    const sessionFile = path.join(root, '.codex', 'sessions', '2026', '04', '12', `rollout-2026-04-12T10-00-00-${sessionId}.jsonl`);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: sessionId, cwd: projectPath }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'E2E transcript check: reply with exactly OK.' }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.path === projectPath);
    assert.ok(project);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].id, sessionId);
    assert.equal(project.sessions[0].title, 'E2E transcript check: reply with exactly OK.');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost reuses cached codex metadata when session files are unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-cache-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalOpenSync = fs.openSync;
  process.env.REAL_HOME = root;

  try {
    const projectPath = path.join(root, 'cached-project');
    fs.ensureDirSync(projectPath);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '13'));

    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const sessionIndexPath = path.join(root, '.codex', 'session_index.jsonl');
    const sessionFile = path.join(
      root,
      '.codex',
      'sessions',
      '2026',
      '04',
      '13',
      `rollout-2026-04-13T12-00-00-${sessionId}.jsonl`
    );
    fs.writeFileSync(
      sessionIndexPath,
      JSON.stringify({
        id: sessionId,
        thread_name: '缓存命中会话',
        updated_at: '2026-04-13T12:00:00.000Z'
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectPath }
      }) + '\n',
      'utf8'
    );

    const firstProjects = sessionReader.readAllProjectsFromHost();
    assert.equal(firstProjects.some((project) => project.path === projectPath), true);

    fs.openSync = function patchedOpenSync(targetPath, ...args) {
      if (targetPath === sessionIndexPath || targetPath === sessionFile) {
        throw new Error('unchanged codex metadata should come from cache');
      }
      return originalOpenSync.call(this, targetPath, ...args);
    };

    const secondProjects = sessionReader.readAllProjectsFromHost();
    assert.equal(secondProjects.some((project) => project.path === projectPath), true);
  } finally {
    fs.openSync = originalOpenSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost uses codex global state workspace roots to recover claude project path hints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-global-state-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'workspace-demo');
    const sanitizedDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeProjectDir = path.join(root, '.claude', 'projects', sanitizedDirName);
    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(claudeProjectDir);
    fs.ensureDirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': [realProjectPath]
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(claudeProjectDir, 'demo-session.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-12T10:00:00.000Z',
        message: {
          content: '使用 codex global state 里的 workspace root 恢复路径'
        }
      }) + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'claude');
    assert.ok(project);
    assert.equal(project.path, realProjectPath);
    assert.equal(project.name, path.basename(realProjectPath));
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost prefers claude transcript cwd over sanitized path guessing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-cwd-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'demo.v2-app');
    const sanitizedDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeProjectDir = path.join(root, '.claude', 'projects', sanitizedDirName);
    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(claudeProjectDir);
    fs.writeFileSync(
      path.join(claudeProjectDir, 'demo-session.jsonl'),
      [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: realProjectPath,
          session_id: 'demo-session'
        }),
        JSON.stringify({
          type: 'user',
          cwd: realProjectPath,
          timestamp: '2026-04-14T12:00:00.000Z',
          message: {
            content: '优先使用 transcript cwd'
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'claude');
    assert.ok(project);
    assert.equal(project.path, realProjectPath);
    assert.equal(project.name, path.basename(realProjectPath));
    assert.equal(project.sessions[0].projectDirName, sanitizedDirName);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost repairs claude mixed transcripts so resume-visible main thread survives', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-repair-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-repair-demo');
    const sanitizedDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeProjectDir = path.join(root, '.claude', 'projects', sanitizedDirName);
    const sessionId = 'demo-session';
    const sessionPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);
    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(claudeProjectDir);
    fs.ensureDirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': [realProjectPath]
      }),
      'utf8'
    );
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          isSidechain: true,
          timestamp: '2026-04-14T10:00:00.000Z',
          message: { content: 'Warmup' }
        }),
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          timestamp: '2026-04-14T10:00:01.000Z',
          message: { content: [{ type: 'text', text: 'sidechain warmup' }] }
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          timestamp: '2026-04-14T10:00:02.000Z',
          message: { content: '真实主线程问题' }
        }),
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          timestamp: '2026-04-14T10:00:03.000Z',
          message: { content: [{ type: 'text', text: '主线程回复' }] }
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: true,
          timestamp: '2026-04-14T10:00:04.000Z',
          message: { content: 'subagent details' }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'claude');
    assert.ok(project);
    assert.equal(project.path, realProjectPath);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].title, '真实主线程问题');

    const repairedContent = fs.readFileSync(sessionPath, 'utf8');
    assert.doesNotMatch(repairedContent, /"isSidechain":true/);

    const messages = sessionReader.readSessionMessages('claude', {
      sessionId,
      projectDirName: sanitizedDirName
    });
    assert.deepEqual(
      messages.map((item) => ({ role: item.role, content: item.content })),
      [
        { role: 'user', content: '真实主线程问题' },
        { role: 'assistant', content: '主线程回复' }
      ]
    );
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost includes codex workspace roots from global state even without session files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-workspace-roots-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectA = path.join(root, 'workspace-a');
    const projectB = path.join(root, 'workspace-b');
    fs.ensureDirSync(projectA);
    fs.ensureDirSync(projectB);
    fs.ensureDirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      `[projects."${projectA}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(root, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'project-order': [projectB],
        'active-workspace-roots': [projectA]
      }),
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const paths = projects
      .filter((item) => item.provider === 'codex')
      .map((item) => item.path);

    assert.equal(paths.includes(projectA), true);
    assert.equal(paths.includes(projectB), true);
    const project = projects.find((item) => item.path === projectB);
    assert.ok(project);
    assert.deepEqual(project.sessions, []);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages strips codex exec_command noise and keeps only real output text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-output-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T12-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T12:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_exec_build',
            arguments: JSON.stringify({
              cmd: 'npm run web:build',
              workdir: '/Users/model/projects/feature/ai_home'
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            name: 'exec_command',
            call_id: 'call_exec_build',
            output: [
              'Chunk ID: 0bbc4e',
              'Wall time: 1.0022 seconds',
              'Process running with session ID 44030',
              'Original token count: 26',
              'Output:',
              '',
              '> ai_home@1.0.0 web:build',
              '> cd web && npm run build',
              '',
              'Chunk ID: a4b588',
              'Wall time: 1.0019 seconds',
              'Process running with session ID 53604',
              'Original token count: 0',
              'Output:'
            ].join('\n')
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="Terminal"\}/);
    assert.match(messages[0].content, /npm run web:build/);
    assert.match(messages[0].content, /> ai_home@1\.0\.0 web:build/);
    assert.doesNotMatch(messages[0].content, /Chunk ID:/);
    assert.doesNotMatch(messages[0].content, /Wall time:/);
    assert.doesNotMatch(messages[0].content, /Original token count:/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages merges codex assistant tool calls into one assistant message and skips transient tool noise', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-merge-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T13-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T13:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '继续处理聊天 UI' }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:01.000Z',
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: '我先定位消息卡片和样式文件。' }]
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_read_bubble',
            arguments: JSON.stringify({
              cmd: 'sed -n \'1,220p\' "/Users/model/projects/feature/ai_home/web/src/components/chat/MessageBubble.tsx"',
              workdir: '/Users/model/projects/feature/ai_home'
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            name: 'exec_command',
            call_id: 'call_read_bubble',
            output: 'Output:\nimport { memo } from \'react\';'
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'write_stdin',
            call_id: 'call_poll_noise',
            arguments: JSON.stringify({
              session_id: 53091,
              chars: '',
              yield_time_ms: 1000,
              max_output_tokens: 12000
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:05.000Z',
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: '我现在开始改消息卡片显隐交互。' }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.match(messages[1].content, /我先定位消息卡片和样式文件。/);
    assert.match(messages[1].content, /:::tool\{name="Terminal"\}/);
    assert.match(messages[1].content, /MessageBubble\.tsx/);
    assert.match(messages[1].content, /我现在开始改消息卡片显隐交互。/);
    assert.doesNotMatch(messages[1].content, /"session_id":53091/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages keeps codex user images when response_item and event_msg duplicate the same user turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-images-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '11');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-11T18-14-57-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-11T18:14:57.319Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'codex 渲染 shell 图 1\n我们 web 渲染 图 2'
              },
              { type: 'input_text', text: '<image>' },
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,abc123'
              },
              { type: 'input_text', text: '</image>' }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-11T18:14:57.319Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'codex 渲染 shell 图 1\n我们 web 渲染 图 2',
            images: ['data:image/png;base64,abc123'],
            local_images: []
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'codex 渲染 shell 图 1\n我们 web 渲染 图 2');
    assert.deepEqual(messages[0].images, ['data:image/png;base64,abc123']);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages prefers codex exec_command_end aggregated output and parsed command metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-exec-end-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '11');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-11T18-15-18-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-11T18:15:18.742Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: 'sed -n \'220,360p\' "/Users/model/projects/feature/ai_home/web/src/components/chat/chat.module.css"',
              workdir: '/Users/model/projects/feature/ai_home',
              yield_time_ms: 1000,
              max_output_tokens: 12000
            }),
            call_id: 'call_figfoUbZusu37gzp6c2gTaDF'
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-11T18:15:23.336Z',
          type: 'event_msg',
          payload: {
            type: 'exec_command_end',
            call_id: 'call_figfoUbZusu37gzp6c2gTaDF',
            cwd: '/Users/model/projects/feature/ai_home',
            parsed_cmd: [{
              type: 'read',
              cmd: 'sed -n \'220,360p\' /Users/model/projects/feature/ai_home/web/src/components/chat/chat.module.css',
              name: 'chat.module.css',
              path: '/Users/model/projects/feature/ai_home/web/src/components/chat/chat.module.css'
            }],
            aggregated_output: '.bubbleAssistant {\n  padding: 12px 16px;\n}\n\n.pendingShell {\n  position: relative;\n}\n',
            stdout: '',
            stderr: '',
            exit_code: 0
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="Read"\}/);
    assert.match(messages[0].content, /chat\.module\.css/);
    assert.match(messages[0].content, /\.bubbleAssistant/);
    assert.doesNotMatch(messages[0].content, /Chunk ID:/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents returns codex incremental events with cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T14-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);

    const firstLine = JSON.stringify({
      timestamp: '2026-04-12T14:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello with image' }, { type: 'input_image', image_url: 'data:image/png;base64,evtimg' }]
      }
    }) + '\n';
    fs.writeFileSync(sessionFile, firstLine, 'utf8');

    const cursor = Buffer.byteLength(firstLine, 'utf8');
    fs.appendFileSync(sessionFile, [
      JSON.stringify({
        timestamp: '2026-04-12T14:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'agent_reasoning', text: '**Thinking about patch**' }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T14:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'call_delta_read',
          cwd: '/Users/model/projects/feature/ai_home',
          command: ['/bin/zsh', '-lc', 'sed -n \'1,40p\' "/tmp/demo.txt"'],
          parsed_cmd: [{ type: 'read', name: 'demo.txt', path: '/tmp/demo.txt' }],
          aggregated_output: 'line1\nline2',
          exit_code: 0
        }
      }),
      ''
    ].join('\n'), 'utf8');

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor });
    assert.ok(payload.cursor > cursor);
    assert.equal(Array.isArray(payload.events), true);
    assert.equal(payload.events.length, 2);
    assert.equal(payload.events[0].type, 'assistant_reasoning');
    assert.equal(payload.events[1].type, 'assistant_tool_result');
    assert.match(payload.events[1].content, /:::tool\{name="Read"\}/);
    assert.match(payload.events[1].content, /demo\.txt/);
    assert.match(payload.events[1].content, /line1/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents requests snapshot fallback when codex emits raw function_call_output delta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-fallback-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '88888888-8888-4888-8888-888888888888';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T15-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T15:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_raw_delta',
          output: 'Chunk ID: abc123\nWall time: 0.1 seconds\nOutput:\nraw text'
        }
      }) + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.requiresSnapshot, true);
    assert.deepEqual(payload.events, []);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents emits assistant_tool_call for codex function_call deltas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-tool-call-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '99999999-9999-4999-8999-999999999999';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T16-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T16:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_tool_delta',
          arguments: JSON.stringify({
            cmd: 'sed -n \'1,20p\' "/tmp/demo.txt"',
            workdir: '/Users/model/projects/feature/ai_home'
          })
        }
      }) + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.requiresSnapshot, false);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].type, 'assistant_tool_call');
    assert.match(payload.events[0].content, /:::tool\{name="Terminal"\}/);
    assert.match(payload.events[0].content, /sed -n/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents requests snapshot fallback when codex cursor advances but no supported incremental events are produced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-empty-fallback-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T17-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T17:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'ignored_event_shape',
          foo: 'bar'
        }
      }) + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.ok(payload.cursor > 0);
    assert.deepEqual(payload.events, []);
    assert.equal(payload.requiresSnapshot, true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages renders codex update_plan tool calls as structured Task blocks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-plan-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T15-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T15:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'call_plan_1',
            arguments: JSON.stringify({
              explanation: '按顺序处理问题',
              tasks: [
                { step: '先定位问题', status: 'completed' },
                { step: '补持久化修复', status: 'in_progress' },
                { step: '验证并回归', status: 'pending' }
              ]
            })
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="Task"\}/);
    assert.match(messages[0].content, /按顺序处理问题/);
    assert.match(messages[0].content, /先定位问题/);
    assert.match(messages[0].content, /补持久化修复/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
