const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadTransportErrors() {
  const ts = require('../web/node_modules/typescript');
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'server-transport',
    'errors.ts'
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

test('native transport errors retain the safe Rust envelope needed by auth gates', () => {
  const { fromNativeCommandError } = loadTransportErrors();
  const error = fromNativeCommandError({
    code: 'unauthorized',
    message: 'Management Key 认证失败。',
    status: 401,
    retriable: false
  });

  assert.equal(error.code, 'unauthorized');
  assert.equal(error.message, 'Management Key 认证失败。');
  assert.equal(error.status, 401);
  assert.equal(error.cause, undefined);
});

test('native transport errors discard URLs, secrets, debug fields, and raw causes', () => {
  const { fromNativeCommandError } = loadTransportErrors();
  const secret = 'do-not-expose';
  const error = fromNativeCommandError({
    code: 'network_error',
    message: `request failed for https://server.invalid/v0?token=${secret}`,
    status: 503,
    debug: `Authorization: Bearer ${secret}`
  });
  const serialized = JSON.stringify(error);

  assert.equal(error.code, 'network_error');
  assert.equal(error.message, 'network_error');
  assert.equal(error.status, 503);
  assert.equal(error.cause, undefined);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('server.invalid'), false);
});

test('native transport errors reject malformed contract fields', () => {
  const { fromNativeCommandError } = loadTransportErrors();
  const error = fromNativeCommandError({
    code: 'bad code with spaces',
    message: 'stack\n  at request (/workspace/app.rs:1)',
    status: 999
  });

  assert.equal(error.code, 'native_command_failed');
  assert.equal(error.message, 'native_command_failed');
  assert.equal(error.status, undefined);
  assert.equal(error.cause, undefined);
});
