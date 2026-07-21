'use strict';

const fsBase = require('node:fs');
const osBase = require('node:os');
const pathBase = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync: spawnSyncBase } = require('node:child_process');
const {
  DEFAULT_SHIM_TIMEOUT_MS,
  buildShimRequestFrame,
  isSafeShimResponsePath,
  normalizeShimMimeType
} = require('./shim-protocol');

function parsePositiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function parseXclipArgs(args = []) {
  let output = false;
  let mimeType = 'text/plain';
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (token === '-o' || token === '-out') {
      output = true;
    } else if (token === '-t' || token === '-target') {
      mimeType = String(args[index + 1] || '').trim() || mimeType;
      index += 1;
    }
  }
  return {
    output,
    mimeType: normalizeShimMimeType(mimeType)
  };
}

function parseWlPasteArgs(args = []) {
  let output = true;
  let mimeType = 'text/plain';
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (token === '--list-types' || token === '-l') {
      mimeType = 'TARGETS';
    } else if (token === '--type' || token === '-t') {
      mimeType = String(args[index + 1] || '').trim() || mimeType;
      index += 1;
    } else if (token.startsWith('--type=')) {
      mimeType = token.slice('--type='.length).trim() || mimeType;
    } else if (token === '--watch' || token === '-w') {
      output = false;
    }
  }
  return {
    output,
    mimeType: normalizeShimMimeType(mimeType)
  };
}

function parsePbpasteArgs(args = []) {
  let mimeType = 'text/plain';
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (token === '-Prefer' || token === '--prefer') {
      mimeType = String(args[index + 1] || '').trim() || mimeType;
      index += 1;
    }
  }
  return {
    output: true,
    mimeType: normalizeShimMimeType(mimeType) || 'text/plain'
  };
}

function parsePngpasteArgs(args = []) {
  const fileArg = args
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .find((value) => value !== '-' && !value.startsWith('-'));
  return {
    output: true,
    mimeType: 'image/png',
    outputPath: fileArg || ''
  };
}

function collectOsascriptSource(args = []) {
  const parts = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (token === '-e') {
      parts.push(String(args[index + 1] || ''));
      index += 1;
    }
  }
  return parts.join('\n');
}

function parseAppleScriptOutputPath(source) {
  const text = String(source || '');
  const match = text.match(/POSIX file\s+["']([^"']+)["']/i);
  return match ? match[1] : '';
}

function parseAppleScriptClipboardMimeType(source) {
  const text = String(source || '');
  if (!/the clipboard/i.test(text)) return '';
  if (/PNGf|public\.png|image\/png/i.test(text)) return 'image/png';
  if (/JPEG|JPG|public\.jpe?g|image\/jpe?g/i.test(text)) return 'image/jpeg';
  if (/GIFf|public\.gif|image\/gif/i.test(text)) return 'image/gif';
  if (/BMPf|public\.bmp|image\/bmp/i.test(text)) return 'image/bmp';
  if (/TIFF|public\.tiff?|image\/tiff?/i.test(text)) return 'image/tiff';
  if (/\btext\b|utf8|plain|NSStringPboardType|public\.utf8-plain-text/i.test(text)) return 'text/plain';
  return '';
}

function parseOsascriptArgs(args = []) {
  const source = collectOsascriptSource(args);
  const mimeType = normalizeShimMimeType(parseAppleScriptClipboardMimeType(source));
  if (!mimeType) {
    return { output: false, mimeType: '', delegate: true };
  }
  const outputPath = parseAppleScriptOutputPath(source);
  return {
    output: true,
    mimeType,
    outputPath,
    discardOutput: mimeType.startsWith('image/') && !outputPath && !/\bwrite\b/i.test(source)
  };
}

function parseShimInvocation(argv = []) {
  const tool = String(argv[0] || '').trim();
  const args = argv.slice(1);
  if (tool === 'xclip') return { tool, args, ...parseXclipArgs(args) };
  if (tool === 'wl-paste') return { tool, args, ...parseWlPasteArgs(args) };
  if (tool === 'pbpaste') return { tool, args, ...parsePbpasteArgs(args) };
  if (tool === 'pngpaste') return { tool, args, ...parsePngpasteArgs(args) };
  if (tool === 'osascript') return { tool, args, ...parseOsascriptArgs(args) };
  return { tool, args, output: false, mimeType: '', delegate: true };
}

function writeStderr(stderr, message) {
  if (!stderr || typeof stderr.write !== 'function') return;
  stderr.write(`${message}\n`);
}

function writeStdout(stdout, value, encoding) {
  if (!stdout || typeof stdout.write !== 'function') return;
  stdout.write(value, encoding);
}

function writeOutputFile(fsImpl, filePath, value) {
  if (!filePath) return false;
  fsImpl.writeFileSync(filePath, value);
  return true;
}

function buildResponsePath(rootDir, id, pathImpl = pathBase) {
  return pathImpl.join(rootDir, 'responses', `${id}.json`);
}

function readResponseFile(fsImpl, filePath) {
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResponse(options = {}) {
  const fsImpl = options.fs || fsBase;
  const filePath = options.filePath;
  const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_SHIM_TIMEOUT_MS);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = readResponseFile(fsImpl, filePath);
    if (response) return response;
    await sleep(30);
  }
  return { ok: false, error: 'ssh_clip_shim_timeout' };
}

