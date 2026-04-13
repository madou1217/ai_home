'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const nodePty = require('node-pty');

const { resolveCliPath } = require('../runtime/platform-runtime');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../runtime/pty-launch');
const {
  readSessionMessages,
  resolveSessionFilePath
} = require('../sessions/session-reader');

const DEFAULT_LOCAL_CLAUDE_PACKAGE_PATH = path.join(os.homedir(), 'Downloads', 'package', 'cli.js');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripAnsi(text) {
  return String(text || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function sanitizeTerminalText(text) {
  return stripAnsi(String(text || ''))
    .replace(/\u0000/g, '')
    .replace(/[^\S\r\n\t]+$/gm, '');
}

function getSessionFileMtime(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return 0;
  try {
    return Number(fs.statSync(sessionPath).mtimeMs) || 0;
  } catch (_error) {
    return 0;
  }
}

function normalizeProxyEnv(envObj) {
  const env = { ...(envObj || {}) };
  const pairs = [
    ['http_proxy', 'HTTP_PROXY'],
    ['https_proxy', 'HTTPS_PROXY'],
    ['all_proxy', 'ALL_PROXY'],
    ['no_proxy', 'NO_PROXY']
  ];
  pairs.forEach(([lower, upper]) => {
    const lowerValue = normalizeString(env[lower]);
    const upperValue = normalizeString(env[upper]);
    if (lowerValue && !upperValue) env[upper] = lowerValue;
    if (upperValue && !lowerValue) env[lower] = upperValue;
  });
  return env;
}

function buildProviderEnv(provider, profileDir, baseEnv) {
  return normalizeProxyEnv({
    ...(baseEnv || process.env),
    HOME: profileDir,
    USERPROFILE: profileDir,
    CLAUDE_CONFIG_DIR: path.join(profileDir, '.claude'),
    CODEX_HOME: path.join(profileDir, '.codex'),
    XDG_CONFIG_HOME: profileDir,
    XDG_DATA_HOME: path.join(profileDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(profileDir, '.local', 'state'),
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(profileDir, '.gemini', 'settings.json')
  });
}

function buildResumeCommand(provider, options = {}) {
  const sessionId = normalizeString(options.sessionId);
  const prompt = String(options.prompt || '');
  const model = normalizeString(options.model);
  const outputLastMessagePath = normalizeString(options.outputLastMessagePath);
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const stream = !!options.stream;
  const interactiveCli = !!options.interactiveCli;

  if (!sessionId) {
    const error = new Error('missing_session_id');
    error.code = 'missing_session_id';
    throw error;
  }
  if (!interactiveCli && !prompt.trim()) {
    const error = new Error('empty_prompt');
    error.code = 'empty_prompt';
    throw error;
  }

  if (provider === 'gemini') {
    if (interactiveCli) {
      const args = ['--resume', sessionId];
      if (model) args.push('--model', model);
      return { commandName: 'gemini', args };
    }
    const args = ['--resume', sessionId, '--prompt', prompt, '--output-format', stream ? 'stream-json' : 'json'];
    if (model) args.push('--model', model);
    return { commandName: 'gemini', args };
  }

  if (provider === 'codex') {
    if (interactiveCli) {
      const args = ['resume'];
      if (model) args.push('-m', model);
      imagePaths.forEach((imagePath) => {
        args.push('-i', imagePath);
      });
      args.push(sessionId);
      return { commandName: 'codex', args };
    }
    const args = ['exec', 'resume'];
    if (model) args.push('-m', model);
    imagePaths.forEach((imagePath) => {
      args.push('-i', imagePath);
    });
    args.push(sessionId, prompt);
    if (outputLastMessagePath) {
      args.push('--output-last-message', outputLastMessagePath);
    }
    args.push('--json');
    return { commandName: 'codex', args };
  }

  if (provider === 'claude') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('--model', model);
      args.push('--resume', sessionId);
      return { commandName: 'claude', args };
    }
    const args = ['-p', '--output-format', stream ? 'stream-json' : 'json'];
    if (stream) args.push('--verbose', '--include-partial-messages');
    if (model) args.push('--model', model);
    args.push('--resume', sessionId, prompt);
    return { commandName: 'claude', args };
  }

  const error = new Error('native_session_resume_unsupported');
  error.code = 'native_session_resume_unsupported';
  throw error;
}

function buildStartCommand(provider, options = {}) {
  const prompt = String(options.prompt || '');
  const model = normalizeString(options.model);
  const outputLastMessagePath = normalizeString(options.outputLastMessagePath);
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const stream = !!options.stream;
  const interactiveCli = !!options.interactiveCli;

  if (!interactiveCli && !prompt.trim()) {
    const error = new Error('empty_prompt');
    error.code = 'empty_prompt';
    throw error;
  }

  if (provider === 'gemini') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('--model', model);
      return { commandName: 'gemini', args };
    }
    const args = ['--prompt', prompt, '--output-format', stream ? 'stream-json' : 'json'];
    if (model) args.push('--model', model);
    return { commandName: 'gemini', args };
  }

  if (provider === 'codex') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('-m', model);
      imagePaths.forEach((imagePath) => {
        args.push('-i', imagePath);
      });
      return { commandName: 'codex', args };
    }
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (model) args.push('-m', model);
    imagePaths.forEach((imagePath) => {
      args.push('-i', imagePath);
    });
    if (outputLastMessagePath) args.push('--output-last-message', outputLastMessagePath);
    args.push(prompt);
    return { commandName: 'codex', args };
  }

  if (provider === 'claude') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('--model', model);
      return { commandName: 'claude', args };
    }
    const args = ['-p', '--output-format', stream ? 'stream-json' : 'json'];
    if (stream) args.push('--verbose', '--include-partial-messages');
    if (model) args.push('--model', model);
    args.push(prompt);
    return { commandName: 'claude', args };
  }

  const error = new Error('native_session_start_unsupported');
  error.code = 'native_session_start_unsupported';
  throw error;
}

