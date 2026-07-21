'use strict';

// Headless direct spawn: claude -p / --print runs need no PTY, no tmux and no
// interactive runtime — spawn the CLI directly, stream stdio, mirror the exit
// code. Extracted from pty/runtime.js; spawnPty consults shouldUse... first.

function createHeadlessSpawn(deps = {}) {
  const {
    spawn,
    processObj
  } = deps;

  function shouldUseHeadlessDirectSpawn(cliName, args, isLogin) {
    if (isLogin) return false;
    if (String(processObj.env.AIH_HEADLESS_DIRECT_SPAWN || '1') === '0') return false;
    if (cliName !== 'claude') return false;
    return (Array.isArray(args) ? args : []).some((arg) => {
      const token = String(arg || '').trim();
      return token === '-p' || token === '--print' || token.startsWith('--print=');
    });
  }

  // stream-json 输入模式需要经 stdin 流式喂入；headless 默认忽略 stdin，此时须接通并转发。
  function headlessWantsStdin(args) {
    const list = Array.isArray(args) ? args : [];
    for (let i = 0; i < list.length; i++) {
      const t = String(list[i] || '').trim();
      if (t === '--input-format=stream-json') return true;
      if (t === '--input-format' && String(list[i + 1] || '').trim() === 'stream-json') return true;
    }
    return false;
  }

  function spawnHeadlessDirect(launch, options = {}) {
    const bufferedData = [];
    let dataHandler = null;
    let exitHandler = null;
    let pendingExit = null;
    let child = null;
    // 仅当请求 stream-json 输入时接通 stdin；普通 `-p "text"`（prompt 在 argv）仍忽略 stdin，行为不变。
    const wantsStdin = headlessWantsStdin(launch && launch.args);

    const emitData = (chunk) => {
      const text = String(chunk || '');
      if (!text) return;
      if (dataHandler) {
        dataHandler(text);
        return;
      }
      bufferedData.push(text);
    };
    const emitExit = (exitCode) => {
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
      emitData(`${String((error && error.message) || error)}\n`);
      emitExit(1);
    }

    if (child) {
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', emitData);
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', emitData);
      }
      if (typeof child.on === 'function') {
        child.on('error', (error) => {
          emitData(`${String((error && error.message) || error)}\n`);
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
      onData(cb) {
        dataHandler = typeof cb === 'function' ? cb : null;
        while (dataHandler && bufferedData.length > 0) {
          dataHandler(bufferedData.shift());
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
