'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleWebUiTerminalRequest, openWebUiTerminalSession } = require('../lib/server/webui-terminal-routes');
const { formatTerminalClipboardPath } = require('../lib/server/webui-terminal-clipboard');

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function post(body) {
  let reply;
  await handleWebUiTerminalRequest({
    method: 'POST',
    pathname: '/v0/webui/terminal/clipboard-image',
    res: {},
    readRequestBody: async () => Buffer.from(JSON.stringify(body)),
    writeJson: (_res, status, value) => { reply = { status, ...value }; }
  });
  return reply;
}

test('Web Terminal clipboard image is saved under the active project', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-terminal-image-'));
  try {
    const result = await post({ sessionKey: 'clipboard-test', cwd: projectPath, dataUrl: ONE_PIXEL_PNG });
    assert.equal(result.status, 201);
    assert.equal(result.ok, true);
    assert.match(result.path, new RegExp(`${projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\/]\\.aih[\\/]chat-images`));
    assert.equal(fs.existsSync(result.path), true);
    assert.equal(fs.readFileSync(result.path).length > 0, true);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('an attached terminal uses its own cwd when a stale browser cwd is supplied', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-terminal-current-'));
  const stalePath = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-terminal-stale-'));
  const sessionKey = `clipboard-cwd-${process.pid}-${Date.now()}`;
  const session = openWebUiTerminalSession({ sessionKey, cwd: projectPath });
  assert.equal(session.ok, true);
  try {
    const result = await post({ sessionKey, cwd: stalePath, dataUrl: ONE_PIXEL_PNG });
    assert.equal(result.ok, true);
    assert.equal(result.path.startsWith(`${projectPath}${path.sep}`), true);
    assert.equal(fs.existsSync(result.path), true);
  } finally {
    await handleWebUiTerminalRequest({ method: 'POST', pathname: '/v0/webui/terminal/close', res: {},
      readRequestBody: async () => Buffer.from(JSON.stringify({ termId: session.termId, sessionKey })), writeJson: () => {} });
    fs.rmSync(projectPath, { recursive: true, force: true });
    fs.rmSync(stalePath, { recursive: true, force: true });
  }
});

test('Web Terminal clipboard image rejects non-image data', async () => {
  const result = await post({ cwd: os.tmpdir(), dataUrl: 'data:text/plain;base64,SGVsbG8=' });
  assert.equal(result.status, 400);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'terminal_image_invalid');
});

test('Web Terminal clipboard image rejects bytes that do not match the declared type', async () => {
  const result = await post({ cwd: os.tmpdir(), dataUrl: 'data:image/png;base64,SGVsbG8=' });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'terminal_image_invalid');
});

test('clipboard image paths with spaces remain one terminal argument', () => {
  assert.equal(formatTerminalClipboardPath('/tmp/my project/image.png', 'linux'), "'/tmp/my project/image.png'");
  assert.equal(formatTerminalClipboardPath("/tmp/it's/image.png", 'linux'), "'/tmp/it'\\''s/image.png'");
  assert.equal(formatTerminalClipboardPath('C:\\My Project\\image.png', 'win32'), '"C:\\My Project\\image.png"');
});
