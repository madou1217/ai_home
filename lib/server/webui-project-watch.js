'use strict';

const sessionReader = require('../sessions/session-reader');

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function handleWebUiProjectsWatchRequest(ctx) {
  const {
    req,
    res
  } = ctx;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');

  const cursorByKey = new Map();
  const runningUntilByKey = new Map();
  let lastSentRunningKeys = new Set();
  const runtimeTtlMs = 15000;

  const emitRuntime = (runningKeys) => {
    lastSentRunningKeys = new Set(runningKeys);
    res.write(`data: ${JSON.stringify({
      type: 'runtime',
      runningSessionKeys: [...runningKeys]
    })}\n\n`);
  };

  const refreshRuntime = () => {
    const now = Date.now();
    const nextKnownKeys = new Set();

    let projects = [];
    try {
      projects = sessionReader.readAllProjectsFromHost();
    } catch (_error) {
      projects = [];
    }

    for (const project of Array.isArray(projects) ? projects : []) {
      const projectSessions = Array.isArray(project.sessions) ? project.sessions : [];
      for (const session of projectSessions) {
        if (!session || !session.id) continue;
        const key = `${project.provider}:${session.id}:${session.projectDirName || project.id || ''}`;
        nextKnownKeys.add(key);

        let nextCursor = 0;
        try {
          nextCursor = Number(sessionReader.getSessionFileCursor(project.provider, {
            sessionId: session.id,
            projectDirName: session.projectDirName || project.id || ''
          })) || 0;
        } catch (_error) {
          nextCursor = 0;
        }

        if (cursorByKey.has(key)) {
          const previousCursor = Number(cursorByKey.get(key)) || 0;
          if (nextCursor > previousCursor) {
            runningUntilByKey.set(key, now + runtimeTtlMs);
          }
        }
        cursorByKey.set(key, nextCursor);
      }
    }

    for (const key of [...cursorByKey.keys()]) {
      if (nextKnownKeys.has(key)) continue;
      cursorByKey.delete(key);
      runningUntilByKey.delete(key);
    }

    const nextRunningKeys = new Set();
    for (const [key, until] of runningUntilByKey.entries()) {
      if (Number(until) > now) {
        nextRunningKeys.add(key);
        continue;
      }
      runningUntilByKey.delete(key);
    }

    if (!setsEqual(lastSentRunningKeys, nextRunningKeys)) {
      emitRuntime(nextRunningKeys);
    }
  };

  refreshRuntime();
  const poller = setInterval(refreshRuntime, 1000);
  if (typeof poller.unref === 'function') poller.unref();

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_error) {
      clearInterval(heartbeat);
    }
  }, 30000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  req.on('close', () => {
    clearInterval(poller);
    clearInterval(heartbeat);
  });

  return true;
}

module.exports = {
  handleWebUiProjectsWatchRequest
};
