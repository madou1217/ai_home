'use strict';

// Headless direct spawn: non-interactive runs (claude -p, codex exec, …) need
// no PTY, no tmux and no interactive runtime — spawn the CLI directly, stream
// stdio, mirror the exit code. Extracted from pty/runtime.js; spawnPty consults
// shouldUse... first.
//
// The provider trigger table is NOT here: detection lives in
// headless-invocation.js, which reads the generated provider contract.

const { detectHeadlessInvocation } = require('./headless-invocation');

function createHeadlessSpawn(deps = {}) {
  const {
    spawn,
    processObj
  } = deps;
  // headless 的第二条通路：由 launch-profile 门面按策略声明解析（派发层不认 provider 名）。
  // 未注入时行为逐字节等于从前（永远走 native spawn）。
  const resolveHeadlessRunner = typeof deps.resolveHeadlessRunner === 'function'
    ? deps.resolveHeadlessRunner
    : () => null;

  function shouldUseHeadlessDirectSpawn(cliName, args, isLogin) {
    return detectHeadlessInvocation(cliName, args, {
      isLogin,
      env: processObj.env
    }).headless;
  }

  // 策略声明了 headless runner（如 zcode 的 app-server 通道）时，用**垫片进程**替换启动规格：
  // 垫片内部调 runner，于是 stdout/stderr/exitCode 语义与 native 逐字节一致，
  // handle / 缓冲 / 回灌 / 退出码转发都不用改（见 headless-runner-trampoline.js）。
  //
  // 选择顺序（策略化 + 可选）：
  //   * options.headlessRunner = 'native'      → 强制 native（逃生门）
  //   * options.headlessRunner = 'app-server'  → 强制走 runner
  //   * 'auto'（默认）                          → runner 的 shouldPrefer() 说了算
  function buildRunnerTrampolineLaunch(input) {
    const fsImpl = deps.fs || require('node:fs');
    const pathImpl = deps.path || require('node:path');
    const osImpl = deps.os || require('node:os');
    const spec = {
      provider: String(input.provider || '').trim(),
      env: input.env || {},
      launch: { command: input.launch && input.launch.command, args: input.launch && input.launch.args },
      args: Array.isArray(input.args) ? input.args : [],
      deps: input.deps || {}
    };
    const dir = pathImpl.join(osImpl.tmpdir(), 'aih-headless-runner');
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const specPath = pathImpl.join(dir, `spec-${processObj.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
    fsImpl.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
    return {
      command: processObj.execPath || process.execPath,
      args: [require.resolve('./headless-runner-trampoline'), specPath],
      specPath
    };
  }

  function resolveRunnerLaunchSpec(launch, options = {}) {
    const runner = resolveHeadlessRunner(options.provider);
    if (!runner) return null;
    const mode = String(options.headlessRunner || 'auto').trim().toLowerCase();
    if (mode === 'native' || mode === 'off') return null;
    const runnerDeps = { ...(options.headlessRunnerDeps || {}) };
    const forced = mode === 'app-server' || mode === 'runner';
    const preferred = !forced && typeof runner.shouldPrefer === 'function'
      && Boolean(runner.shouldPrefer({ env: options.env, args: launch && launch.args, launch, deps: runnerDeps }));
    if (!forced && !preferred) return null;
    return buildRunnerTrampolineLaunch({
      provider: options.provider,
      env: options.env,
      launch,
      args: launch && launch.args,
      deps: runnerDeps
    });
  }

  // stream-json 输入模式需要经 stdin 流式喂入；headless 默认忽略 stdin，此时须接通并转发。
  function headlessWantsStdin(provider, args) {
    return detectHeadlessInvocation(provider, args, { env: processObj.env }).wantsStdin;
  }

  function spawnHeadlessDirect(launch, options = {}) {
    const bufferedData = [];
    const bufferedErrorData = [];
    let dataHandler = null;
    let errorDataHandler = null;
    let exitHandler = null;
    let pendingExit = null;
    let child = null;
    // 仅当请求 stream-json 输入时接通 stdin；普通 `-p "text"`（prompt 在 argv）仍忽略 stdin，行为不变。
    const wantsStdin = headlessWantsStdin(options.provider, launch && launch.args);

    const emitData = (chunk) => {
      const text = String(chunk || '');
      if (!text) return;
      if (dataHandler) {
        dataHandler(text);
        return;
      }
      bufferedData.push(text);
    };
    // 子进程 stderr 单独成流：只有这样 `out=$(aih ... -p ...)` 捕获到的才是纯正文。
    // 没有消费者时不丢弃——退出时回灌到 stdout 通道，保持旧行为不静默吞日志。
    const emitErrorData = (chunk) => {
      const text = String(chunk || '');
      if (!text) return;
      if (errorDataHandler) {
        errorDataHandler(text);
        return;
      }
      bufferedErrorData.push(text);
    };
    const drainUnconsumedErrorData = () => {
      if (errorDataHandler) return;
      while (bufferedErrorData.length > 0) {
        emitData(bufferedErrorData.shift());
      }
    };
    const emitExit = (exitCode) => {
      drainUnconsumedErrorData();
      const event = { exitCode: exitCode == null ? 1 : Number(exitCode) };
      if (exitHandler) {
        exitHandler(event);
        return;
      }
      pendingExit = event;
    };

    try {
      // 策略声明了 headless runner 且本次应走它时，用垫片进程替换启动规格。
      const runnerLaunch = resolveRunnerLaunchSpec(launch, options);
      const effectiveLaunch = runnerLaunch || launch;
      child = spawn(effectiveLaunch.command, Array.isArray(effectiveLaunch.args) ? effectiveLaunch.args : [], {
        cwd: processObj.cwd(),
        env: options.env,
        stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      emitErrorData(`${String((error && error.message) || error)}\n`);
      emitExit(1);
    }

    if (child) {
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', emitData);
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', emitErrorData);
      }
      if (typeof child.on === 'function') {
        child.on('error', (error) => {
          emitErrorData(`${String((error && error.message) || error)}\n`);
          emitExit(1);
        });
        child.on('close', emitExit);
      }
      // 接通父进程 stdin → 子进程 stdin（stream-json 流式输入）；EOF 经 pipe 自动透传，
      // 子进程据此结束当前请求并输出。普通路径 wantsStdin=false，此段不执行。
      if (wantsStdin && child.stdin && processObj.stdin && typeof processObj.stdin.pipe === 'function') {
        try {
          processObj.stdin.pipe(child.stdin);
          processObj.stdin.on('error', () => {});
          child.stdin.on('error', () => {});
        } catch (_) { /* stdin 不可用则忽略 */ }
      }
    }

    return {
      aihHeadlessDirect: true,
      onData(cb) {
        dataHandler = typeof cb === 'function' ? cb : null;
        while (dataHandler && bufferedData.length > 0) {
          dataHandler(bufferedData.shift());
        }
      },
      onErrorData(cb) {
        errorDataHandler = typeof cb === 'function' ? cb : null;
        while (errorDataHandler && bufferedErrorData.length > 0) {
          errorDataHandler(bufferedErrorData.shift());
        }
      },
      onExit(cb) {
        exitHandler = typeof cb === 'function' ? cb : null;
        if (exitHandler && pendingExit) {
          const event = pendingExit;
          pendingExit = null;
          exitHandler(event);
        }
      },
      write(data) {
        // 防御性转发（headless 路径当前不经此调用，stdin 已由上面的 pipe 接通）。
        if (wantsStdin && child && child.stdin && child.stdin.writable) {
          try { child.stdin.write(data); } catch (_) { /* ignore */ }
        }
      },
      resize() {},
      kill() {
        if (child && typeof child.kill === 'function') {
          child.kill();
        }
      }
    };
  }


  return {
    shouldUseHeadlessDirectSpawn,
    spawnHeadlessDirect
  };
}

module.exports = {
  createHeadlessSpawn
};
