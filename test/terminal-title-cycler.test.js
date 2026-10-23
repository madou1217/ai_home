const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTerminalTitleCycler,
  buildTitleSequence,
  sanitizeTitleText,
  CYCLE_INTERVAL_MS,
  SPINNER_INTERVAL_MS
} = require('../lib/cli/services/pty/terminal-title-cycler');
const {
  buildAccountLabel,
  buildSessionLabel,
  detectFailureLabel,
  readModelFromArgs,
  resolveProviderShortLabel
} = require('../lib/cli/services/pty/terminal-title-labels');

// 手动驱动的定时器：让轮播节拍、转圈帧都可断言，不依赖真实时间。
function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setInterval(cb, ms) {
      const timer = { cb, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer) timer.cleared = true;
    },
    tick(ms) {
      const timer = timers.find((candidate) => candidate.ms === ms && !candidate.cleared);
      assert.ok(timer, `no live timer at ${ms}ms`);
      timer.cb();
    },
    live(ms) {
      return timers.filter((candidate) => candidate.ms === ms && !candidate.cleared);
    }
  };
}

function createCycler(overrides = {}) {
  const writes = [];
  const timers = createFakeTimers();
  let sessionLabel = overrides.sessionLabel === undefined ? 'p-ai_home-1z0bk3' : overrides.sessionLabel;
  let accountLabel = overrides.accountLabel === undefined ? 'Cline:1:deepseek-xxx' : overrides.accountLabel;
  let enabled = overrides.enabled === undefined ? true : overrides.enabled;
  const cycler = createTerminalTitleCycler({
    processObj: {
      platform: overrides.platform || 'darwin',
      stdout: { write: (chunk) => writes.push(String(chunk || '')) }
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    isEnabled: () => enabled,
    isSuppressed: () => Boolean(overrides.suppressed),
    getSessionLabel: () => sessionLabel,
    getAccountLabel: () => accountLabel,
    ...overrides.cyclerOptions
  });
  return {
    cycler,
    writes,
    timers,
    titles: () => writes.map((chunk) => chunk.replace(/^\x1b\]0;/, '').replace(/\x07$/, '')),
    setSessionLabel: (value) => { sessionLabel = value; },
    setAccountLabel: (value) => { accountLabel = value; },
    setEnabled: (value) => { enabled = value; }
  };
}

test('title cycler alternates session name and account label every cycle', () => {
  const { cycler, titles, timers } = createCycler();
  cycler.start();

  assert.deepEqual(titles(), ['p-ai_home-1z0bk3']);
  timers.tick(CYCLE_INTERVAL_MS);
  assert.deepEqual(titles(), ['p-ai_home-1z0bk3', 'Cline:1:deepseek-xxx']);
  timers.tick(CYCLE_INTERVAL_MS);
  assert.deepEqual(titles(), ['p-ai_home-1z0bk3', 'Cline:1:deepseek-xxx', 'p-ai_home-1z0bk3']);
  timers.tick(CYCLE_INTERVAL_MS);
  assert.deepEqual(titles().at(-1), 'Cline:1:deepseek-xxx');
});

test('title cycler writes OSC 0 and never touches the screen', () => {
  const { cycler, writes } = createCycler();
  cycler.start();
  assert.equal(writes.length, 1);
  assert.equal(writes[0], '\x1b]0;p-ai_home-1z0bk3\x07');
  // 只允许 OSC 0 标题序列：没有光标移动、清行、滚动区。
  for (const chunk of writes) {
    assert.match(chunk, /^\x1b\]0;[^\x07]*\x07$/);
  }
});

test('title cycler keeps the spinner while the child is producing output', () => {
  const { cycler, titles, timers } = createCycler();
  cycler.start();
  cycler.markBusy();

  // 生成中：当前项前面挂一帧转圈。
  assert.match(titles().at(-1), /^⠋ p-ai_home-1z0bk3$/);
  timers.tick(SPINNER_INTERVAL_MS);
  assert.match(titles().at(-1), /^⠙ p-ai_home-1z0bk3$/);
  // 转圈帧只影响前缀，会话名本身不变。
  assert.equal(titles().at(-1).slice(2), 'p-ai_home-1z0bk3');

  cycler.markIdle();
  assert.equal(titles().at(-1), 'p-ai_home-1z0bk3');
  assert.equal(timers.live(SPINNER_INTERVAL_MS).length, 0);
});

