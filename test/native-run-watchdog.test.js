'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_FIRST_PROGRESS_TIMEOUT_MS,
  DEFAULT_UPSTREAM_ERROR_TIMEOUT_MS,
  MAX_ADVISED_RETRY_WAIT_MS,
  NATIVE_SESSION_TIMEOUT_CODE,
  classifyWatchdogEvent,
  createNativeRunWatchdog,
  resolveNativeRunWatchdogConfig
} = require('../lib/server/native-run-watchdog');
const { spawnNativeSessionStream } = require('../lib/server/native-session-chat');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');

// 虚拟时钟：看门狗的阈值是分钟级的，真跑会把单测拖成龟速，且拿不到确定性。
function createClock() {
  let current = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeoutImpl(fn, delay) {
      const id = ++seq;
      timers.set(id, { fn, at: current + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (!next || timer.at < next.timer.at) next = { id, timer };
        }
        if (!next || next.timer.at > target) break;
        current = next.timer.at;
        timers.delete(next.id);
        next.timer.fn();
      }
      current = target;
    }
  };
}

function createWatchdog(clock, options = {}) {
  const fired = [];
  const watchdog = createNativeRunWatchdog({
    env: {},
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    firstProgressTimeoutMs: 120000,
    upstreamErrorTimeoutMs: 45000,
    stallTimeoutMs: 0,
    onTimeout: (info) => fired.push(info),
    ...options
  });
  return { watchdog, fired };
}

test('watchdog classifies only real upstream progress as a heartbeat', () => {
  assert.equal(classifyWatchdogEvent({ type: 'delta', delta: 'hi' }), 'progress');
  assert.equal(classifyWatchdogEvent({ type: 'result', content: 'done' }), 'progress');
  assert.equal(classifyWatchdogEvent({ type: 'assistant_tool_call' }), 'progress');
  assert.equal(classifyWatchdogEvent({ type: 'assistant_tool_result' }), 'progress');
  // 重连/错误行不是心跳——codex 每 ~40s 吐一条 `Reconnecting... n/5`，
  // 朴素 idle 计时器会被它们永久续命，那正是 216s 才报错的老行为。
  assert.equal(classifyWatchdogEvent({ type: 'error', message: 'Reconnecting... 1/5' }), 'upstream-failure');
  assert.equal(classifyWatchdogEvent({ type: 'retry-status', attempt: 2 }), 'upstream-failure');
  assert.equal(classifyWatchdogEvent({ type: 'interactive-prompt' }), 'pause');
  assert.equal(classifyWatchdogEvent({ type: 'interactive-prompt-cleared' }), 'resume');
  assert.equal(classifyWatchdogEvent({ type: 'session-created' }), 'ignore');
  assert.equal(classifyWatchdogEvent({ type: 'runtime-blocked' }), 'ignore');
  assert.equal(classifyWatchdogEvent(null), 'ignore');
  // headless JSON 流里的 terminal-output 是 CLI 自己的 stderr 噪声，不能当上游心跳；
  // 交互式 CLI 下它才是模型输出本身。
  assert.equal(classifyWatchdogEvent({ type: 'terminal-output', text: 'x' }), 'ignore');
  assert.equal(
    classifyWatchdogEvent({ type: 'terminal-output', text: 'x' }, { terminalOutputIsProgress: true }),
    'progress'
  );
});

