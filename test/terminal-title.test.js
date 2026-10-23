const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTerminalTitle,
  composeTerminalTitle,
  buildTitleSequence,
  sanitizeTitleText,
  SPINNER_INTERVAL_MS,
  SPINNER_FRAMES
} = require('../lib/cli/services/pty/terminal-title');
const {
  buildAccountLabel,
  buildSessionLabel,
  detectFailure,
  readModelFromArgs,
  resolveProviderShortLabel
} = require('../lib/cli/services/pty/terminal-title-labels');

// 手动驱动的定时器：让转圈动画可断言，不依赖真实时间。
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

function createTitle(overrides = {}) {
  const writes = [];
  const timers = createFakeTimers();
  let sessionLabel = overrides.sessionLabel === undefined ? 'ai_home' : overrides.sessionLabel;
  let accountLabel = overrides.accountLabel === undefined ? 'Cline:1:deepseek-v4.1' : overrides.accountLabel;
  let usageLabel = overrides.usageLabel === undefined ? '5h:91%' : overrides.usageLabel;
  let enabled = overrides.enabled === undefined ? true : overrides.enabled;
  const title = createTerminalTitle({
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
    getUsageLabel: () => usageLabel,
    ...overrides.titleOptions
  });
  return {
    title,
    writes,
    timers,
    // 每一条写入的纯文本（去掉 OSC 包装），最后一条 = 当前标题。
    texts: () => writes.map((chunk) => chunk.replace(/^\x1b\]0;/, '').replace(/\x07$/, '')),
    current: () => (writes.length ? writes.at(-1).replace(/^\x1b\]0;/, '').replace(/\x07$/, '') : ''),
    setSessionLabel: (v) => { sessionLabel = v; },
    setAccountLabel: (v) => { accountLabel = v; },
    setUsageLabel: (v) => { usageLabel = v; },
    setEnabled: (v) => { enabled = v; }
  };
}

test('the title is one line: account and usage, with the session name only when it has one', () => {
  const h = createTitle();
  h.title.start();
  // 多会话时扫一眼标签栏就要知道是哪个账号、在跑什么。
  assert.equal(h.current(), 'ai_home · Cline:1:deepseek-v4.1 · 5h:91%');

  // 没有真名字的会话：只剩账号与用量，不再挂一个推导出来的项目名。
  const unnamed = createTitle({ sessionLabel: '' });
  unnamed.title.start();
  assert.equal(unnamed.current(), 'Cline:1:deepseek-v4.1 · 5h:91%');
});

test('an idle session carries no status label — only busy and error add a prefix', () => {
  const h = createTitle();
  h.title.start();
  const idle = h.current();
  // 常态不写「已启用 / 空闲」这类噪音，否则 6 个标签全是同样的前缀。
  assert.equal(/^[⚠⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(idle), false);
});

test('busy adds the spinner and it animates through the frames', () => {
  const h = createTitle();
  h.title.start();
  h.title.markBusy();
  assert.equal(h.current(), `⠋ ai_home · Cline:1:deepseek-v4.1 · 5h:91%`);

  h.timers.tick(SPINNER_INTERVAL_MS);
  assert.equal(h.current(), `⠙ ai_home · Cline:1:deepseek-v4.1 · 5h:91%`);
  // 转圈只换前缀，身份与用量都不变。
  assert.ok(h.current().endsWith('ai_home · Cline:1:deepseek-v4.1 · 5h:91%'));
});

test('the spinner stops by itself once the child goes quiet', () => {
  let fakeNow = 1000;
  const writes = [];
  const timers = createFakeTimers();
  const title = createTerminalTitle({
    processObj: { platform: 'darwin', stdout: { write: (c) => writes.push(String(c || '')) } },
    now: () => fakeNow,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    getSessionLabel: () => 'ai_home',
    getAccountLabel: () => 'Cline:1:m',
    getUsageLabel: () => ''
  });
  const current = () => writes.at(-1).replace(/^\x1b\]0;/, '').replace(/\x07$/, '');

  title.start();
  title.markBusy({ ttlMs: 2000 });
  assert.match(current(), /^⠋ /);

  // 子进程静下来之后没人会显式调用 markIdle()：转圈必须自己退出。
  fakeNow = 3500;
  timers.tick(SPINNER_INTERVAL_MS);
  assert.equal(current(), 'ai_home · Cline:1:m');
  assert.equal(timers.live(SPINNER_INTERVAL_MS).length, 0);
});

