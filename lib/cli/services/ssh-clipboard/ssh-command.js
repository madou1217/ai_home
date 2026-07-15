'use strict';

const { spawn: spawnBase, spawnSync: spawnSyncBase } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeClipboardImageFrames, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_BYTES } = require('./frames');
const { readClipboardImage } = require('./clipboard');
const { isAltVClipboardTrigger } = require('./keys');

const DEFAULT_WATCH_INTERVAL_MS = 1200;

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function parseAihSshArgs(args = [], env = {}) {
  const tokens = Array.isArray(args) ? args.map((item) => String(item || '')) : [];
  const sshArgs = [];
  const remoteArgs = [];
  let afterSeparator = false;
  let watchClipboard = String(env.AIH_SSH_CLIP_WATCH || '').trim() === '1';
  let maxBytes = parsePositiveInt(env.AIH_SSH_CLIP_MAX_BYTES, DEFAULT_MAX_BYTES);
  let chunkSize = parsePositiveInt(env.AIH_SSH_CLIP_CHUNK_SIZE, DEFAULT_CHUNK_SIZE);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (afterSeparator) {
      remoteArgs.push(token);
      continue;
    }
    if (token === '--') {
      afterSeparator = true;
      continue;
    }
    if (token === '--watch-clipboard' || token === '--aih-watch-clipboard') {
      watchClipboard = true;
      continue;
    }
    if (token === '--no-watch-clipboard' || token === '--aih-no-watch-clipboard') {
      watchClipboard = false;
      continue;
    }
    if (token === '--clip-max-bytes' || token === '--aih-clip-max-bytes') {
      maxBytes = parsePositiveInt(tokens[index + 1], maxBytes);
      index += 1;
      continue;
    }
    if (token === '--clip-chunk-size' || token === '--aih-clip-chunk-size') {
      chunkSize = parsePositiveInt(tokens[index + 1], chunkSize);
      index += 1;
      continue;
    }
    sshArgs.push(token);
  }

  return {
    sshArgs,
    remoteArgs,
    watchClipboard,
    maxBytes,
    chunkSize
  };
}

function showAihSshHelp(write) {
  write(`
\x1b[36mAI Home SSH\x1b[0m - SSH wrapper with remote image paste bridge

\x1b[33mUsage:\x1b[0m
  aih ssh [ssh args...] -- aih <cli> [args...]
  aih ssh --watch-clipboard user@host -- aih claude

\x1b[33mImage Paste:\x1b[0m
  Press Alt+V in the wrapped SSH session. The client reads this machine's
  clipboard image, sends it through the SSH tty, caches it on the remote host,
  and injects the remote image file path into the active aih PTY.

\x1b[33mOptions:\x1b[0m
  --watch-clipboard       Cache changed clipboard images while the SSH session is open
  --no-watch-clipboard    Disable clipboard watch even when AIH_SSH_CLIP_WATCH=1
  --clip-max-bytes N      Max raw image bytes (default: ${DEFAULT_MAX_BYTES})
  --clip-chunk-size N     Base64 chars per tty frame (default: ${DEFAULT_CHUNK_SIZE})
`);
}

function writeStatus(stream, message) {
  if (!stream || typeof stream.write !== 'function') return;
  stream.write(`\r\n\x1b[33m[aih ssh]\x1b[0m ${message}\r\n`);
}

function restoreRawMode(stdin, previousRawMode) {
  if (!stdin || typeof stdin.setRawMode !== 'function' || typeof previousRawMode !== 'boolean') return;
  try { stdin.setRawMode(previousRawMode); } catch (_error) {}
}

function attachPipe(source, target) {
  if (!source || !target || typeof target.write !== 'function') return;
  if (typeof source.pipe === 'function') {
    source.pipe(target);
    return;
  }
  if (typeof source.on === 'function') {
    source.on('data', (chunk) => target.write(chunk));
  }
}

function writeFramesToStdin(stdin, image, options = {}) {
  if (!stdin || typeof stdin.write !== 'function') return null;
  const encoded = encodeClipboardImageFrames(image, {
    action: options.action || 'paste',
    maxBytes: options.maxBytes,
    chunkSize: options.chunkSize
  });
  encoded.frames.forEach((frame) => stdin.write(frame));
  return encoded;
}

