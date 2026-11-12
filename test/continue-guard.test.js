'use strict';

// 自动 continue 的落点校验（2026-11-11 用户实测：续接目标不存在时运行时照样写
// `continue`，新会话里空跑一轮）。只有「精确续接 + 会话文件存在且非空」才放行。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REASON_MESSAGES,
  inspectContinueTarget
} = require('../lib/cli/services/pty/continue-guard');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-continue-guard-'));
}

function writeSession(dir, name, text) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, text);
  return filePath;
}

function inspect(patch) {
  return inspectContinueTarget({
    provider: 'codebuddycn',
    continuation: { ok: true, exact: true, sessionId: 'sid-1' },
    resolveSessionFilePath: () => '',
    ...patch
  });
}

test('精确续接 + 会话文件存在且非空 → 允许写 continue', () => {
  const dir = makeTempDir();
  try {
    const filePath = writeSession(dir, 'sid-1.jsonl', '{"role":"user","content":"hi"}\n');
    const decision = inspect({ resolveSessionFilePath: () => filePath });
    assert.equal(decision.ok, true);
    assert.equal(decision.reason, 'verified');
    assert.equal(decision.sessionId, 'sid-1');
    assert.equal(decision.filePath, filePath);
    assert.equal(decision.message, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resume 目标不存在 → 不允许写 continue，并给出可读原因', () => {
  const dir = makeTempDir();
  try {
    const decision = inspect({
      resolveSessionFilePath: () => path.join(dir, 'no-such-session.jsonl')
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'session_file_not_found');
    assert.match(decision.message, /找不到/);
    assert.equal(decision.sessionId, 'sid-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('定位不到会话文件 → 不允许写 continue', () => {
  const decision = inspect({ resolveSessionFilePath: () => '' });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'session_file_not_found');
  assert.match(decision.message, /找不到/);
});

test('只有「最近一段」的兜底（exact=false）→ 不写 continue', () => {
  const dir = makeTempDir();
  try {
    const filePath = writeSession(dir, 'sid-1.jsonl', '{}\n');
    const decision = inspect({
      continuation: { ok: true, exact: false, sessionId: '', args: ['--continue'] },
      resolveSessionFilePath: () => filePath
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'inexact_continuation');
    assert.match(decision.message, /最近一段/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider 没有续接入口 → 沿用 provider 给的原因，不写 continue', () => {
  const decision = inspect({
    continuation: { ok: false, exact: false, message: 'agy 没有可用的续接入口，换号会丢失当前对话。' }
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'continuation_unavailable');
  assert.equal(decision.message, 'agy 没有可用的续接入口，换号会丢失当前对话。');
});

test('显式 --resume <id>：文件在就允许，文件不在就不允许', () => {
  const dir = makeTempDir();
  try {
    const filePath = writeSession(dir, 'sid-9.jsonl', '{}\n');
    const ok = inspect({
      keepExplicit: true,
      explicitSessionId: 'sid-9',
      continuation: null,
      resolveSessionFilePath: (_provider, params) => (
        params.sessionId === 'sid-9' ? filePath : ''
      )
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.sessionId, 'sid-9');

    const missing = inspect({
      keepExplicit: true,
      explicitSessionId: 'sid-404',
      continuation: null,
      resolveSessionFilePath: () => ''
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'session_file_not_found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('用户只写了 --continue 一类的裸旗标 → 没有 id，不写 continue', () => {
  const decision = inspect({
    keepExplicit: true,
    explicitSessionId: '',
    continuation: null
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'explicit_without_session_id');
  assert.equal(decision.message, REASON_MESSAGES.explicit_without_session_id);
});

test('会话文件是空的（只有壳）→ 不写 continue', () => {
  const dir = makeTempDir();
  try {
    const filePath = writeSession(dir, 'sid-1.jsonl', '');
    const decision = inspect({ resolveSessionFilePath: () => filePath });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'session_file_empty');
    assert.match(decision.message, /空/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('定位函数抛错（会话库读不出来）→ 当作找不到，不写 continue', () => {
  const decision = inspect({
    resolveSessionFilePath: () => { throw new Error('db locked'); }
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'session_file_not_found');
});

test('没有会话 id 的续接计划 → 不写 continue', () => {
  const decision = inspect({
    continuation: { ok: true, exact: true, sessionId: '' }
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'missing_session_id');
});