test('watchdog defaults come from the measured TTFT distribution and stay env-overridable', () => {
  const defaults = resolveNativeRunWatchdogConfig({});
  assert.equal(defaults.enabled, true);
  // 实测 TTFT p99.5 = 83.4s：120s 静默预算只砍掉 0.288% 的轮次,会话首轮无一命中。
  assert.equal(defaults.firstProgressTimeoutMs, DEFAULT_FIRST_PROGRESS_TIMEOUT_MS);
  assert.equal(DEFAULT_FIRST_PROGRESS_TIMEOUT_MS, 120000);
  // 7 次重试风暴 0 次自愈,重连行 ~40s 一条：45s 够看完一次完整重试失败,不必等满 216s。
  assert.equal(defaults.upstreamErrorTimeoutMs, DEFAULT_UPSTREAM_ERROR_TIMEOUT_MS);
  assert.equal(DEFAULT_UPSTREAM_ERROR_TIMEOUT_MS, 45000);
  // stall 默认关闭：30 天里有 5 次合法的多小时本地工具执行(最长 12.4h),
  // 任何分钟级预算都会误杀它们,而 headless 流拿不到「工具在跑」的信号来豁免。
  assert.equal(defaults.stallTimeoutMs, 0);

  const tuned = resolveNativeRunWatchdogConfig({
    AIH_NATIVE_FIRST_PROGRESS_TIMEOUT_MS: '90000',
    AIH_NATIVE_UPSTREAM_ERROR_TIMEOUT_MS: '30000',
    AIH_NATIVE_STALL_TIMEOUT_MS: '600000'
  });
  assert.equal(tuned.firstProgressTimeoutMs, 90000);
  assert.equal(tuned.upstreamErrorTimeoutMs, 30000);
  assert.equal(tuned.stallTimeoutMs, 600000);

  assert.equal(resolveNativeRunWatchdogConfig({ AIH_NATIVE_RUN_WATCHDOG: '0' }).enabled, false);
  assert.equal(resolveNativeRunWatchdogConfig({}, { enabled: false }).enabled, false);
  // 垃圾值不许把预算变成 NaN（NaN 比较恒 false = 永不熔断）。
  assert.equal(
    resolveNativeRunWatchdogConfig({ AIH_NATIVE_FIRST_PROGRESS_TIMEOUT_MS: 'soon' }).firstProgressTimeoutMs,
    DEFAULT_FIRST_PROGRESS_TIMEOUT_MS
  );
});

test('watchdog breaks a silent run once the first-progress budget is spent', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  clock.advance(119999);
  assert.equal(fired.length, 0);
  clock.advance(2);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].code, NATIVE_SESSION_TIMEOUT_CODE);
  assert.equal(fired[0].reason, 'no_first_progress');
  assert.equal(fired[0].limitMs, 120000);
  assert.ok(fired[0].elapsedMs >= 120000);
});

test('watchdog leaves a slow but healthy turn alone once upstream answers', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  // 实测 p50 ≈ 15s：这类轮次绝不能被熔断（10s 阈值会误杀约八成）。
  clock.advance(15000);
  watchdog.observe({ type: 'delta', delta: 'hello' });
  clock.advance(600000);

  assert.equal(fired.length, 0);
  assert.equal(watchdog.snapshot().firstProgressAt > 0, true);
});

test('watchdog cuts a retry storm short instead of waiting out all five attempts', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock, { upstreamErrorTimeoutMs: 45000 });
  watchdog.start();

  // aihub 502 复现：codex 每 ~40s 一条 Reconnecting，5 次跑完要 ~216s。
  clock.advance(3000);
  watchdog.observe({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 502 Bad Gateway)' });
  clock.advance(40000);
  watchdog.observe({ type: 'error', message: 'Reconnecting... 2/5 (unexpected status 502 Bad Gateway)' });
  assert.equal(fired.length, 0);
  clock.advance(6000);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'upstream_error_persisted');
  assert.equal(fired[0].limitMs, 45000);
  // 第一条失败信号起算，不被后续重连行续命。
  assert.equal(fired[0].sinceUpstreamFailureMs, 45000);
  assert.match(fired[0].lastUpstreamFailure, /Reconnecting\.\.\. 2\/5/);
  assert.match(fired[0].message, /上游持续报错 45s 未恢复/);
});

test('watchdog forgives a transient upstream error that recovers', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock, { upstreamErrorTimeoutMs: 45000 });
  watchdog.start();

  clock.advance(3000);
  watchdog.observe({ type: 'error', message: 'Reconnecting... 1/5' });
  clock.advance(20000);
  watchdog.observe({ type: 'delta', delta: 'recovered' });
  clock.advance(600000);

  assert.equal(fired.length, 0);
  assert.equal(watchdog.snapshot().upstreamFailureAt, 0);
});

test('watchdog waits out a retry the upstream itself scheduled', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  // claude 429 会带 retry_delay_ms：上游明说 90s 后重试,45s 预算不能抢在它前面动手,
  // 否则一个排好队的健康重试会被当成故障杀掉。
  clock.advance(3000);
  watchdog.observe({ type: 'retry-status', phase: 'retrying', retryAfterMs: 90000, message: 'rate limited' });

  clock.advance(45000);
  assert.equal(fired.length, 0, '还没到上游承诺的重试时刻,不该熔断');
  clock.advance(89999);
  assert.equal(fired.length, 0);
  clock.advance(2);

  // 等到承诺时刻之后,再给一个完整预算让这次重试自证,总计 90s + 45s。
  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'upstream_error_persisted');
  assert.equal(fired[0].sinceUpstreamFailureMs, 135000);
  assert.equal(fired[0].limitMs, 135000);
});

