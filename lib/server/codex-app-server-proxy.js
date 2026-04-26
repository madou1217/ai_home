'use strict';

const WebSocket = require('ws');

function isCodexAppServerUpgradePath(pathname) {
  const normalized = String(pathname || '').trim() || '/';
  return normalized === '/' || normalized === '/v0/codex/app-server';
}

function rewriteCodexAppServerClientMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return text;
  }
  const method = String(parsed.method || '').trim();
  if (!method) {
    return text;
  }
  const next = { ...parsed };
  const params = (next.params && typeof next.params === 'object' && !Array.isArray(next.params))
    ? { ...next.params }
    : {};

  if (method === 'thread/list') {
    if (!Object.prototype.hasOwnProperty.call(params, 'modelProviders') || params.modelProviders === null) {
      params.modelProviders = [];
      next.params = params;
      return JSON.stringify(next);
    }
    return text;
  }

  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
    const config = (params.config && typeof params.config === 'object' && !Array.isArray(params.config))
      ? { ...params.config }
      : null;
    if (config && typeof config.profile === 'string' && config.profile.trim()) {
      delete config.profile;
      if (Object.keys(config).length > 0) {
        params.config = config;
      } else {
        delete params.config;
      }
      next.params = params;
      return JSON.stringify(next);
    }
  }

  return text;
}

function splitJsonRpcLines(buffer) {
  const input = String(buffer || '');
  const normalized = input.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  return {
    lines: parts.slice(0, -1).filter((line) => line.length > 0),
    rest: parts[parts.length - 1] || ''
  };
}

function createCodexAppServerProxy(deps = {}) {
  const {
    spawn,
    processObj,
    path,
    resolveCliPath,
    hostHomeDir,
    logDebug,
    logError
  } = deps;

  function buildSpawnEnv() {
    const env = {
      ...((processObj && processObj.env) || process.env)
    };
    const homeDir = String(hostHomeDir || '').trim();
    if (homeDir) {
      env.HOME = homeDir;
      env.USERPROFILE = homeDir;
      env.CODEX_HOME = path.join(homeDir, '.codex');
      env.CODEX_SQLITE_HOME = env.CODEX_HOME;
      env.XDG_CONFIG_HOME = homeDir;
      env.XDG_DATA_HOME = path.join(homeDir, '.local', 'share');
      env.XDG_STATE_HOME = path.join(homeDir, '.local', 'state');
    }
    env.AIH_CODEX_REMOTE_PROXY = '1';
    return env;
  }

  async function handleUpgrade(req, socket, head, options = {}) {
    const wss = new WebSocket.Server({ noServer: true });
    const codexBin = typeof resolveCliPath === 'function' ? resolveCliPath('codex') : '';
    if (!codexBin) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      env: buildSpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const client = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      wss.handleUpgrade(req, socket, head, (ws) => done(resolve, ws));
      child.once('error', (error) => done(reject, error));
      child.once('exit', (code, signal) => {
        done(reject, new Error(`codex_app_server_exit:${code || 0}:${signal || 'none'}`));
      });
    });

    let stdoutBuffer = '';
    let closed = false;
    const closeAll = () => {
      if (closed) return;
      closed = true;
      try { client.close(); } catch (_error) {}
      try { child.kill(); } catch (_error) {}
    };

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (typeof logDebug === 'function' && chunk) {
          logDebug(String(chunk).trim());
        }
      });
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        const { lines, rest } = splitJsonRpcLines(stdoutBuffer);
        stdoutBuffer = rest;
        lines.forEach((line) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(line);
          }
        });
      });
    }

    if (child.stdin) {
      client.on('message', (data) => {
        const payload = rewriteCodexAppServerClientMessage(data);
        child.stdin.write(`${payload}\n`);
      });
    }

    client.on('close', closeAll);
    client.on('error', (error) => {
      if (typeof logError === 'function') {
        logError(error);
      }
      closeAll();
    });
    child.once('exit', () => closeAll());
    child.once('error', (error) => {
      if (typeof logError === 'function') {
        logError(error);
      }
      closeAll();
    });

    if (typeof logDebug === 'function' && options.requestId) {
      logDebug(`codex app-server proxy ready (${options.requestId})`);
    }
  }

  return {
    rewriteCodexAppServerClientMessage,
    handleUpgrade
  };
}

module.exports = {
  isCodexAppServerUpgradePath,
  rewriteCodexAppServerClientMessage,
  createCodexAppServerProxy
};
