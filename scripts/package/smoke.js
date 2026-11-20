#!/usr/bin/env node
'use strict';

/**
 * 分发包冒烟：不依赖系统 Node，运行 CLI、启动网关、拉取内置 WebUI。
 *
 *   node scripts/package/smoke.js
 *   node scripts/package/smoke.js --artifact dist/release/aih-1.0.0-darwin-arm64.run
 *   node scripts/package/smoke.js --artifact dist/release/aih-1.0.0-darwin-arm64.tar.gz
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const options = { artifact: '', keep: false, timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--artifact') options.artifact = next();
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next()) || 30000;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function findHostArtifact() {
  const releaseDir = path.join(REPOSITORY_ROOT, 'dist', 'release');
  if (!fs.existsSync(releaseDir)) return '';
  const suffix = process.platform === 'win32' ? `.exe` : `.run`;
  const candidates = fs.readdirSync(releaseDir)
    .filter((name) => name.includes(`-${process.platform}-${process.arch}`) && name.endsWith(suffix))
    .sort();
  return candidates.length ? path.join(releaseDir, candidates[candidates.length - 1]) : '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function extractTarGz(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`tar exited with ${result.status}`);
  const entries = fs.readdirSync(destination, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length !== 1) throw new Error('archive must contain exactly one bundle directory');
  return path.join(destination, entries[0].name);
}

/** 返回 { command, args, env, cleanup }，其中 command 是可直接执行的 aih 启动器。 */
function prepareApp(artifact, sandbox) {
  // Go Server 要求显式管理密钥/客户端密钥（空 home 没有持久化配置），
  // 这里给每次冒烟用的临时值，不触及任何真实凭据。
  const token = crypto.randomBytes(16).toString('hex');
  const env = {
    HOME: path.join(sandbox, 'home'),
    AIH_HOME_DIR: path.join(sandbox, 'ai-home'),
    AIH_SERVER_MANAGEMENT_KEY: 'smoke-mgmt-' + token,
    AIH_SERVER_API_KEY: 'smoke-client-' + token,
    PATH: '/usr/bin:/bin',
    TERM: 'dumb'
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.AIH_HOME_DIR, { recursive: true });

  if (!artifact.endsWith('.tar.gz') && !artifact.endsWith('.zip')) {
    env.AIH_PKG_DIR = path.join(sandbox, 'pkg');
    return { command: artifact, args: [], env };
  }
  if (artifact.endsWith('.zip')) throw new Error('zip smoke is not supported on this platform; use the single-file artifact');
  const root = extractTarGz(artifact, path.join(sandbox, 'unpack'));
  const launcher = path.join(root, process.platform === 'win32' ? 'aih.exe' : 'aih');
  if (!fs.existsSync(launcher)) throw new Error(`launcher missing after extraction: ${launcher}`);
  return { command: launcher, args: [], env, root };
}

function resolveExtractedRoot(pkgDir) {
  if (!pkgDir || !fs.existsSync(pkgDir)) return '';
  const entries = fs.readdirSync(pkgDir).sort();
  return entries.length ? path.join(pkgDir, entries[0]) : '';
}

function assertCleanBundle(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
        throw new Error(`bundle contains macOS metadata: ${path.relative(root, path.join(current, entry.name))}`);
      }
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  const nativeRoot = path.join(root, 'bin', 'native');
  if (fs.existsSync(nativeRoot)) {
    const targets = fs.readdirSync(nativeRoot);
    if (targets.length > 1) throw new Error(`bundle ships multiple Go targets: ${targets.join(', ')}`);
  }
}

function runHelp(app) {
  const result = spawnSync(app.command, [...app.args, 'help'], {
    env: app.env,
    encoding: 'utf8',
    timeout: 60000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`aih help exited with ${result.status}: ${result.stderr}`);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // 顶层 help 现在是 Go CLI 的用法表，不再打印 "AI Home" 标语；旧包仍是标语。
  if (!/用法:/.test(output) && !/AI Home/.test(output)) {
    throw new Error('aih help printed neither the usage table nor the AI Home banner');
  }
  return output;
}

async function pollUi(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ui/`, { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) return await response.text();
      lastError = new Error(`/ui/ returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`WebUI did not become ready: ${lastError && lastError.message}`);
}

