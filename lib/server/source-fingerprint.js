'use strict';

const crypto = require('node:crypto');

const SOURCE_FINGERPRINT_FILE = 'server.source-fingerprint.json';
const SOURCE_FINGERPRINT_DIRECTORIES = Object.freeze([
  'lib/server/chat-runtime'
]);
const SOURCE_FINGERPRINT_FILES = Object.freeze([
  'package.json',
  'bin/ai-home.js',
  'lib/cli/app.js',
  'lib/cli/commands/ai-cli/router.js',
  'lib/cli/services/ai-cli/codex-provider-args.js',
  'lib/cli/services/fabric/broker-connect.js',
  'lib/cli/services/fabric/broker-request-handler.js',
  'lib/cli/services/fabric/broker-websocket-handler.js',
  'lib/cli/services/pty/runtime.js',
  'lib/cli/services/server/autostart.js',
  'lib/cli/services/server/daemon.js',
  'lib/server/account-capabilities.js',
  'lib/server/accounts.js',
  'lib/server/capability-router.js',
  'lib/server/fabric-descriptor.js',
  'lib/server/fabric-gateway-capacity.js',
  'lib/server/fabric-gateway-capability.js',
  'lib/server/fabric-gateway-fallback.js',
  'lib/server/fabric-gateway-protocol.js',
  'lib/server/fabric-gateway-route.js',
  'lib/server/fabric-gateway-websocket.js',
  'lib/server/fabric-gateway-websocket-frames.js',
  'lib/server/fabric-gateway-websocket-session.js',
  'lib/server/outbound-relay-manager.js',
  'lib/server/chat-runtime-actor-registry.js',
  'lib/server/chat-runtime-bootstrap.js',
  'lib/server/chat-runtime-composition.js',
  'lib/server/chat-runtime-event-hub.js',
  'lib/server/chat-runtime-publishing-store.js',
  'lib/server/chat-runtime-recovery-coordinator.js',
  'lib/server/chat-runtime-service-support.js',
  'lib/server/chat-runtime-service.js',
  'lib/server/chat-runtime-trace-lifecycle.js',
  'lib/server/chat-runtime-trace.js',
  'lib/server/chat-runtime/canonical-interaction-payload.js',
  'lib/server/chat-runtime/codex-approval-request-adapter.js',
  'lib/server/chat-runtime/codex-interaction-adapter-support.js',
  'lib/server/chat-runtime/codex-interaction-request-adapter.js',
  'lib/server/chat-runtime/codex-mcp-elicitation-request-adapter.js',
  'lib/server/chat-runtime/codex-tool-question-request-adapter.js',
  'lib/server/code-assist-anthropic-adapter.js',
  'lib/server/code-assist-provider-strategy.js',
  'lib/server/codex-app-server-client-pool.js',
  'lib/server/codex-app-server-canonical.js',
  'lib/server/codex-app-server-endpoint.js',
  'lib/server/codex-app-server-json-rpc-client.js',
  'lib/server/codex-app-server-legacy-runner.js',
  'lib/server/codex-app-server-runner.js',
  'lib/server/codex-app-server-stdio-proxy.js',
  'lib/server/codex-desktop-account.js',
  'lib/server/daemon.js',
  'lib/server/gateway-model-list.js',
  'lib/server/management.js',
  'lib/server/model-alias-store.js',
  'lib/server/models.js',
  'lib/server/native-run-manifest.js',
  'lib/server/native-session-chat.js',
  'lib/server/provider-routing.js',
  'lib/server/provider-runtime-metadata.js',
  'lib/server/provider-protocol-routing.js',
  'lib/server/providers.js',
  'lib/server/openai-chat-sse.js',
  'lib/server/protocol-adapters.js',
  'lib/server/protocol-fallback-bridge.js',
  'lib/server/protocol-request-adapter-registry.js',
  'lib/server/protocol-registry.js',
  'lib/server/server.js',
  'lib/server/server-runtime.js',
  'lib/server/source-auto-restart.js',
  'lib/server/source-fingerprint.js',
  'lib/server/tool-protocol-diagnostics.js',
  'lib/server/upstream-endpoints.js',
  'lib/server/v1-router.js',
  'lib/server/web-ui-router.js',
  'lib/server/webui-account-routes.js',
  'lib/server/webui-chat-routes.js',
  'lib/server/webui-chat-runtime-routes.js',
  'lib/server/webui-chat-runtime-sse-writer.js',
  'lib/server/webui-chat-runtime-sse.js',
  'lib/server/webui-model-alias-routes.js',
  'lib/usage/model-usage-scheduler.js',
  'lib/protocol/tool-call-normalization.js'
]);

function normalizePath(path, filePath) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  try {
    return path.resolve(value);
  } catch (_error) {
    return value;
  }
}

function realpathIfPossible(fs, filePath) {
  if (!fs || typeof fs.realpathSync !== 'function') return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch (_error) {
    return filePath;
  }
}