function resolveNativeCliLaunch(provider, options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  if (normalizedProvider === 'claude') {
    const configuredScript = normalizeString(
      options.claudeCliJsPath
      || process.env.AIH_CLAUDE_CLI_JS_PATH
    );
    const scriptPath = configuredScript || (fs.existsSync(DEFAULT_LOCAL_CLAUDE_PACKAGE_PATH) ? DEFAULT_LOCAL_CLAUDE_PACKAGE_PATH : '');
    if (scriptPath && fs.existsSync(scriptPath)) {
      return {
        command: process.execPath,
        prefixArgs: [scriptPath]
      };
    }
  }

  const cliPath = resolveCliPath(normalizedProvider);
  if (!cliPath) {
    const error = new Error(`未找到 ${normalizedProvider} CLI`);
    error.code = 'cli_not_found';
    throw error;
  }

  return {
    command: cliPath,
    prefixArgs: []
  };
}

function spawnAndCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        error
      });
    });
    child.on('close', (code) => {
      resolve({
        ok: Number(code) === 0,
        exitCode: Number.isInteger(code) ? code : null,
        stdout,
        stderr,
        error: null
      });
    });
  });
}

function computeDelta(previous, incoming, preferDirect = false) {
  const before = String(previous || '');
  const next = String(incoming || '');
  if (!next) return '';
  if (preferDirect) return next;
  if (!before) return next;
  if (next.startsWith(before)) return next.slice(before.length);
  return next;
}