test('an error is shown as an icon, not as text', () => {
  const h = createTitle();
  h.title.start();
  h.title.setError('\u26a0');
  // 标签栏里读文字费劲：只给一个图标，具体原因在会话屏幕里看。
  assert.equal(h.current(), '\u26a0 ai_home · Cline:1:deepseek-v4.1 · 5h:91%');

  h.title.clearError();
  assert.equal(h.current(), 'ai_home · Cline:1:deepseek-v4.1 · 5h:91%');
});

test('each failure kind carries its own icon', () => {
  // 限流直接放状态码，断网用带斜线的网络图标。
  const limited = createTitle();
  limited.title.start();
  limited.title.setError('[429]');
  assert.equal(limited.current(), '[429] ai_home · Cline:1:deepseek-v4.1 · 5h:91%');

  const offline = createTitle();
  offline.title.start();
  offline.title.setError('\u2298');
  assert.equal(offline.current(), '\u2298 ai_home · Cline:1:deepseek-v4.1 · 5h:91%');
});

test('an error expires on its own so a recovered session never stays stuck', () => {
  let fakeNow = 1000;
  const writes = [];
  const timers = [];
  const title = createTerminalTitle({
    processObj: { platform: 'darwin', stdout: { write: (c) => writes.push(String(c || '')) } },
    now: () => fakeNow,
    setInterval: (cb, ms) => { const t = { cb, ms, unref() {} }; timers.push(t); return t; },
    clearInterval: () => {},
    setTimeout: (cb, ms) => { const t = { cb, ms, unref() {} }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    getSessionLabel: () => '',
    getAccountLabel: () => 'Cline:1:m',
    getUsageLabel: () => ''
  });
  const current = () => writes.at(-1).replace(/^\x1b\]0;/, '').replace(/\x07$/, '');

  title.start();
  title.setError('[429]');
  assert.equal(current(), '[429] Cline:1:m');

  // 上游恢复后没人会来清错误：TTL 到点必须自己撤掉，否则标题永远钉在故障上
  // （用户 2026-10-23 报的「上游可以用，你却一直卡在这里」）。
  fakeNow = 1000 + 15000 + 1;
  const ttlTimer = timers.find((t) => t.ms > 0 && t.ms !== 120);
  assert.ok(ttlTimer, 'error TTL timer should be armed');
  ttlTimer.cb();
  assert.equal(current(), 'Cline:1:m');
});

test('an error outranks the spinner: the failure is what you need to see', () => {
  const h = createTitle();
  h.title.start();
  h.title.markBusy();
  h.title.setError('[429]');
  assert.match(h.current(), /^\[429\] /);
  assert.equal(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(h.current()), false);
});

test('every state change is pushed immediately — no polling tick is needed', () => {
  const h = createTitle();
  h.title.start();
  const afterStart = h.texts().length;

  // 用量事件：数字变了就重写，不等任何节拍。
  h.setUsageLabel('5h:64%');
  h.title.refresh();
  assert.equal(h.texts().length, afterStart + 1);
  assert.ok(h.current().endsWith('5h:64%'));

  // 账号事件：切号后身份段更新。
  h.setAccountLabel('Cline:3:claude-sonnet');
  h.title.refresh();
  assert.ok(h.current().includes('Cline:3:claude-sonnet'));
});

test('an unchanged status is not rewritten', () => {
  const h = createTitle();
  h.title.start();
  const before = h.texts().length;
  // 用量 watcher 会周期性触发 refresh：内容没变就不能刷终端。
  h.title.refresh();
  h.title.refresh();
  h.title.refresh();
  assert.equal(h.texts().length, before);
});

test('segments degrade gracefully: a missing usage or session still leaves a usable title', () => {
  const noUsage = createTitle({ usageLabel: '' });
  noUsage.title.start();
  assert.equal(noUsage.current(), 'ai_home · Cline:1:deepseek-v4.1');

  const noSession = createTitle({ sessionLabel: '' });
  noSession.title.start();
  assert.equal(noSession.current(), 'Cline:1:deepseek-v4.1 · 5h:91%');

  // 全空则什么都不写——绝不写空标题（那会让终端回落到默认命名）。
  const empty = createTitle({ sessionLabel: '', accountLabel: '', usageLabel: '' });
  empty.title.start();
  assert.deepEqual(empty.writes, []);
});

test('nothing is written while the title surface is disabled or suppressed', () => {
  const disabled = createTitle({ enabled: false });
  disabled.title.start();
  assert.deepEqual(disabled.writes, []);

  const suppressed = createTitle({ suppressed: true });
  suppressed.title.start();
  assert.deepEqual(suppressed.writes, []);
});

