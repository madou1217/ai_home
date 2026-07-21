'use strict';

// server 启动时收养 tmux 化 native run 的孤儿：
// 上一个 server 进程死掉（部署重启/崩溃）时,tmux 里的 CLI run 还活着（这正是 tmux 化的意义）。
// 新 server 起来后据磁盘清单把它们重新注册进 run registry —— /chat/runs 能看到、可 abort、
// 可回写输入;继续 tail 日志,跑完走注入的 onRunFinished（项目快照刷新 + turn-completed 发布 +
// 清单清理）。已经跑完的孤儿（日志里有退出标记/会话已消亡）直接收尾,结果本就落在 CLI 会话库里。

const nodeFs = require('node:fs');
const { listRunManifests, updateRunManifest, removeRunManifest } = require('./native-run-manifest');
const { RUN_EXIT_MARKER, hasRunSession, killRunServer, cleanupRunSocket, sendRunKeys } = require('./native-run-tmux');
const { createTmuxRunChild } = require('./native-run-tmux-child');

function readExitCodeFromLog(logPath, fs) {
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const markerIndex = text.lastIndexOf(RUN_EXIT_MARKER);
    if (markerIndex < 0) return null;
    const code = Number(text.slice(markerIndex + RUN_EXIT_MARKER.length).split('\n')[0].trim());
    return Number.isFinite(code) ? code : null;
  } catch (_error) {
    return null;
  }
}

function adoptWebUiNativeRuns(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const registerNativeChatRun = options.registerNativeChatRun;
  const unregisterNativeChatRun = options.unregisterNativeChatRun;
  const onRunFinished = typeof options.onRunFinished === 'function' ? options.onRunFinished : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const parseNativeStreamEvent = options.parseNativeStreamEvent
    || require('./native-session-chat').parseNativeStreamEvent;
  if (!aiHomeDir || typeof registerNativeChatRun !== 'function' || typeof unregisterNativeChatRun !== 'function') {
    return { adopted: 0, finalized: 0 };
  }

  let adopted = 0;
  let finalized = 0;
  for (const manifest of listRunManifests(aiHomeDir, { fs })) {
    const alive = hasRunSession(manifest.socket, options);
    if (!alive) {
      // run 在 server 死亡期间已跑完（或被杀）：结果已在 CLI 自己的会话库里,直接收尾。
      const exitCode = readExitCodeFromLog(manifest.logPath, fs);
      Promise.resolve(onRunFinished(manifest, {
        exitCode: exitCode == null ? 1 : exitCode,
        adopted: false
      })).catch(() => {});
      removeRunManifest(aiHomeDir, manifest.runId, { fs, keepLog: exitCode !== 0 });
      cleanupRunSocket(manifest.socket, options);
      finalized += 1;
      continue;
    }

    // 还在跑：重新注册 + 续 tail 到完成。
    const handle = {
      runId: manifest.runId,
      provider: manifest.provider,
      ...(manifest.gateway ? { gateway: true } : { accountRef: manifest.accountRef }),
      sessionId: manifest.sessionId,
      projectDirName: manifest.projectDirName,
      projectPath: manifest.projectPath,
      startedAt: manifest.startedAt,
      interactionMode: manifest.interactionMode,
      adopted: true,
      getActivePrompt() { return null; },
      writeInput(input, writeOptions = {}) {
        const raw = String(input || '');
        if (!raw) return;
        sendRunKeys(manifest.socket, raw, { ...options, appendNewline: writeOptions.appendNewline !== false });
      },
      resize() { /* headless 无需尺寸 */ },
      abort() {
        killRunServer(manifest.socket, options);
      }
    };

    // 从头重放日志重建状态（拿 sessionId/失败信息）;重放不产生对外事件——没有挂着的 SSE 客户端,
    // 页面靠 /chat/runs + sessions/watch 恢复状态。
    const state = {
      content: '',
      stderr: '',
      stdout: '',
      sessionId: manifest.sessionId,
      failureMessage: '',
      seenToolUseIds: new Set()
    };
    const child = createTmuxRunChild({
      socket: manifest.socket,
      logPath: manifest.logPath,
      fs,
      spawnSyncImpl: options.spawnSyncImpl
    });
    child.onData((chunk) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = parseNativeStreamEvent(manifest.provider, trimmed, state);
          const events = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
          for (const event of events) {
            if (event && event.type === 'session-created' && event.sessionId && !handle.sessionId) {
              handle.sessionId = String(event.sessionId);
              updateRunManifest(aiHomeDir, manifest.runId, { sessionId: handle.sessionId }, { fs });
            }
          }
        } catch (_error) { /* 单行解析失败不致命 */ }
      }
    });
    child.onExit(({ exitCode }) => {
      unregisterNativeChatRun(manifest.runId);
      Promise.resolve(onRunFinished({ ...manifest, sessionId: handle.sessionId || manifest.sessionId }, {
        exitCode: Number(exitCode) || 0,
        adopted: true
      })).catch(() => {});
      removeRunManifest(aiHomeDir, manifest.runId, { fs, keepLog: Number(exitCode) !== 0 });
      cleanupRunSocket(manifest.socket, options);
    });

    registerNativeChatRun(handle);
    adopted += 1;
    log(`[aih] adopted webui native run ${manifest.runId} (${manifest.provider} session=${manifest.sessionId || 'pending'})`);
  }

  return { adopted, finalized };
}

module.exports = { adoptWebUiNativeRuns, readExitCodeFromLog };