function extractClaudeAssistantText(item) {
  const message = item && item.message && typeof item.message === 'object' ? item.message : null;
  const content = Array.isArray(message && message.content) ? message.content : [];
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function parseNativeStreamEvent(provider, line, state) {
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch (_error) {
    return null;
  }

  if (provider === 'gemini') {
    if (parsed && parsed.type === 'init' && parsed.session_id && !state.sessionId) {
      state.sessionId = String(parsed.session_id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'message' && parsed.role === 'assistant') {
      const text = String(parsed.content || '');
      const delta = computeDelta(state.content, text, parsed.delta === true);
      state.content += delta;
      return delta ? { type: 'delta', delta } : null;
    }
    if (parsed && parsed.type === 'result') {
      const resultText = normalizeString(parsed.result || '');
      if (resultText && !state.content) state.content = resultText;
      if (parsed.status === 'error') {
        return { type: 'error', message: resultText || 'gemini_stream_failed' };
      }
      return { type: 'result', content: state.content || resultText };
    }
    return null;
  }

  if (provider === 'claude') {
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id && !state.sessionId) {
      state.sessionId = String(parsed.session_id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'assistant') {
      const text = extractClaudeAssistantText(parsed);
      const delta = computeDelta(state.content, text, false);
      state.content += delta;
      return delta ? { type: 'delta', delta } : null;
    }
    if (parsed && parsed.type === 'result') {
      const resultText = normalizeString(parsed.result || '');
      if (resultText && !state.content) state.content = resultText;
      if (parsed.is_error) {
        return { type: 'error', message: resultText || 'claude_stream_failed' };
      }
      return { type: 'result', content: state.content || resultText };
    }
    return null;
  }

  if (provider === 'codex') {
    if (parsed && parsed.type === 'session_meta' && parsed.payload && parsed.payload.id && !state.sessionId) {
      state.sessionId = String(parsed.payload.id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'thread.started' && parsed.thread_id && !state.sessionId) {
      state.sessionId = String(parsed.thread_id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message') {
      const text = String(parsed.item.text || '');
      const delta = computeDelta(state.content, text, false);
      state.content += delta;
      return delta ? { type: 'delta', delta } : null;
    }
    return null;
  }

  return null;
}

function spawnNativeSessionStream(options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const accountId = normalizeString(options.accountId);
  const prompt = String(options.prompt || '');
  const initialInput = String(options.initialInput || '');
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const projectPath = normalizeString(options.projectPath) || process.cwd();
  const sessionParams = {
    sessionId: normalizeString(options.sessionId),
    projectDirName: normalizeString(options.projectDirName)
  };
  const isResume = Boolean(sessionParams.sessionId);
  const interactiveCli = !!options.interactiveCli;
  const getProfileDir = options.getProfileDir;

  if (!provider || !accountId || typeof getProfileDir !== 'function') {
    const error = new Error('native_session_invalid_context');
    error.code = 'native_session_invalid_context';
    throw error;
  }

  if (typeof options.ensureSessionStoreLinks === 'function') {
    try {
      options.ensureSessionStoreLinks(provider, accountId);
    } catch (_error) {}
  }

  const profileDir = getProfileDir(provider, accountId);
  const sessionPath = isResume ? resolveSessionFilePath(provider, sessionParams) : '';
  const beforeMessages = isResume ? readSessionMessages(provider, sessionParams) : [];
  const beforeMtime = isResume ? getSessionFileMtime(sessionPath) : 0;
  const tempOutputPath = provider === 'codex'
    ? path.join(
      os.tmpdir(),
      `aih-native-session-stream-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    )
    : '';
  const launch = resolveNativeCliLaunch(provider, {
    claudeCliJsPath: options.claudeCliJsPath
  });
  const command = isResume ? buildResumeCommand : buildStartCommand;
  const { args } = command(provider, {
    sessionId: sessionParams.sessionId,
    prompt,
    imagePaths,
    model: options.model,
    outputLastMessagePath: tempOutputPath,
    stream: provider === 'gemini' || provider === 'claude',
    interactiveCli
  });
  const env = buildProviderEnv(provider, profileDir, options.env);
  const batchLaunch = resolveWindowsBatchLaunch(
    provider,
    launch.command,
    env,
    process.platform
  );
  const finalLaunch = buildPtyLaunch(
    batchLaunch.launchBin || launch.command,
    [...launch.prefixArgs, ...args],
    { platform: process.platform }
  );
  const child = nodePty.spawn(finalLaunch.command, finalLaunch.args, {
    name: 'xterm-color',
    cols: 120,
    rows: 32,
    cwd: projectPath,
    env: {
      ...env,
      ...(batchLaunch.envPatch || {})
    }
  });

  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `native-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = { content: '', stderr: '', stdout: '', sessionId: sessionParams.sessionId };
  let lineBuffer = '';
  let pendingTerminal = '';
  let flushTimer = null;
  let settled = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const cleanupTempOutput = () => {
    if (!tempOutputPath || !fs.existsSync(tempOutputPath)) return;
    try {
      fs.rmSync(tempOutputPath, { force: true });
    } catch (_error) {}
  };

  const fail = (error) => {
    if (settled) return;
    settled = true;
    if (flushTimer) clearTimeout(flushTimer);
    cleanupTempOutput();
    rejectDone(error);
  };
  const finish = async (exitCode) => {
    if (settled) return;
    settled = true;
    if (flushTimer) clearTimeout(flushTimer);
    if (Number(exitCode) !== 0) {
      cleanupTempOutput();
      const error = new Error(normalizeString(state.stderr) || normalizeString(state.stdout) || `native_session_failed_exit_${exitCode}`);
      error.code = 'native_session_failed';
      error.exitCode = exitCode;
      rejectDone(error);
      return;
    }

    const afterMessages = isResume
      ? await waitForSessionUpdate(
        provider,
        sessionParams,
        beforeMessages.length,
        sessionPath,
        beforeMtime
      )
      : [];
    const fileContent = tempOutputPath && fs.existsSync(tempOutputPath)
      ? normalizeString(fs.readFileSync(tempOutputPath, 'utf8'))
      : '';
    const finalContent = state.content || collectAssistantReply(beforeMessages, afterMessages) || fileContent;
    cleanupTempOutput();
    resolveDone({
      content: finalContent,
      afterMessages,
      sessionId: state.sessionId || ''
    });
  };

  const emitEvent = (event) => {
    if (!event || typeof options.onEvent !== 'function') return;
    options.onEvent({
      ...event,
      runId
    });
  };

  const flushTerminal = () => {
    flushTimer = null;
    const text = pendingTerminal;
    pendingTerminal = '';
    if (!text.trim()) return;
    emitEvent({
      type: 'terminal-output',
      text
    });
  };

  const scheduleTerminalFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushTerminal, 120);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  const pushTerminalText = (text) => {
    const normalized = sanitizeTerminalText(text);
    if (!normalized) return;
    pendingTerminal += normalized;
    scheduleTerminalFlush();
  };

  child.onData((chunk) => {
    const text = String(chunk || '');
    state.stdout += text;
    if (interactiveCli) {
      if (options.emitTerminalOutput !== false) {
        emitEvent({
          type: 'terminal-output',
          text
        });
      }
      return;
    }
    lineBuffer += sanitizeTerminalText(text);

    while (true) {
      const newlineIndex = lineBuffer.indexOf('\n');
      if (newlineIndex < 0) break;
      const rawLine = lineBuffer.slice(0, newlineIndex).replace(/\r/g, '');
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) {
        pushTerminalText('\n');
        continue;
      }
      const event = parseNativeStreamEvent(provider, trimmedLine, state);
      if (event) {
        emitEvent(event);
        continue;
      }
      pushTerminalText(`${rawLine}\n`);
    }

    const trailing = lineBuffer.trim();
    if (trailing && !trailing.startsWith('{"')) {
      pushTerminalText(lineBuffer);
      lineBuffer = '';
    }
  });
  child.onExit(({ exitCode }) => {
    if (lineBuffer.trim()) {
      pushTerminalText(lineBuffer);
      lineBuffer = '';
    }
    if (pendingTerminal) {
      flushTerminal();
    }
    finish(exitCode).catch(fail);
  });

  if (interactiveCli && initialInput) {
    try {
      let payload = initialInput.replace(/\r?\n/g, '\r');
      if (!payload.endsWith('\r')) payload += '\r';
      child.write(payload);
    } catch (_error) {}
  }

  return {
    runId,
    child,
    done,
    writeInput(input, writeOptions = {}) {
      if (settled) {
        const error = new Error('native_session_run_not_active');
        error.code = 'native_session_run_not_active';
        throw error;
      }
      const rawInput = String(input || '');
      if (!rawInput) {
        const error = new Error('native_session_input_empty');
        error.code = 'native_session_input_empty';
        throw error;
      }
      const appendNewline = writeOptions.appendNewline !== false;
      let payload = rawInput.replace(/\r?\n/g, '\r');
      if (appendNewline && !payload.endsWith('\r')) payload += '\r';
      child.write(payload);
    },
    resize(cols, rows) {
      if (settled) {
        const error = new Error('native_session_run_not_active');
        error.code = 'native_session_run_not_active';
        throw error;
      }
      const nextCols = Math.max(20, Math.min(400, Number(cols) || 80));
      const nextRows = Math.max(4, Math.min(200, Number(rows) || 24));
      if (typeof child.resize === 'function') {
        child.resize(nextCols, nextRows);
      }
    },
    abort() {
      if (flushTimer) clearTimeout(flushTimer);
      if (child && typeof child.kill === 'function') {
        try {
          child.kill();
        } catch (_error) {}
      }
      cleanupTempOutput();
    }
  };
}

async function waitForSessionUpdate(provider, params, beforeCount, sessionPath, beforeMtime = 0, timeoutMs = 10000) {
  const startedAt = Date.now();
  const initialMtime = Number(beforeMtime) || 0;

  while (Date.now() - startedAt < timeoutMs) {
    const currentMessages = readSessionMessages(provider, params);
    const currentMtime = sessionPath && fs.existsSync(sessionPath)
      ? Number(fs.statSync(sessionPath).mtimeMs) || 0
      : 0;
    if (currentMessages.length > beforeCount || currentMtime > initialMtime) {
      return currentMessages;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return readSessionMessages(provider, params);
}

function collectAssistantReply(beforeMessages, afterMessages) {
  const offset = Array.isArray(beforeMessages) ? beforeMessages.length : 0;
  const nextMessages = Array.isArray(afterMessages) ? afterMessages.slice(offset) : [];
  return nextMessages
    .filter((message) => message && message.role === 'assistant')
    .map((message) => String(message.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function runNativeSessionPrompt(options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const accountId = normalizeString(options.accountId);
  const prompt = String(options.prompt || '');
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const projectPath = normalizeString(options.projectPath) || process.cwd();
  const sessionParams = {
    sessionId: normalizeString(options.sessionId),
    projectDirName: normalizeString(options.projectDirName)
  };
  const getProfileDir = options.getProfileDir;

  if (!provider || !accountId || typeof getProfileDir !== 'function') {
    const error = new Error('native_session_invalid_context');
    error.code = 'native_session_invalid_context';
    throw error;
  }

  if (typeof options.ensureSessionStoreLinks === 'function') {
    try {
      options.ensureSessionStoreLinks(provider, accountId);
    } catch (_error) {
      // best effort; follow-up read will validate whether native session actually moved
    }
  }

  const profileDir = getProfileDir(provider, accountId);
  const sessionPath = resolveSessionFilePath(provider, sessionParams);
  const beforeMessages = readSessionMessages(provider, sessionParams);
  const beforeMtime = getSessionFileMtime(sessionPath);
  const tempOutputPath = path.join(
    os.tmpdir(),
    `aih-native-session-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  const { commandName, args } = buildResumeCommand(provider, {
    sessionId: sessionParams.sessionId,
    prompt,
    imagePaths,
    model: options.model,
    outputLastMessagePath: provider === 'codex' ? tempOutputPath : ''
  });
  const launch = resolveNativeCliLaunch(provider, {
    claudeCliJsPath: options.claudeCliJsPath
  });
  const env = buildProviderEnv(provider, profileDir, options.env);
  const runResult = await spawnAndCapture(launch.command, [...launch.prefixArgs, ...args], {
    cwd: projectPath,
    env
  });

  if (!runResult.ok) {
    const message = normalizeString(runResult.stderr) || normalizeString(runResult.stdout) || `native_session_failed_exit_${runResult.exitCode}`;
    const error = new Error(message);
    error.code = 'native_session_failed';
    error.exitCode = runResult.exitCode;
    throw error;
  }

  const afterMessages = await waitForSessionUpdate(
    provider,
    sessionParams,
    beforeMessages.length,
    sessionPath,
    beforeMtime
  );
  let content = collectAssistantReply(beforeMessages, afterMessages);

  if (!content && provider === 'codex' && fs.existsSync(tempOutputPath)) {
    content = normalizeString(fs.readFileSync(tempOutputPath, 'utf8'));
  }
  if (!content && provider === 'claude') {
    try {
      const parsed = JSON.parse(String(runResult.stdout || '[]'));
      const items = Array.isArray(parsed) ? parsed : [];
      const resultItem = items.find((item) => item && item.type === 'result');
      if (resultItem && typeof resultItem.result === 'string') {
        content = normalizeString(resultItem.result);
      }
    } catch (_error) {
      // ignore parse fallback
    }
  }
  if (tempOutputPath && fs.existsSync(tempOutputPath)) {
    try { fs.rmSync(tempOutputPath, { force: true }); } catch (_error) {}
  }

  return {
    ok: true,
    provider,
    accountId,
    sessionId: sessionParams.sessionId,
    content,
    beforeCount: beforeMessages.length,
    afterCount: Array.isArray(afterMessages) ? afterMessages.length : beforeMessages.length
  };
}

module.exports = {
  buildStartCommand,
  buildResumeCommand,
  collectAssistantReply,
  parseNativeStreamEvent,
  runNativeSessionPrompt,
  spawnNativeSessionStream
};