function assertBundledAssets(html, port) {
  const references = [...html.matchAll(/(?:src|href)="(\/ui\/[^"]+)"/g)].map((match) => match[1]);
  if (references.length === 0) throw new Error('WebUI index.html has no /ui/ assets');
  return Promise.all(references.map(async (reference) => {
    const response = await fetch(`http://127.0.0.1:${port}${reference}`, { signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw new Error(`${reference} returned ${response.status}`);
    return reference;
  }));
}

async function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// aih-server 的优雅关闭最长 10s（在跑的推理要收尾），冒烟必须先等它，必要时补
// SIGKILL，否则解包目录仍被写，rmSync 会撞 ENOTEMPTY。
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  // aih launcher 会 exec/派生 aih-server，只给直接子进程发信号会留下孤儿服务端
  //（它还握着解包目录）。因此冒烟用独立进程组，整组发信号。
  if (process.platform === 'win32') {
    // Windows 没有进程组：SFX → aih-go → aih-server 是三层，必须按树杀，
    // 否则会留下孤儿服务端继续占着解包目录。
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await waitForExit(child, 10000);
    return;
  }
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (_error) { /* 进程组已消失 */ }
  };
  signal('SIGTERM');
  if (await waitForExit(child, 14000)) return;
  signal('SIGKILL');
  await waitForExit(child, 5000);
}

// 清理失败不能把冒烟判成失败：删不掉时重试，再退化成一次系统 rm。
function removeSandbox(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (_error) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  const result = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir])
    : spawnSync('rm', ['-rf', dir]);
  if (result.status !== 0) console.warn(`[smoke] warn: sandbox not removed: ${dir}`);
}

async function smoke(options) {
  const artifact = options.artifact ? path.resolve(options.artifact) : findHostArtifact();
  if (!artifact) throw new Error('no release artifact found; build one first or pass --artifact');
  if (!fs.existsSync(artifact)) throw new Error(`artifact does not exist: ${artifact}`);

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-smoke-'));
  const app = prepareApp(artifact, sandbox);
  let server = null;
  let logStream = null;
  try {
    console.log(`[smoke] artifact: ${path.relative(REPOSITORY_ROOT, artifact) || artifact}`);
    runHelp(app);
    const bundleRoot = app.root || resolveExtractedRoot(app.env.AIH_PKG_DIR);
    if (bundleRoot) assertCleanBundle(bundleRoot);
    console.log('[smoke] CLI runs without system Node');

    const port = await freePort();
    const logFile = path.join(sandbox, 'server.log');
    logStream = fs.createWriteStream(logFile);
    server = spawn(app.command, [...app.args, 'server', 'serve', '--port', String(port)], {
      env: app.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    server.stdout.pipe(logStream);
    server.stderr.pipe(logStream);

    const html = await pollUi(port, options.timeoutMs);
    if (!/<html/i.test(html)) throw new Error('served /ui/ is not HTML');
    const assets = await assertBundledAssets(html, port);
    console.log(`[smoke] WebUI served from bundle (${assets.length} assets, port ${port})`);

    const log = fs.readFileSync(logFile, 'utf8');
    // 旧包（Node CLI）打印 "server serve started"；Go CLI 直接透传 aih-server 的
    // "listening on http://..."。
    if (!/server serve started/.test(log) && !/aih-server listening on http:\/\//.test(log)) {
      throw new Error('server did not report a successful start');
    }
    console.log('[smoke] gateway started with the packaged runtime');
  } finally {
    await stopServer(server);
    if (logStream) {
      // 先等日志流真正关闭，否则流句柄会在 rm 之后把 server.log 又写回来。
      await new Promise((resolve) => logStream.end(resolve));
    }
    if (!options.keep) removeSandbox(sandbox);
    else console.log(`[smoke] kept sandbox: ${sandbox}`);
  }
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/package/smoke.js [--artifact <path>] [--keep] [--timeout-ms N]');
    process.exit(0);
  }
  smoke(options).then(
    () => {
      console.log('[smoke] PASS');
    },
    (error) => {
      console.error(`[smoke] FAIL: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { findHostArtifact, prepareApp, runHelp, smoke };