function samePath(path, processObj, left, right) {
  const a = normalizePath(path, left);
  const b = normalizePath(path, right);
  if (!a || !b) return false;
  if (processObj && processObj.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function readPackageName(fs, path, rootDir) {
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return '';
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(parsed && parsed.name || '').trim();
  } catch (_error) {
    return '';
  }
}

function resolveEntryProjectRootFromPath(path, candidateEntryFilePath) {
  const normalized = normalizePath(path, candidateEntryFilePath);
  if (!normalized) return '';
  const basename = path.basename(normalized);
  if (basename === 'app.js') {
    const cliDir = path.dirname(normalized);
    const libDir = path.dirname(cliDir);
    if (path.basename(cliDir) !== 'cli' || path.basename(libDir) !== 'lib') return '';
    return path.dirname(libDir);
  }
  if (basename === 'ai-home.js') {
    const binDir = path.dirname(normalized);
    if (path.basename(binDir) !== 'bin') return '';
    return path.dirname(binDir);
  }
  return '';
}

function resolveEntryProjectRoot(fs, path, candidateEntryFilePath) {
  const normalized = normalizePath(path, candidateEntryFilePath);
  const resolved = normalizePath(path, realpathIfPossible(fs, normalized));
  return resolveEntryProjectRootFromPath(path, resolved) ||
    resolveEntryProjectRootFromPath(path, normalized);
}

function resolveCanonicalAppEntryFilePath(fs, path, candidateEntryFilePath) {
  const rootDir = resolveEntryProjectRoot(fs, path, candidateEntryFilePath);
  if (!rootDir) return '';
  return path.join(rootDir, 'lib', 'cli', 'app.js');
}

function isExistingAiHomeEntry(fs, path, candidateEntryFilePath) {
  const rootDir = resolveEntryProjectRoot(fs, path, candidateEntryFilePath);
  if (!rootDir) return false;
  const appEntryFilePath = resolveCanonicalAppEntryFilePath(fs, path, candidateEntryFilePath);
  if (!appEntryFilePath || !fs.existsSync(appEntryFilePath)) return false;
  return readPackageName(fs, path, rootDir) === 'ai_home';
}

function tokenizeProcessCommand(command) {
  return String(command || '').trim().match(/"([^"]*)"|'([^']*)'|[^\s]+/g) || [];
}

