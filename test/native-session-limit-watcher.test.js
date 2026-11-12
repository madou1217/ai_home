'use strict';

// 回归守卫（2026-11-10 用户实测）：PTY 会把用户输入原样回显，于是「用户自己打出
// 一句 429」与「上游真的回了 429」在文本层面完全同形，会话当场被误换号。
// 结构化观察器只认会话 jsonl 里的 `providerData.error.status=429`：用户消息没有
// 这个结构，所以用户怎么写都不会触发换号。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FRESH_ERROR_WINDOW_MS,
  createNativeSessionLimitWatcher
} = require('../lib/cli/services/pty/native-session-limit-watcher');

const CREDITS_EXHAUSTED = '429 Credits exhausted. Please visit the link below to purchase '
  + 'add-on packs and get more credits: https://www.codebuddy.ai/profile/usage';

// 恢复时刻必须是**未来**：检测层会把已经过去的时刻当成历史日志。用 UTC+8 文案，
// 与 codebuddycn 真机一致。
function timed429Message(nowMs) {
  const reset = new Date(nowMs + 10 * 60 * 1000 + 8 * 3600 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${reset.getUTCFullYear()}-${pad(reset.getUTCMonth() + 1)}-${pad(reset.getUTCDate())} `
    + `${pad(reset.getUTCHours())}:${pad(reset.getUTCMinutes())}:${pad(reset.getUTCSeconds())}`;
  return 'API Error: 429 usage exceeds frequency limit, '
    + `your usage will reset at ${stamp} UTC+8`;
}

const TIMED_429 = timed429Message(Date.now());

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-limit-watcher-'));
}

function appendLines(filePath, entries) {
  fs.appendFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function userEntry(text, atMs, id) {
  return { id, timestamp: atMs, message: { role: 'user', content: text } };
}

function errorEntry(error, atMs, id, model) {
  return {
    id,
    timestamp: atMs,
    providerData: { model, error }
  };
}

function createWatcher(options) {
  const limits = [];
  const watcher = createNativeSessionLimitWatcher({
    getProvider: () => options.provider || 'codebuddy',
    getSessionId: options.getSessionId,
    resolveSessionPath: options.resolveSessionPath,
    cwd: options.cwd,
    startedAtMs: options.startedAtMs,
    now: options.now,
    onLimit: (limit) => limits.push(limit)
  });
  return { watcher, limits };
}

test('用户自己打出的 429 不会触发换号（会话文件里只有 user 消息）', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      userEntry(CREDITS_EXHAUSTED, nowMs, 'u1'),
      userEntry('看看这句 429 Credits exhausted 是什么意思', nowMs + 1000, 'u2')
    ]);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs - 1000,
      now: () => nowMs + 2000
    });
    watcher.tick();
    assert.equal(limits.length, 0);
    assert.equal(watcher.isObserving(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话文件里的上游 429（带恢复时刻）触发一次换号信号', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      errorEntry({ status: 200 }, nowMs, 'a0', 'deepseek-v3'),
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs + 1000, 'a1', 'deepseek-v3')
    ]);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs - 1000,
      now: () => nowMs + 2000
    });
    watcher.tick();
    assert.equal(limits.length, 1);
    assert.equal(limits[0].signal.kind, 'rate_limit');
    assert.equal(limits[0].model, 'deepseek-v3');
    assert.ok(limits[0].signal.resetAtMs > nowMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('积分耗尽（没有恢复时刻）也是信号，按 hardExhaustion 处理', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      errorEntry({ status: 429, code: 14018, message: CREDITS_EXHAUSTED }, nowMs + 1000, 'a1', 'glm-5')
    ]);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs - 1000,
      now: () => nowMs + 2000
    });
    watcher.tick();
    assert.equal(limits.length, 1);
    assert.equal(limits[0].signal.kind, 'quota_exhausted');
    assert.equal(limits[0].signal.hardExhaustion, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('换号后 --resume 同一段会话：上一轮写下的 429 是历史，不再触发', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs - 5000, 'a1', 'deepseek-v3')
    ]);
    // 新 PTY 在报错之后才启动：这条记录属于上一个账号。
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs,
      now: () => nowMs + 1000
    });
    watcher.tick();
    assert.equal(limits.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('两分钟前的旧报错不触发（翻旧会话不该立刻切号）', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs, 'a1', 'deepseek-v3')
    ]);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs - 1000,
      now: () => nowMs + FRESH_ERROR_WINDOW_MS + 60_000
    });
    watcher.tick();
    assert.equal(limits.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('增量读取：只对追加的新报错触发，同一条不重复', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    let clock = nowMs;
    appendLines(filePath, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs, 'a1', 'deepseek-v3')
    ]);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs - 1000,
      now: () => clock
    });
    watcher.tick();
    assert.equal(limits.length, 1);

    // 同一文件再扫一遍（没有新行）→ 不重复触发。
    watcher.tick();
    assert.equal(limits.length, 1);

    clock = nowMs + 5000;
    appendLines(filePath, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, clock, 'a2', 'deepseek-v3')
    ]);
    watcher.tick();
    assert.equal(limits.length, 2);
    assert.equal(limits[1].entry.id, 'a2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同一条报错（相同 id）重复出现只回调一次', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs, 'a1', 'deepseek-v3')
    ]);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs - 1000,
      now: () => nowMs + 1000
    });
    watcher.tick();
    appendLines(filePath, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs + 1000, 'a1', 'deepseek-v3')
    ]);
    watcher.tick();
    assert.equal(limits.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话 id 变化后改读新文件（换号续接的新会话）', () => {
  const dir = makeTempDir();
  try {
    const first = path.join(dir, 'sid-1.jsonl');
    const second = path.join(dir, 'sid-2.jsonl');
    const nowMs = Date.now();
    appendLines(first, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs, 'a1', 'deepseek-v3')
    ]);
    let sessionId = 'sid-1';
    let clock = nowMs + 1000;
    const { watcher, limits } = createWatcher({
      getSessionId: () => sessionId,
      resolveSessionPath: (_provider, id) => (id === 'sid-2' ? second : first),
      startedAtMs: nowMs - 1000,
      now: () => clock
    });
    watcher.tick();
    assert.equal(limits.length, 1);

    appendLines(second, [
      errorEntry({ status: 429, code: 6004, message: TIMED_429 }, nowMs + 2000, 'b1', 'glm-5')
    ]);
    sessionId = 'sid-2';
    clock = nowMs + 3000;
    watcher.tick();
    assert.equal(watcher.getFilePath(), second);
    assert.equal(limits.length, 2);
    assert.equal(limits[1].model, 'glm-5');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('非 CodeBuddy 家族不支持结构化观察，start 返回 false', () => {
  const { watcher } = createWatcher({
    provider: 'claude',
    getSessionId: () => 'sid-1',
    resolveSessionPath: () => '',
    startedAtMs: Date.now(),
    now: () => Date.now()
  });
  assert.equal(watcher.isSupported(), false);
  assert.equal(watcher.tick(), false);
  assert.equal(watcher.start(), false);
  assert.equal(watcher.stop(), false);
});

test('会话文件还没落盘时 tick 安静返回，不抛错', () => {
  const dir = makeTempDir();
  try {
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => path.join(dir, 'missing.jsonl'),
      startedAtMs: Date.now(),
      now: () => Date.now()
    });
    assert.equal(watcher.tick(), false);
    assert.equal(limits.length, 0);
    assert.equal(watcher.isObserving(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('entry 自己声明的 sessionId / cwd 与本次会话不符时不采信', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      {
        id: 'a1',
        timestamp: nowMs,
        sessionId: 'another-session',
        cwd: '/Users/model/projects/feature/ai_home',
        providerData: { model: 'deepseek-v3', error: { status: 429, code: 6004, message: TIMED_429 } }
      },
      {
        id: 'a2',
        timestamp: nowMs,
        sessionId: 'sid-1',
        cwd: '/somewhere/else',
        providerData: { model: 'deepseek-v3', error: { status: 429, code: 6004, message: TIMED_429 } }
      }
    ]);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      cwd: '/Users/model/projects/feature/ai_home',
      startedAtMs: nowMs - 1000,
      now: () => nowMs + 1000
    });
    watcher.tick();
    assert.equal(limits.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧会话文件（基线之后没再写过）不算「正在观察」，文本兜底仍然生效', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sid-1.jsonl');
    const nowMs = Date.now();
    appendLines(filePath, [
      userEntry('hi', nowMs - 3600_000, 'u1')
    ]);
    const old = new Date(nowMs - 3600_000);
    fs.utimesSync(filePath, old, old);
    const { watcher, limits } = createWatcher({
      getSessionId: () => 'sid-1',
      resolveSessionPath: () => filePath,
      startedAtMs: nowMs,
      now: () => nowMs + 1000
    });
    watcher.tick();
    assert.equal(watcher.isObserving(), false);
    assert.equal(limits.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