test('watchdog caps an absurd advertised retry instead of hanging forever', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  assert.equal(MAX_ADVISED_RETRY_WAIT_MS, 300000);
  // retryAt 是绝对时间戳,单位错配(秒当毫秒/时钟不同源)就会算出一个天荒地老的未来。
  // 认下去等于看门狗被缴械,所以必须封顶。
  clock.advance(3000);
  watchdog.observe({ type: 'retry-status', phase: 'retrying', retryAt: 9e15 });

  clock.advance(MAX_ADVISED_RETRY_WAIT_MS + 44999);
  assert.equal(fired.length, 0);
  clock.advance(2);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'upstream_error_persisted');
  assert.equal(fired[0].limitMs, MAX_ADVISED_RETRY_WAIT_MS + 45000);
});

test('watchdog drops a stale retry floor once upstream recovers', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  clock.advance(3000);
  watchdog.observe({ type: 'retry-status', phase: 'retrying', retryAfterMs: 90000 });
  assert.ok(watchdog.snapshot().upstreamRetryFloorAt > 0);

  watchdog.observe({ type: 'delta', delta: 'recovered' });
  assert.equal(watchdog.snapshot().upstreamRetryFloorAt, 0, '恢复后旧承诺必须作废');

  // 下一次失败没带任何退避承诺,就该老老实实按 45s 预算熔断,不能沾上一轮的光。
  clock.advance(1000);
  watchdog.observe({ type: 'error', message: 'Reconnecting... 1/5' });
  clock.advance(44999);
  assert.equal(fired.length, 0);
  clock.advance(2);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].sinceUpstreamFailureMs, 45000);
});

test('watchdog shifts an advertised retry deadline across an approval pause', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  clock.advance(3000);
  watchdog.observe({ type: 'retry-status', phase: 'retrying', retryAfterMs: 90000 });
  // 退避期间用户又被叫去审批：这段等人时间同样不能吃掉上游的重试窗口,
  // 否则一恢复计时就已经越过承诺时刻,直接误杀。
  watchdog.pause();
  clock.advance(600000);
  watchdog.resume();

  clock.advance(134999);
  assert.equal(fired.length, 0);
  clock.advance(2);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].sinceUpstreamFailureMs, 135000);
});

test('watchdog stops counting while a run waits on the user', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  clock.advance(10000);
  watchdog.observe({ type: 'interactive-prompt', prompt: { id: 'p1' } });
  // 用户去开会了：等人不是上游慢，这段时间不能计入预算。
  clock.advance(3600000);
  assert.equal(fired.length, 0);
  watchdog.observe({ type: 'interactive-prompt-cleared', promptId: 'p1' });

  clock.advance(109998);
  assert.equal(fired.length, 0);
  clock.advance(3);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'no_first_progress');
});

test('watchdog keeps the clock stopped until every concurrent approval is answered', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  // codex 一轮里并行发两个工具审批是常态：先回的那个不能把表重新启动。
  clock.advance(10000);
  watchdog.pause();
  watchdog.pause();
  clock.advance(600000);
  watchdog.resume();
  assert.equal(watchdog.snapshot().paused, true);
  clock.advance(600000);
  assert.equal(fired.length, 0, '还有审批在等,不该熔断');

  watchdog.resume();
  assert.equal(watchdog.snapshot().paused, false);
  clock.advance(109998);
  assert.equal(fired.length, 0);
  clock.advance(3);
  assert.equal(fired.length, 1);
  // 两段等待共 1200s 全部不计入预算：熔断点仍是「净耗时 120s」。
  assert.equal(fired[0].reason, 'no_first_progress');
});