function isBackgroundSupervisorCommand(command) {
  const tokens = tokenizeProcessCommand(command);
  if (tokens.length !== 4) return false;
  const nodeExecutable = String(tokens[0] || '').replace(/^["']|["']$/g, '');
  return /[\/\\]?node(?:\.exe)?$/i.test(nodeExecutable)
    && tokens[2] === '__background'
    && tokens[3] === 'run';
}

function parseServerEntryFilePathFromCommand(command, options = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  const tokens = tokenizeProcessCommand(cmd);
  if (tokens.length < 4) return '';
  const nodeExecutable = String(tokens[0] || '').replace(/^["']|["']$/g, '');
  if (!/[\/\\]?node(?:\.exe)?$/i.test(nodeExecutable)) return '';
  const entryToken = String(tokens[1] || '').replace(/^["']|["']$/g, '');
  const isServerServe = tokens[2] === 'server' && tokens[3] === 'serve';
  const isBackgroundSupervisor = isBackgroundSupervisorCommand(cmd);
  if (!isServerServe && !isBackgroundSupervisor) return '';
  if (/[\/\\]lib[\/\\]cli[\/\\]app\.js$/.test(entryToken)) return entryToken;
  if (!options.fs || !options.path) return '';
  const appEntryFilePath = resolveCanonicalAppEntryFilePath(options.fs, options.path, entryToken);
  if (!appEntryFilePath || !options.fs.existsSync(appEntryFilePath)) return '';
  return appEntryFilePath;
}

function findSourceEntryFromCwd(fs, path, processObj) {
  const cwd = processObj && typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd();
  let dir = normalizePath(path, cwd);
  while (dir) {
    const candidate = path.join(dir, 'lib', 'cli', 'app.js');
    if (isExistingAiHomeEntry(fs, path, candidate)) return candidate;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return '';
}

function getSourceFingerprintPaths(fs, path, candidateEntryFilePath) {
  const rootDir = resolveEntryProjectRoot(fs, path, candidateEntryFilePath);
  if (!rootDir) return [];
  const relativePaths = new Set(SOURCE_FINGERPRINT_FILES);
  SOURCE_FINGERPRINT_DIRECTORIES.forEach((relativeDirectory) => {
    collectFingerprintDirectoryFiles(fs, path, rootDir, relativeDirectory)
      .forEach((relativePath) => relativePaths.add(relativePath));
  });
  return Array.from(relativePaths)
    .sort()
    .map((relativePath) => ({ relativePath, filePath: path.join(rootDir, relativePath) }))
    .filter((item) => fs.existsSync(item.filePath));
}

function collectFingerprintDirectoryFiles(fs, path, rootDir, relativeDirectory) {
  if (!fs || typeof fs.readdirSync !== 'function') return [];
  const directoryPath = path.join(rootDir, relativeDirectory);
  if (!fs.existsSync(directoryPath)) return [];
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .flatMap((entry) => {
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          return collectFingerprintDirectoryFiles(fs, path, rootDir, relativePath);
        }
        return entry.isFile() && entry.name.endsWith('.js') ? [relativePath] : [];
      });
  } catch (_error) {
    return [];
  }
}

function computeSourceFingerprint(fs, path, candidateEntryFilePath) {
  const rootDir = resolveEntryProjectRoot(fs, path, candidateEntryFilePath);
  if (!rootDir) return { rootDir: '', fingerprint: '', fileCount: 0, files: [] };
  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  const files = [];
  getSourceFingerprintPaths(fs, path, candidateEntryFilePath).forEach((item) => {
    try {
      const content = fs.readFileSync(item.filePath);
      hash.update(item.relativePath);
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
      fileCount += 1;
      files.push(item.filePath);
    } catch (_error) {}
  });
  if (!fileCount) return { rootDir, fingerprint: '', fileCount: 0, files: [] };
  return {
    rootDir,
    fingerprint: hash.digest('hex'),
    fileCount,
    files
  };
}

function getSourceFingerprintFilePath(path, aiHomeDir) {
  return path.join(aiHomeDir, 'run', SOURCE_FINGERPRINT_FILE);
}

function readRecordedSourceFingerprint(fs, sourceFingerprintFile) {
  try {
    if (!fs.existsSync(sourceFingerprintFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(sourceFingerprintFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function writeRecordedSourceFingerprint(fs, path, sourceFingerprintFile, pid, candidateEntryFilePath) {
  const current = computeSourceFingerprint(fs, path, candidateEntryFilePath);
  if (!current.fingerprint) return;
  try {
    fs.mkdirSync(path.dirname(sourceFingerprintFile), { recursive: true });
    fs.writeFileSync(sourceFingerprintFile, JSON.stringify({
      pid: Number(pid) || 0,
      entryFilePath: normalizePath(path, candidateEntryFilePath),
      sourceRoot: current.rootDir,
      sourceFingerprint: current.fingerprint,
      sourceFileCount: current.fileCount,
      writtenAt: Date.now()
    }, null, 2));
  } catch (_error) {}
}

function clearRecordedSourceFingerprint(fs, sourceFingerprintFile) {
  try { fs.unlinkSync(sourceFingerprintFile); } catch (_error) {}
}

function getSourceFreshness(options = {}) {
  const {
    fs,
    path,
    processObj,
    sourceFingerprintFile,
    pid,
    runningEntryFilePath,
    currentEntryFilePath
  } = options;
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) {
    return {
      stale: false,
      staleReason: '',
      sourceFingerprint: '',
      recordedSourceFingerprint: '',
      currentSourceEntry: '',
      runningSourceEntry: ''
    };
  }
  const currentEntry = currentEntryFilePath || '';
  const current = computeSourceFingerprint(fs, path, currentEntry);
  const recorded = readRecordedSourceFingerprint(fs, sourceFingerprintFile);
  const recordedFingerprint = String(recorded && recorded.sourceFingerprint || '').trim();
  const recordedPid = Number(recorded && recorded.pid);
  const runningEntry = normalizePath(path, runningEntryFilePath || '');
  const recordedEntry = normalizePath(path, recorded && recorded.entryFilePath || '');
  const currentEntryPath = normalizePath(path, currentEntry);
  let stale = false;
  let staleReason = '';
  if (current.fingerprint && !recordedFingerprint) {
    stale = true;
    staleReason = 'missing_source_fingerprint';
  } else if (current.fingerprint && recordedFingerprint && current.fingerprint !== recordedFingerprint) {
    stale = true;
    staleReason = 'source_changed';
  } else if (recordedPid && recordedPid !== Number(pid)) {
    stale = true;
    staleReason = 'source_fingerprint_pid_mismatch';
  } else if (recordedEntry && currentEntryPath && !samePath(path, processObj, recordedEntry, currentEntryPath)) {
    stale = true;
    staleReason = 'source_entry_changed';
  }
  return {
    stale,
    staleReason,
    sourceFingerprint: current.fingerprint || '',
    recordedSourceFingerprint: recordedFingerprint,
    currentSourceEntry: currentEntryPath,
    runningSourceEntry: runningEntry || recordedEntry
  };
}

module.exports = {
  SOURCE_FINGERPRINT_DIRECTORIES,
  SOURCE_FINGERPRINT_FILE,
  SOURCE_FINGERPRINT_FILES,
  clearRecordedSourceFingerprint,
  computeSourceFingerprint,
  findSourceEntryFromCwd,
  getSourceFingerprintFilePath,
  getSourceFingerprintPaths,
  getSourceFreshness,
  isExistingAiHomeEntry,
  isBackgroundSupervisorCommand,
  normalizePath,
  parseServerEntryFilePathFromCommand,
  readRecordedSourceFingerprint,
  resolveEntryProjectRoot,
  samePath,
  writeRecordedSourceFingerprint
};
