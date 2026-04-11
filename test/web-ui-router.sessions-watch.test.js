const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');

function createStreamResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
    },
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    },
    end(chunk = '') {
      this.body += String(chunk);
      this.writableEnded = true;
    }
  };
}

function createBaseDeps() {
  return {
    fs,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      upsertAccountState() {},
      removeAccount() {},
      getAccountState() { return null; }
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: true, accountName: 'watch@test.dev' }; },
    ensureSessionStoreLinks() {},
    pickProjectDirectory() { return null; }
  };
}

test('web ui sessions watch streams codex session file updates', async (t) => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-watch-home-'));
  process.env.REAL_HOME = realHome;
  t.after(() => {
    delete process.env.REAL_HOME;
    fs.rmSync(realHome, { recursive: true, force: true });
  });

  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const sessionDir = path.join(realHome, '.codex', 'sessions', '2026', '04', '11');
  fs.ensureDirSync(sessionDir);
  const sessionPath = path.join(sessionDir, `rollout-2026-04-11T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(sessionPath, '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n');

  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/sessions/watch',
    url: new URL(`http://localhost/v0/webui/sessions/watch?provider=codex&sessionId=${sessionId}`),
    req,
    res,
    options: {},
    state: {},
    deps: createBaseDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"type":"connected"/);

  fs.appendFileSync(sessionPath, '{"type":"event_msg","payload":{"type":"user_message","message":"world"}}\n');
  await new Promise((resolve) => setTimeout(resolve, 1700));

  assert.match(res.body, /"type":"update"/);
  req.emit('close');
});
