const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadSseParser() {
  const ts = require('../web/node_modules/typescript');
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'server-transport',
    'sse-parser.ts'
  ), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const moduleRef = { exports: {} };
  Function('module', 'exports', 'require', outputText)(
    moduleRef,
    moduleRef.exports,
    require
  );
  return moduleRef.exports;
}

test('SSE parser preserves split UTF-8, CRLF, and multi-line data', () => {
  const { createServerSseParser } = loadSseParser();
  const events = [];
  const parser = createServerSseParser((event) => events.push(event));
  const bytes = new TextEncoder().encode(
    'event: update\r\nid: evt-7\r\ndata: 中文🙂\r\ndata: second line\r\nretry: 1500\r\n\r\n'
  );

  for (const byte of bytes) parser.push(Uint8Array.of(byte));
  parser.finish();

  assert.deepEqual(events, [{
    type: 'update',
    data: '中文🙂\nsecond line',
    id: 'evt-7',
    retry: 1500
  }]);
});

test('SSE parser cancellation discards buffered and later chunks', () => {
  const { createServerSseParser } = loadSseParser();
  const events = [];
  const parser = createServerSseParser((event) => events.push(event));

  parser.push(new TextEncoder().encode('data: must-not-emit'));
  parser.cancel();
  parser.push(new TextEncoder().encode('\n\n'));
  parser.finish();

  assert.deepEqual(events, []);
});
