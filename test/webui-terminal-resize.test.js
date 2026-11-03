'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleWebUiTerminalRequest, openWebUiTerminalSession, findSessionByKey } = require('../lib/server/webui-terminal-routes');

async function post(action, body) {
  let reply;
  await handleWebUiTerminalRequest({
    method: 'POST', pathname: `/v0/webui/terminal/${action}`, res: {},
    readRequestBody: async () => Buffer.from(JSON.stringify(body)),
    writeJson: (_res, status, value) => { reply = { status, ...value }; },
  });
  return reply;
}

test('resizing records the PTY dimensions, ignores duplicates and preserves them on failure', { timeout: 10000 }, async () => {
  const sessionKey = `resize-${process.pid}-${Date.now()}`;
  const opened = openWebUiTerminalSession({ sessionKey, cols: 80, rows: 24 });
  assert.equal(opened.ok, true);
  const session = findSessionByKey(sessionKey);
  const originalResize = session.pty.resize.bind(session.pty);
  const calls = [];
  try {
    session.pty.resize = (cols, rows) => {
      calls.push([cols, rows]);
      if (cols === 113) throw new Error('simulated resize failure');
      return originalResize(cols, rows);
    };
    assert.deepEqual(await post('resize', { termId: opened.termId, cols: 112, rows: 38 }),
      { status: 200, ok: true, cols: 112, rows: 38 });
    assert.deepEqual(await post('resize', { termId: opened.termId, cols: 112, rows: 38 }),
      { status: 200, ok: true, cols: 112, rows: 38 });
    assert.deepEqual(calls, [[112, 38]]);
    const attached = await post('attach', { sessionKey });
    assert.equal(attached.ok, true);
    assert.equal(attached.cols, 112);
    assert.equal(attached.rows, 38);
    const failed = await post('resize', { termId: opened.termId, cols: 113, rows: 40 });
    assert.equal(failed.status, 400);
    assert.equal(failed.error, 'terminal_resize_failed');
    const afterFailure = await post('attach', { sessionKey });
    assert.equal(afterFailure.cols, 112);
    assert.equal(afterFailure.rows, 38);
    assert.deepEqual(await post('resize', { termId: opened.termId, cols: 114, rows: 40 }),
      { status: 200, ok: true, cols: 114, rows: 40 });
    assert.deepEqual(calls, [[112, 38], [113, 40], [114, 40]]);
  } finally {
    session.pty.resize = originalResize;
    await post('close', { termId: opened.termId, sessionKey });
  }
});
