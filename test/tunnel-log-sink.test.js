'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTunnelLogSink } = require('../lib/remote-workspace');

// 隧道探活只有在 server.log 里看得见才算「能验证」：stdout 在 launchd / systemd 下
// 未必留得住，所以事件必须自己写进 server.log 的 JSON 行。
test('隧道日志：事件写进 server.log 的 JSON 行', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tunnel-log-'));
  const sink = createTunnelLogSink({ fs, aiHomeDir });
  sink({ kind: 'reverse_tunnel_probe', connectionId: 'conn_1', remotePort: 22022, ok: true, durationMs: 3, rebounds: 0 });

  const logFile = path.join(aiHomeDir, 'logs', 'server.log');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'reverse_tunnel_probe');
  assert.equal(lines[0].connectionId, 'conn_1');
  assert.equal(lines[0].remotePort, 22022);
  assert.equal(lines[0].ok, true);
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('隧道日志：写不进去时退回 stdout，不抛错', () => {
  const printed = [];
  const originalLog = console.log;
  console.log = (line) => printed.push(line);
  try {
    const sink = createTunnelLogSink({
      fs: {
        mkdirSync() { throw new Error('EACCES'); },
        statSync() { throw new Error('ENOENT'); },
        appendFileSync() { throw new Error('EACCES'); },
        chmodSync() { throw new Error('EACCES'); },
        truncateSync() { throw new Error('EACCES'); }
      },
      aiHomeDir: '/nonexistent'
    });
    sink({ kind: 'reverse_tunnel_dead', connectionId: 'conn_2', reason: 'probe_failed' });
  } finally {
    console.log = originalLog;
  }
  assert.equal(printed.length, 1);
  assert.equal(JSON.parse(printed[0]).kind, 'reverse_tunnel_dead');
});
