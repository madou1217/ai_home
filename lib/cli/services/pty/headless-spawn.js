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
    // **native 失败自动换路**（策略声明了 headless runner 时）：native 子进程的输出
    // 命中 runner 的 shouldFallbackFromNative 签名（如 zcode 的 "Select a model…"）
    // 就用 runner 垫片进程重跑一次，stdout/stderr/exitCode 语义对外不变。transcript
    // 只用于签名匹配且有界（签名文案都出现在输出的前面）。
    const TRANSCRIPT_LIMIT = 64 * 1024;
    let transcript = '';
    let runnerFallbackUsed = false;
    // 非 null = native 尝试的 stderr 暂扣中（换路场景）。官方 CLI 失败时抛未捕获
    // 异常，stderr 里是几百 KB 的压缩 bundle 源码墙——反正要换路重试，就没必要
    // 原样泼给用户：只留一行简明原因，其余丢弃；不换路时退出前原样回放（行为不变）。
    let heldStderr = null;

    const noteTranscript = (text) => {
      transcript += text;
      if (transcript.length > TRANSCRIPT_LIMIT) transcript = transcript.slice(0, TRANSCRIPT_LIMIT);
    };
    const flushHeldStderr = () => {
      if (!heldStderr) return;
      for (const chunk of heldStderr) emitErrorData(chunk);
      heldStderr = null;
    };
    const firstHeldStderrLine = () => (heldStderr || []).join('')
      .split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';

    const emitData = (chunk) => {
      const text = String(chunk || '');
      if (!text) return;
      noteTranscript(text);
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
      noteTranscript(text);
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

    function wireChild(nextChild, { allowNativeFallback, holdStderr }) {
      if (nextChild.stdout && typeof nextChild.stdout.on === 'function') {
        nextChild.stdout.on('data', emitData);
      }
      if (nextChild.stderr && typeof nextChild.stderr.on === 'function') {
        nextChild.stderr.on('data', (text) => {
          if (holdStderr && heldStderr) {
            const value = String(text || '');
            noteTranscript(value);
            heldStderr.push(value);
            return;
          }
          emitErrorData(text);
        });
      }
      if (typeof nextChild.on === 'function') {
        nextChild.on('error', (error) => {
          flushHeldStderr();
          emitErrorData(`${String((error && error.message) || error)}\n`);
          emitExit(1);
        });
        nextChild.on('close', (code) => {
          if (allowNativeFallback && maybeFallbackFromNative()) return;
          flushHeldStderr();
          emitExit(code);
        });
      }
    }

    // native 首跑的输出命中签名时，用 runner 垫片进程换路重跑。只有 auto 且首跑是
    // native（不是被强制替换的 runner）才允许；换路最多一次，失败原样透出。
    function maybeFallbackFromNative() {
      if (runnerFallbackUsed || !nativeFirstAttempt) return false;
      const runner = resolveHeadlessRunner(options.provider);
      if (!runner || typeof runner.shouldFallbackFromNative !== 'function') return false;
      if (!runner.shouldFallbackFromNative(transcript)) return false;
      runnerFallbackUsed = true;
      // 一行简明原因替代 stderr 源码墙（traceId 保留在首行里，够定位）。
      const nativeReason = firstHeldStderrLine().slice(0, 200);
      emitErrorData(`[aih] native 直跑失败${nativeReason ? `（${nativeReason}）` : ''}，自动改走 ${String(runner.id || 'runner')} 通路重试\n`);
      heldStderr = null;
      const trampoline = buildRunnerTrampolineLaunch({
        provider: options.provider,
        env: options.env,
        launch,
        args: launch && launch.args,
        deps: options.headlessRunnerDeps || {}
      });
      try {
        child = spawn(trampoline.command, Array.isArray(trampoline.args) ? trampoline.args : [], {
          cwd: processObj.cwd(),
          env: options.env,
          stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        emitErrorData(`${String((error && error.message) || error)}\n`);
        emitExit(1);
        return true;
      }
      // 换路子进程不再二次换路；stdin 不重接（wantsStdin 仅 stream-json 输入模式，
      // prompt 在 argv 的通路用不到）。
      wireChild(child, { allowNativeFallback: false });
      return true;
    }

    // 策略声明了 headless runner 且本次应走它时，用垫片进程替换启动规格。
    const runnerLaunch = resolveRunnerLaunchSpec(launch, options);
    const effectiveLaunch = runnerLaunch || launch;
    // 只有首跑就是 native（runner 未被强制启用）才允许失败换路；'native'/'off' 模式
    // 明确关闭换路。
    const headlessRunnerMode = String(options.headlessRunner || 'auto').trim().toLowerCase();
    const nativeFirstAttempt = !runnerLaunch
      && headlessRunnerMode !== 'native'
      && headlessRunnerMode !== 'off';
    // 换路能力存在时暂扣 native stderr（见 heldStderr 注释）；其余形态零行为差异。
    const fallbackCandidate = nativeFirstAttempt ? resolveHeadlessRunner(options.provider) : null;
    const holdNativeStderr = Boolean(fallbackCandidate
      && typeof fallbackCandidate.shouldFallbackFromNative === 'function');
    if (holdNativeStderr) heldStderr = [];

    try {
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
      wireChild(child, { allowNativeFallback: true, holdStderr: holdNativeStderr });
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
