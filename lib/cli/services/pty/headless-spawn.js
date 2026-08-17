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

  function shouldUseHeadlessDirectSpawn(cliName, args, isLogin) {
    return detectHeadlessInvocation(cliName, args, {
      isLogin,
      env: processObj.env
    }).headless;
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
      child = spawn(launch.command, Array.isArray(launch.args) ? launch.args : [], {
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