function shellQuoteRemoteArg(value) {
  const text = String(value == null ? '' : value);
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function buildSshSpawnArgs(parsed) {
  if (!parsed || !Array.isArray(parsed.remoteArgs) || parsed.remoteArgs.length === 0) {
    return parsed && Array.isArray(parsed.sshArgs) ? parsed.sshArgs : [];
  }
  return [
    ...parsed.sshArgs,
    parsed.remoteArgs.map(shellQuoteRemoteArg).join(' ')
  ];
}

async function runAihSshCommand(rawArgs = [], deps = {}) {
  const processObj = deps.processObj || process;
  const consoleImpl = deps.consoleImpl || console;
  const spawn = deps.spawn || spawnBase;
  const spawnSync = deps.spawnSync || spawnSyncBase;
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const fsImpl = deps.fs || fs;
  const osImpl = deps.os || os;
  const pathImpl = deps.path || path;
  const stdin = processObj.stdin;
  const stdout = processObj.stdout;
  const stderr = processObj.stderr || processObj.stdout;
  const args = Array.isArray(rawArgs) ? rawArgs.slice(1) : [];

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    showAihSshHelp((line) => consoleImpl.log(line));
    return 0;
  }

  const parsed = parseAihSshArgs(args, processObj.env || {});
  if (!parsed.sshArgs.length) {
    consoleImpl.error('\x1b[31m[aih ssh]\x1b[0m missing ssh target or arguments.');
    showAihSshHelp((line) => consoleImpl.error(line));
    return 1;
  }

  const sshArgs = buildSshSpawnArgs(parsed);
  let child = null;
  try {
    child = spawn('ssh', sshArgs, {
      cwd: typeof processObj.cwd === 'function' ? processObj.cwd() : undefined,
      env: processObj.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    consoleImpl.error(`\x1b[31m[aih ssh]\x1b[0m failed to start ssh: ${String(error && error.message || error)}`);
    return 1;
  }

  attachPipe(child.stdout, stdout);
  attachPipe(child.stderr, stderr);

  const interactive = stdin && stdout && stdin.isTTY && stdout.isTTY;
  let previousRawMode = null;
  let watchTimer = null;
  let lastWatchedSha = '';
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (watchTimer) {
      clearIntervalImpl(watchTimer);
      watchTimer = null;
    }
    restoreRawMode(stdin, previousRawMode);
    if (stdin && typeof stdin.pause === 'function') {
      try { stdin.pause(); } catch (_error) {}
    }
  };

  const readLocalClipboardImage = () => readClipboardImage({
    fs: fsImpl,
    os: osImpl,
    path: pathImpl,
    spawnSync,
    platform: processObj.platform,
    maxBytes: parsed.maxBytes
  });

  const sendClipboardImage = (action, options = {}) => {
    const image = readLocalClipboardImage();
    if (!image) return null;
    if (options.skipSha && image.sha256 === options.skipSha) return image;
    const encoded = writeFramesToStdin(child.stdin, image, {
      action,
      maxBytes: parsed.maxBytes,
      chunkSize: parsed.chunkSize
    });
    return encoded ? { ...image, encoded } : image;
  };

  if (interactive) {
    previousRawMode = Boolean(stdin.isRaw);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    if (typeof stdin.resume === 'function') stdin.resume();
    stdin.on('data', (chunk) => {
      if (isAltVClipboardTrigger(chunk)) {
        try {
          const sent = sendClipboardImage('paste');
          if (sent && sent.encoded) {
            writeStatus(stderr, `sent clipboard image (${sent.byteLength} bytes)`);
            return;
          }
          if (child.stdin && typeof child.stdin.write === 'function') child.stdin.write(chunk);
        } catch (error) {
          writeStatus(stderr, `image paste failed: ${String((error && error.code) || (error && error.message) || error)}`);
        }
        return;
      }
      if (child.stdin && typeof child.stdin.write === 'function') child.stdin.write(chunk);
    });
  } else if (stdin && typeof stdin.pipe === 'function') {
    stdin.pipe(child.stdin);
  }

  if (parsed.watchClipboard && interactive) {
    watchTimer = setIntervalImpl(() => {
      try {
        const sent = sendClipboardImage('cache', { skipSha: lastWatchedSha });
        if (sent && sent.sha256) lastWatchedSha = sent.sha256;
      } catch (_error) {}
    }, DEFAULT_WATCH_INTERVAL_MS);
    if (typeof watchTimer.unref === 'function') watchTimer.unref();
  }

  if (stdin && typeof stdin.on === 'function') {
    stdin.on('end', () => {
      try { child.stdin.end(); } catch (_error) {}
    });
  }

  return new Promise((resolve) => {
    child.on('error', (error) => {
      cleanup();
      consoleImpl.error(`\x1b[31m[aih ssh]\x1b[0m failed to start ssh: ${String(error && error.message || error)}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) resolve(128);
      else resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

module.exports = {
  DEFAULT_WATCH_INTERVAL_MS,
  buildSshSpawnArgs,
  parseAihSshArgs,
  runAihSshCommand,
  writeFramesToStdin
};
