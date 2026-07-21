'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createOptionalChatRuntime
} = require('../lib/server/chat-runtime-bootstrap');
const {
  openChatRuntimeDatabase
} = require('../lib/server/chat-runtime/database');

test('chat runtime database reports a typed availability error without node:sqlite', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-runtime-db-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  assert.throws(
    () => openChatRuntimeDatabase({ fs, aiHomeDir, DatabaseSync: null }),
    (error) => error.code === 'chat_runtime_database_unavailable'
      && error.statusCode === 503
  );
});

test('optional bootstrap degrades only an unavailable chat runtime', () => {
  const warnings = [];
  const service = createOptionalChatRuntime({ aiHomeDir: '/tmp/aih' }, {
    createComposition() {
      const error = new Error('chat_runtime_database_unavailable');
      error.code = 'chat_runtime_database_unavailable';
      throw error;
    },
    warn: (message) => warnings.push(message)
  });

  assert.equal(service, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /chat runtime unavailable/i);
});

test('optional bootstrap never hides an unexpected composition failure', () => {
  assert.throws(() => createOptionalChatRuntime({}, {
    createComposition() { throw new Error('schema_corrupted'); },
    warn() {}
  }), /schema_corrupted/);
});