test('title cycler cycles through the account item while busy', () => {
  const { cycler, titles, timers } = createCycler();
  cycler.start();
  cycler.markBusy();
  timers.tick(CYCLE_INTERVAL_MS);
  assert.match(titles().at(-1), /^⠋ Cline:1:deepseek-xxx$/);
});

test('interrupts and API errors join the same rotation', () => {
  const { cycler, titles, timers } = createCycler();
  cycler.start();

  cycler.setError('API 429');
  // 错误是刚发生的事件：立刻切过去，不等节拍。
  assert.equal(titles().at(-1), 'API 429');
  // 之后回到正常轮播，错误项仍留在循环里。
  timers.tick(CYCLE_INTERVAL_MS);
  timers.tick(CYCLE_INTERVAL_MS);
  timers.tick(CYCLE_INTERVAL_MS);
  assert.ok(titles().includes('API 429'));

  cycler.clearError();
  assert.equal(titles().at(-1), 'p-ai_home-1z0bk3');
});

test('an empty label is skipped instead of clearing the title', () => {
  const { cycler, titles, timers } = createCycler({ sessionLabel: '' });
  cycler.start();

  // 没有会话名时账号项直接当第一项，绝不写空标题（空标题会让终端回落到
  // 自己的默认命名，那正是「所有标签页长得一样」的成因）。
  assert.deepEqual(titles(), ['Cline:1:deepseek-xxx']);
  const before = titles().length;
  timers.tick(CYCLE_INTERVAL_MS);
  assert.equal(titles().length, before);
});

test('nothing is written while the title surface is disabled or suppressed', () => {
  const disabled = createCycler({ enabled: false });
  disabled.cycler.start();
  assert.deepEqual(disabled.writes, []);

  const suppressed = createCycler({ suppressed: true });
  suppressed.cycler.start();
  assert.deepEqual(suppressed.writes, []);
});

test('refresh does not rewrite an unchanged title and follows label changes', () => {
  const { cycler, titles, setAccountLabel } = createCycler();
  cycler.start();
  const afterStart = titles().length;

  // idle watcher 每 900ms 调一次 refresh：内容没变就不能重复写。
  cycler.refresh();
  cycler.refresh();
  assert.equal(titles().length, afterStart);

  setAccountLabel('Codex:2:gpt-5.5');
  cycler.refresh();
  assert.equal(titles().length, afterStart);
  // 账号项变化要等到它成为当前项才可见（当前仍在会话名那一帧）。
  cycler.markBusy();
  assert.match(titles().at(-1), /^⠋ p-ai_home-1z0bk3$/);
});

test('the spinner stops by itself once the child goes quiet', () => {
  const writes = [];
  const timers = createFakeTimers();
  let fakeNow = 1000;
  const cycler = createTerminalTitleCycler({
    processObj: { platform: 'darwin', stdout: { write: (chunk) => writes.push(String(chunk || '')) } },
    now: () => fakeNow,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    getSessionLabel: () => 'sess',
    getAccountLabel: () => 'Cline:1:m'
  });
  const titles = () => writes.map((chunk) => chunk.replace(/^\x1b\]0;/, '').replace(/\x07$/, ''));

  cycler.start();
  cycler.markBusy({ ttlMs: 2000 });
  assert.match(titles().at(-1), /^⠋ sess$/);

  // 子进程静下来之后没人会显式调用 markIdle()：转圈必须自己退出，否则空闲时
  // 标题会一直转。
  fakeNow = 3500;
  timers.tick(SPINNER_INTERVAL_MS);
  assert.equal(titles().at(-1), 'sess');
  assert.equal(timers.live(SPINNER_INTERVAL_MS).length, 0);
});

test('stop clears timers and reset restores the terminal default title', () => {
  const { cycler, titles, timers } = createCycler();
  cycler.start();
  cycler.stop();
  assert.equal(timers.live(CYCLE_INTERVAL_MS).length, 0);

  cycler.reset();
  assert.equal(titles().at(-1), '');
});