test('watchdog treats a replaced interactive prompt as one latch, not a second hold', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();

  // 探测器换 prompt 时直接再发 interactive-prompt(不补 cleared)：
  // 若按计数停表,单条 cleared 永远解不开锁,看门狗就等于被永久缴械。
  clock.advance(5000);
  watchdog.observe({ type: 'interactive-prompt', prompt: { promptId: 'p1' } });
  watchdog.observe({ type: 'interactive-prompt', prompt: { promptId: 'p2' } });
  clock.advance(600000);
  assert.equal(fired.length, 0);
  watchdog.observe({ type: 'interactive-prompt-cleared', promptId: 'p2' });
  assert.equal(watchdog.snapshot().paused, false);

  clock.advance(115001);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'no_first_progress');
});

test('watchdog stop() disarms every pending timer', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock);
  watchdog.start();
  clock.advance(1000);
  watchdog.stop();

  clock.advance(600000);
  assert.equal(fired.length, 0);
  assert.equal(clock.pending(), 0);
});

test('watchdog stays disarmed when disabled', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock, { enabled: false });
  watchdog.start();
  watchdog.observe({ type: 'error', message: 'Reconnecting... 1/5' });
  clock.advance(3600000);

  assert.equal(watchdog.enabled, false);
  assert.equal(fired.length, 0);
  assert.equal(clock.pending(), 0);
});

test('watchdog optionally breaks a stalled run after progress started', () => {
  const clock = createClock();
  const { watchdog, fired } = createWatchdog(clock, { stallTimeoutMs: 300000 });
  watchdog.start();

  clock.advance(9000);
  watchdog.observe({ type: 'delta', delta: 'hi' });
  clock.advance(299999);
  assert.equal(fired.length, 0);
  clock.advance(2);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'stalled');
});

test('native codex run breaks out of a retry storm with a distinct timeout code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-watchdog-'));
  const originalTmuxRuns = process.env.AIH_WEBUI_TMUX_RUNS;
  t.after(() => {
    if (originalTmuxRuns === undefined) delete process.env.AIH_WEBUI_TMUX_RUNS;
    else process.env.AIH_WEBUI_TMUX_RUNS = originalTmuxRuns;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // tmux run 会把进程甩到 server 之外，单测里只验证看门狗本身，走 nodePty 分支。
  process.env.AIH_WEBUI_TMUX_RUNS = '0';

  const binDir = path.join(root, 'bin');
  const projectPath = path.join(root, 'project');
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });

  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'apikey:codex:watchdog@example.com'
  }).accountRef;
  writeAccountCredentials(fs, aiHomeDir, accountRef, { OPENAI_API_KEY: 'sk-watchdog-test' });
  const runtimeDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codex', accountRef);

  // 上游一直 502：CLI 自己重试到死也不退出，正是老故障里那个「只能干等 216s」的形状。
  fs.writeFileSync(path.join(binDir, 'codex'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'watchdog-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'error',
  message: 'Reconnecting... 1/5 (unexpected status 502 Bad Gateway: url: https://upstream.example.com/v1/responses)'
}) + '\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  fs.chmodSync(path.join(binDir, 'codex'), 0o755);

  const events = [];
  const stream = spawnNativeSessionStream({
    provider: 'codex',
    accountRef,
    projectPath,
    prompt: 'hello',
    aiHomeDir,
    env: {
      ...process.env,
      HOME: root,
      AIH_HOST_HOME: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
    },
    watchdogEnv: {},
    firstProgressTimeoutMs: 60000,
    upstreamErrorTimeoutMs: 400,
    getProfileDir: () => runtimeDir,
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0, unresolved: [] }),
    onEvent: (event) => events.push(event)
  });

  const error = await stream.done.then(
    (value) => { throw new Error(`expected timeout, got ${JSON.stringify(value)}`); },
    (failure) => failure
  );

  assert.equal(error.code, NATIVE_SESSION_TIMEOUT_CODE);
  assert.equal(error.timeoutReason, 'upstream_error_persisted');
  assert.match(error.message, /上游持续报错/);
  assert.match(error.message, /502 Bad Gateway/);
  // 熔断必须真把进程收掉——挂着的子进程正是「done 永不 settle」的来源。
  const pid = Number(stream.child && stream.child.pid);
  assert.ok(Number.isFinite(pid) && pid > 0);
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (_error) {
      alive = false;
    }
  }
  assert.equal(alive, false, 'watchdog 熔断后不能留下孤儿进程');
  assert.ok(events.some((event) => event.type === 'error' && event.code === NATIVE_SESSION_TIMEOUT_CODE));
});