function writeRequestToTty(frame, options = {}) {
  const fsImpl = options.fs || fsBase;
  const ttyPath = String(options.ttyPath || '/dev/tty');
  fsImpl.writeFileSync(ttyPath, frame);
}

function realToolEnvKey(tool) {
  const key = String(tool || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key ? `AIH_SSH_CLIP_REAL_${key}` : '';
}

function parsePathEntries(env = {}, platform = process.platform) {
  const raw = String(env[platform === 'win32' ? 'Path' : 'PATH'] || env.PATH || env.Path || '');
  const separator = platform === 'win32' ? ';' : pathBase.delimiter;
  return raw.split(separator).map((item) => item.trim()).filter(Boolean);
}

function resolveRealToolPath(tool, options = {}) {
  const env = options.env || {};
  const fsImpl = options.fs || fsBase;
  const pathImpl = options.path || pathBase;
  const envKey = realToolEnvKey(tool);
  const explicit = envKey ? String(env[envKey] || '').trim() : '';
  if (explicit) return explicit;
  const shimBinDir = String(env.AIH_SSH_CLIP_SHIM_BIN_DIR || '').trim();
  const resolvedShimBinDir = shimBinDir ? pathImpl.resolve(shimBinDir) : '';
  for (const entry of parsePathEntries(env, options.platform || process.platform)) {
    if (resolvedShimBinDir && pathImpl.resolve(entry) === resolvedShimBinDir) continue;
    const candidate = pathImpl.join(entry, tool);
    try {
      const stat = fsImpl.statSync(candidate);
      if (stat && stat.isFile && stat.isFile()) return candidate;
    } catch (_error) {}
  }
  return '';
}

function runRealTool(invocation, deps = {}) {
  const processObj = deps.processObj || process;
  const spawnSync = deps.spawnSync || spawnSyncBase;
  const command = resolveRealToolPath(invocation.tool, {
    env: processObj.env || {},
    fs: deps.fs || fsBase,
    path: deps.path || pathBase,
    platform: processObj.platform
  });
  if (!command) return null;
  const result = spawnSync(command, invocation.args || [], {
    stdio: 'inherit',
    env: processObj.env
  });
  if (result && typeof result.status === 'number') return result.status;
  return 1;
}

async function runSshClipboardShimCli(rawArgv = [], deps = {}) {
  const processObj = deps.processObj || process;
  const fsImpl = deps.fs || fsBase;
  const pathImpl = deps.path || pathBase;
  const env = processObj.env || {};
  const stdout = processObj.stdout;
  const stderr = processObj.stderr;
  const invocation = parseShimInvocation(rawArgv);
  if (!invocation.output || !invocation.mimeType) {
    const delegated = invocation.delegate ? runRealTool(invocation, deps) : null;
    if (delegated != null) return delegated;
    writeStderr(stderr, '[aih ssh-clipboard] shim only supports clipboard read operations.');
    return 1;
  }

  const rootDir = String(env.AIH_SSH_CLIP_SHIM_DIR || '').trim();
  if (!rootDir) {
    const delegated = runRealTool(invocation, deps);
    if (delegated != null) return delegated;
    writeStderr(stderr, '[aih ssh-clipboard] shim is not attached to an active aih SSH session.');
    return 1;
  }
  const id = randomUUID().replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 32);
  const responsePath = buildResponsePath(rootDir, id, pathImpl);
  if (!isSafeShimResponsePath(rootDir, responsePath, pathImpl)) {
    writeStderr(stderr, '[aih ssh-clipboard] unsafe shim response path.');
    return 1;
  }
  fsImpl.mkdirSync(pathImpl.dirname(responsePath), { recursive: true });

  const frame = buildShimRequestFrame({
    id,
    kind: invocation.mimeType === 'TARGETS' ? 'list' : 'read',
    mimeType: invocation.mimeType,
    responsePath
  });
  if (!frame) {
    writeStderr(stderr, '[aih ssh-clipboard] failed to build shim request.');
    return 1;
  }

  try {
    writeRequestToTty(frame, {
      fs: fsImpl,
      ttyPath: env.AIH_SSH_CLIP_SHIM_TTY || '/dev/tty'
    });
  } catch (error) {
    writeStderr(stderr, `[aih ssh-clipboard] failed to reach parent runtime: ${String(error && error.message || error)}`);
    return 1;
  }

  const response = await waitForResponse({
    fs: fsImpl,
    filePath: responsePath,
    timeoutMs: env.AIH_SSH_CLIP_SHIM_TIMEOUT_MS
  });
  try { fsImpl.unlinkSync(responsePath); } catch (_error) {}

  if (!response || !response.ok) {
    writeStderr(stderr, `[aih ssh-clipboard] ${String(response && response.error || 'ssh_clip_shim_failed')}`);
    return 1;
  }
  if (Array.isArray(response.mimeTypes)) {
    writeStdout(stdout, `${response.mimeTypes.join(osBase.EOL)}${osBase.EOL}`, 'utf8');
    return 0;
  }
  if (response.data) {
    const data = Buffer.from(String(response.data), 'base64');
    if (invocation.discardOutput) {
      return 0;
    } else if (invocation.outputPath) {
      writeOutputFile(fsImpl, invocation.outputPath, data);
    } else {
      writeStdout(stdout, data);
    }
    return 0;
  }
  writeStderr(stderr, '[aih ssh-clipboard] empty shim response.');
  return 1;
}

module.exports = {
  parseShimInvocation,
  resolveRealToolPath,
  runSshClipboardShimCli
};