test('title text is sanitized: control characters and newlines cannot break OSC 0', () => {
  assert.equal(sanitizeTitleText('a\x07b'), 'a b');
  assert.equal(sanitizeTitleText('x\r\ny'), 'x y');
  assert.equal(sanitizeTitleText('  spaced   out  '), 'spaced out');
  assert.equal(buildTitleSequence(''), '');
  assert.equal(buildTitleSequence('Cline:1'), '\x1b]0;Cline:1\x07');
});

test('account label is provider:account[:model] and drops unknown segments', () => {
  assert.equal(
    buildAccountLabel({ provider: 'Cline', cliAccountId: '1', model: 'deepseek-xxx' }),
    'Cline:1:deepseek-xxx'
  );
  assert.equal(buildAccountLabel({ provider: 'Cline', cliAccountId: '1' }), 'Cline:1');
  assert.equal(buildAccountLabel({ provider: 'Cline', cliAccountId: '1', model: '  ' }), 'Cline:1');
  assert.equal(buildAccountLabel({}), '');
});

test('session label prefers the provider-side title over the tmux name', () => {
  assert.equal(
    buildSessionLabel({ sessionTitle: '修复登录回归', sessionName: 'p-ai_home-1z0bk3', projectName: 'ai_home' }),
    '修复登录回归'
  );
  assert.equal(buildSessionLabel({ projectName: 'ai_home' }), 'ai_home');
  assert.equal(buildSessionLabel({}), '');
});

test('machine-generated tmux session names are reduced to the project name', () => {
  // 项目会话：p-<project>-<hash6>
  assert.equal(buildSessionLabel({ sessionName: 'p-ai_home-1z0bk3' }), 'ai_home');
  assert.equal(buildSessionLabel({ sessionName: 'p-my-proj-abc123' }), 'my-proj');
  // 裸启动：p-<project>-<hash6>-<now36>[-<pid36>]
  assert.equal(buildSessionLabel({ sessionName: 'p-aih-base-wt-1ipli4-mvjtgkl2-q70' }), 'aih-base-wt');
  assert.equal(buildSessionLabel({ sessionName: 'p-aih-title-wt-vqq4if-mvjsnaqh-1lig' }), 'aih-title-wt');
  // 命名会话保留 label，默认会话原样。
  assert.equal(buildSessionLabel({ sessionName: 's-my-feature' }), 'my-feature');
  assert.equal(buildSessionLabel({ sessionName: 'default' }), 'default');
});

test('model is read from the explicit --model / -m flags first', () => {
  assert.equal(readModelFromArgs(['--model', 'gpt-5.5']), 'gpt-5.5');
  assert.equal(readModelFromArgs(['--model=gpt-5.5']), 'gpt-5.5');
  assert.equal(readModelFromArgs(['-m', 'deepseek-xxx']), 'deepseek-xxx');
  assert.equal(readModelFromArgs(['-m=deepseek-xxx']), 'deepseek-xxx');
  assert.equal(readModelFromArgs(['--model']), '');
  assert.equal(readModelFromArgs(['--model', '--verbose']), '');
  assert.equal(readModelFromArgs([]), '');
});

test('failure detection separates interrupts from upstream errors', () => {
  assert.equal(detectFailureLabel('Interrupted by user'), '已中断');
  assert.equal(detectFailureLabel('⎿  Interrupted'), '已中断');
  assert.equal(detectFailureLabel('API Error: 429'), 'API 429');
  assert.equal(detectFailureLabel('Rate limit reached'), '限流');
  assert.equal(detectFailureLabel('connection error, retrying'), '网络错误');
  assert.equal(detectFailureLabel('context window exceeded'), '上下文超限');
  // 普通正文里的 "error" 不算故障。
  assert.equal(detectFailureLabel('fixed the error handling bug'), '');
  assert.equal(detectFailureLabel('API Error: 500'), 'API 500');
});

test('provider label stays recognizable in the title bar', () => {
  assert.equal(resolveProviderShortLabel('cline'), 'Cline');
  assert.equal(resolveProviderShortLabel('codex'), 'ChatGPT');
  // agy 的产品线名太长，标题里用命令名。
  assert.equal(resolveProviderShortLabel('agy'), 'AGY');
});
