'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const ts = require('../web/node_modules/typescript');
const limits = require('../contracts/chat-attachments.json').largePasteChars;
const { parseServerConfigArgs } = require('../lib/server/server-config-command');
const { readServerConfig, resolveLargePasteChars, sanitizeServerConfig, writeServerConfig } = require('../lib/server/server-config-store');
const { handleChatPasteRequest, matchChatPasteRoute } = require('../lib/server/webui-chat-paste-routes');

test('contract: default 200, minimum 50', () => {
  assert.equal(limits.default, 200);
  assert.equal(limits.min, 50);
});

test('CLI: aih server config set --large-paste-chars validates the minimum', () => {
  assert.equal(parseServerConfigArgs(['set', '--large-paste-chars', '50']).patch.largePasteChars, 50);
  assert.equal(parseServerConfigArgs(['set', '--clear-large-paste-chars']).patch.largePasteChars, 0);
  assert.throws(() => parseServerConfigArgs(['set', '--large-paste-chars', '49']), /最小 50/);
  assert.throws(() => parseServerConfigArgs(['set', '--large-paste-chars', 'abc']), /50\.\.100000/);
});

test('store: unset means default, stored values are clamped to at least 50', () => {
  assert.equal(resolveLargePasteChars({}), 200);
  assert.equal(resolveLargePasteChars(sanitizeServerConfig({ largePasteChars: 80 })), 80);
  assert.equal(resolveLargePasteChars(sanitizeServerConfig({ largePasteChars: 10 })), 50);
});

function call(aiHomeDir, method, body) {
  const req = new PassThrough();
  req.method = method;
  req.headers = {};
  let response;
  const ctx = { req, res: {}, fs, aiHomeDir, writeJson: (_res, status, payload) => { response = { status, payload }; } };
  const pending = handleChatPasteRequest(ctx);
  req.end(body === undefined ? '' : JSON.stringify(body));
  return pending.then(() => response);
}

test('WebUI route reads and writes the same server config key the CLI uses', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-paste-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  // 已有的其它设置不能被这条路由改写。
  writeServerConfig({ maxAttempts: 7 }, { fs, aiHomeDir });

  assert.equal(matchChatPasteRoute('GET', '/v0/webui/chat/paste-settings'), true);
  assert.deepEqual((await call(aiHomeDir, 'GET')).payload.largePasteChars, 200);

  const saved = await call(aiHomeDir, 'POST', { largePasteChars: 60 });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.largePasteChars, 60);
  assert.equal(saved.payload.custom, true);
  assert.equal(readServerConfig({ fs, aiHomeDir }).largePasteChars, 60);
  assert.equal(readServerConfig({ fs, aiHomeDir }).maxAttempts, 7);

  const tooSmall = await call(aiHomeDir, 'POST', { largePasteChars: 49 });
  assert.equal(tooSmall.status, 400);
  assert.equal(tooSmall.payload.error, 'invalid_large_paste_chars');
  assert.equal(readServerConfig({ fs, aiHomeDir }).largePasteChars, 60);

  const reset = await call(aiHomeDir, 'POST', { largePasteChars: null });
  assert.equal(reset.payload.largePasteChars, 200);
  assert.equal(reset.payload.custom, false);
});

test('WebUI paste helper honours the configured threshold and its floor', () => {
  const source = fs.readFileSync(require.resolve('../web/src/components/chat/attachment-files.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, File: class {},
    require: (id) => (id.endsWith('chat-attachments.json') ? require('../contracts/chat-attachments.json') : require(id)),
  });
  const helper = mod.exports;
  const text = (n) => 'a'.repeat(n);
  assert.equal(helper.shouldConvertLargePaste(text(199)), false);
  assert.equal(helper.shouldConvertLargePaste(text(200)), true);
  helper.setLargePasteCharLimit(60);
  assert.equal(helper.shouldConvertLargePaste(text(59)), false);
  assert.equal(helper.shouldConvertLargePaste(text(60)), true);
  helper.setLargePasteCharLimit(10);
  assert.equal(helper.largePasteCharLimit(), 50);
  helper.setLargePasteCharLimit(0);
  assert.equal(helper.largePasteCharLimit(), 200);
});
