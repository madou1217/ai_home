const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
  AGGREGATE_THREAD_LIST_MAX_ITEMS,
  shouldAggregateThreadList,
  buildAggregatePageRequest,
  mergeThreadListData,
  parseProxyArgs,
  readHookState,
  runCodexAppServerStdioProxy
} = require('../lib/server/codex-app-server-stdio-proxy');

test('parseProxyArgs splits helper args from upstream args', () => {
  const parsed = parseProxyArgs([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server',
    '--analytics-default-enabled'
  ]);
  assert.equal(parsed.upstream, '/tmp/original');
  assert.equal(parsed.stateFile, '/tmp/state.json');
  assert.deepEqual(parsed.forwardArgs, ['app-server', '--analytics-default-enabled']);
});

test('readHookState defaults to disabled when state file is missing', () => {
  const state = readHookState({
    existsSync: () => false
  }, '/tmp/missing.json');
  assert.equal(state.enabled, false);
});

test('shouldAggregateThreadList matches first-page requests for global and cwd lists', () => {
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      limit: 50,
      cursor: null,
      archived: false,
      sourceKinds: []
    }
  }), true);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      cursor: null,
      archived: false,
      sourceKinds: []
    }
  }), true);
  assert.equal(shouldAggregateThreadList({
    method: 'thread/list',
    params: {
      cwd: '/tmp/x',
      limit: 50,
      cursor: 'abc',
      archived: false,
      sourceKinds: []
    }
  }), false);
});

test('buildAggregatePageRequest rewrites cursor and limit deterministically', () => {
  const out = buildAggregatePageRequest({
    id: 'abc',
    method: 'thread/list',
    params: {
      limit: 50,
      cursor: null,
      archived: false,
      sourceKinds: []
    }
  }, 'CURSOR-2', 'abc:2', 30);
  assert.equal(out.id, 'abc:2');
  assert.equal(out.params.cursor, 'CURSOR-2');
  assert.equal(out.params.limit, 30);
});

test('mergeThreadListData dedupes by thread id', () => {
  const merged = mergeThreadListData(
    [{ id: '1', cwd: '/a' }, { id: '2', cwd: '/b' }],
    [{ id: '2', cwd: '/b' }, { id: '3', cwd: '/c' }]
  );
  assert.deepEqual(merged.map((item) => item.id), ['1', '2', '3']);
});

test('stdio proxy rewrites thread/list only when hook is enabled', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ enabled: true })
    },
    spawn: (command, args, options) => {
      assert.equal(command, '/tmp/original');
      assert.deepEqual(args, ['app-server']);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'inherit']);
      return child;
    },
    processObj: {
      env: {},
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/list","params":{"cwd":"/tmp/x"}}\n'));
  upstreamStdout.emit('data', Buffer.from('{"jsonrpc":"2.0","result":[]}\n'));

  const rewritten = JSON.parse(upstreamStdinWrites[0]);
  assert.deepEqual(rewritten.params.modelProviders, []);
  assert.deepEqual(stdout.writes, ['{"jsonrpc":"2.0","result":[]}\n']);
  assert.deepEqual(stderr.writes, []);
});

test('stdio proxy aggregates cwd thread/list pages with bounded total size', () => {
  const stdin = new EventEmitter();
  const stdout = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const stderr = { writes: [], write(chunk) { this.writes.push(String(chunk || '')); } };
  const upstreamStdout = new EventEmitter();
  const upstreamStdinWrites = [];
  const child = new EventEmitter();
  child.stdin = {
    write(chunk) {
      upstreamStdinWrites.push(String(chunk || ''));
    },
    end() {}
  };
  child.stdout = upstreamStdout;

  runCodexAppServerStdioProxy([
    '--upstream', '/tmp/original',
    '--state-file', '/tmp/state.json',
    '--',
    'app-server'
  ], {
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ enabled: true })
    },
    spawn: () => child,
    processObj: {
      env: {},
      pid: 999,
      stdin,
      stdout,
      stderr,
      exit(code) {
        throw new Error(`EXIT:${code}`);
      },
      kill() {
        throw new Error('signal should not be used');
      }
    }
  });

  stdin.emit('data', Buffer.from('{"id":"list-1","method":"thread/list","params":{"cwd":"/tmp/x","limit":50,"cursor":null,"archived":false,"sourceKinds":[]}}\n'));

  const firstRequest = JSON.parse(upstreamStdinWrites[0]);
  assert.equal(firstRequest.params.limit, 50);
  assert.deepEqual(firstRequest.params.modelProviders, []);

  upstreamStdout.emit('data', Buffer.from('{"id":"list-1","result":{"data":[{"id":"1"},{"id":"2"}],"nextCursor":"cursor-2","backwardsCursor":"back-1"}}\n'));

  const secondRequest = JSON.parse(upstreamStdinWrites[1]);
  assert.equal(secondRequest.id, 'aih-aggregate-thread-list:list-1:2');
  assert.equal(secondRequest.params.cursor, 'cursor-2');
  assert.equal(secondRequest.params.limit, AGGREGATE_THREAD_LIST_MAX_ITEMS - 50);

  upstreamStdout.emit('data', Buffer.from('{"id":"aih-aggregate-thread-list:list-1:2","result":{"data":[{"id":"2"},{"id":"3"}],"nextCursor":"cursor-3","backwardsCursor":"back-2"}}\n'));

  const payload = JSON.parse(stdout.writes[0]);
  assert.equal(payload.id, 'list-1');
  assert.deepEqual(payload.result.data.map((item) => item.id), ['1', '2', '3']);
  assert.equal(payload.result.backwardsCursor, 'back-1');
  assert.equal(payload.result.nextCursor, 'cursor-3');
  assert.deepEqual(stderr.writes, []);
});
