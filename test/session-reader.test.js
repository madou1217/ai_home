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