test('the title never touches the screen: only OSC 0 sequences are written', () => {
  const h = createTitle();
  h.title.start();
  h.title.markBusy();
  h.timers.tick(SPINNER_INTERVAL_MS);
  h.title.setError('网络错误');
  for (const chunk of h.writes) {
    assert.match(chunk, /^\x1b\]0;[^\x07]*\x07$/);
  }
});

test('stop clears timers and reset restores the terminal default title', () => {
  const h = createTitle();
  h.title.start();
  h.title.markBusy();
  h.title.stop();
  assert.equal(h.timers.live(SPINNER_INTERVAL_MS).length, 0);

  h.title.reset();
  assert.equal(h.texts().at(-1), '');
});

test('title text is sanitized: control characters and newlines cannot break OSC 0', () => {
  assert.equal(sanitizeTitleText('a\x07b'), 'a b');
  assert.equal(sanitizeTitleText('x\r\ny'), 'x y');
  assert.equal(sanitizeTitleText('  spaced   out  '), 'spaced out');
  assert.equal(buildTitleSequence(''), '');
  assert.equal(buildTitleSequence('Cline:1'), '\x1b]0;Cline:1\x07');
});

test('composeTerminalTitle is pure and truncates the least important segment first', () => {
  assert.equal(composeTerminalTitle({}), '');
  assert.equal(
    composeTerminalTitle({ sessionLabel: 's', accountLabel: 'a', usageLabel: 'u' }),
    's · a · u'
  );
  assert.equal(
    composeTerminalTitle({ sessionLabel: 's', accountLabel: 'a', busy: true, frame: 3, frames: SPINNER_FRAMES }),
    `${SPINNER_FRAMES[3]} s · a`
  );
  // 会话身份限长比账号/用量短：截断时先牺牲后面的段。
  const long = composeTerminalTitle({
    sessionLabel: 'x'.repeat(200),
    accountLabel: 'a'.repeat(200),
    usageLabel: 'u'.repeat(200)
  });
  assert.ok(long.length <= 160);
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

test('the session segment only carries a real name, never a derived project name', () => {
  // provider 侧的可读标题优先。
  assert.equal(
    buildSessionLabel({ sessionTitle: '修复登录回归', sessionName: 'p-ai_home-1z0bk3' }),
    '修复登录回归'
  );
  // 用户显式命名的会话保留 label。
  assert.equal(buildSessionLabel({ sessionName: 's-my-feature' }), 'my-feature');
  // 机器推导的名字一律不显示：同一项目的多个会话共用一个目录名，既占宽又区分不了
  // 谁是谁（用户 2026-10-23 明确否掉）。
  assert.equal(buildSessionLabel({ sessionName: 'p-ai_home-1z0bk3' }), '');
  assert.equal(buildSessionLabel({ sessionName: 'p-aih-base-wt-1ipli4-mvjtgkl2-q70' }), '');
  assert.equal(buildSessionLabel({ sessionName: 'default' }), '');
  assert.equal(buildSessionLabel({}), '');
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

test('failure detection classifies the fault so the title can pick an icon', () => {
  assert.equal(detectFailure('Interrupted by user').icon, '\u26a0');
  assert.equal(detectFailure('⎿  Interrupted').kind, 'interrupted');
  assert.equal(detectFailure('API Error: 429').kind, 'rate_limited');
  assert.equal(detectFailure('Rate limit reached').icon, '[429]');
  assert.equal(detectFailure('connection error, retrying').kind, 'network');
  assert.equal(detectFailure('fetch failed').icon, '\u2298');
  assert.equal(detectFailure('API Error: 500').kind, 'upstream');
  assert.equal(detectFailure('context window exceeded').kind, 'context_limit');
  // 普通正文里的 "error" 不算故障。
  assert.equal(detectFailure('fixed the error handling bug'), null);
  assert.equal(detectFailure(''), null);
});

test('the provider segment matches the command the user actually typed', () => {
  // 账号页的 label 有时是产品线（codex → ChatGPT），放进标题会对不上敲的命令。
  assert.equal(resolveProviderShortLabel('codex'), 'Codex');
  assert.equal(resolveProviderShortLabel('claude'), 'Claude');
  assert.equal(resolveProviderShortLabel('cline'), 'Cline');
  assert.equal(resolveProviderShortLabel('agy'), 'AGY');
  assert.equal(resolveProviderShortLabel('opencode'), 'OpenCode');
  assert.equal(resolveProviderShortLabel('zcode'), 'ZCode');
  assert.equal(resolveProviderShortLabel(''), '');
});
