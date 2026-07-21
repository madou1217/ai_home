'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'ai-home.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

async function freePort() {
  const server = net.createServer();
  const address = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('condition_timeout');
}

function withTimeout(promise, timeoutMs, code) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isolatedServerEnvironment(homeDir) {
  const env = { ...process.env };
  Object.keys(env).forEach((key) => {
    if (/^AIH_SERVER_/i.test(key)) delete env[key];
  });
  return {
    ...env,
    AIH_HOME: homeDir,
    AIH_HOST_HOME: homeDir,
    HOME: homeDir,
    AIH_SERVER_ALLOW_MULTI: '1',
    AIH_SERVER_STRICT_PORT: '1',
    AIH_SERVER_DISABLE_MDNS: '1',
    AIH_SERVER_SOURCE_AUTO_RESTART: '0',
    AIH_SERVER_CODEX_DESKTOP_HOOK: '0',
    AIH_SERVER_CODEX_CLI_HOOK: '0',
    AIH_SERVER_PROXY_URL: '',
    AIH_SERVER_NO_PROXY: '127.0.0.1,localhost',
    HTTPS_PROXY: '',
    https_proxy: '',
    HTTP_PROXY: '',
    http_proxy: '',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost'
  };
}

function startAihServer(input) {
  const args = [
    CLI_PATH,
    'server',
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(input.port),
    '--provider',
    'codex',
    '--management-key',
    input.managementKey,
    '--client-key',
    input.clientKey,
    '--codex-base-url',
    input.codexBaseUrl,
    '--no-model-usage-scan',
    '--no-request-log'
  ];
  const child = spawn(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    env: isolatedServerEnvironment(input.homeDir),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk || ''); });
  child.stderr.on('data', (chunk) => { output += String(chunk || ''); });
  return { child, output: () => output };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, 5_000, 'timeout');
  });
  const result = await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);
  if (result === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function readJson(url, init) {
  const response = await fetch(url, init);
  return { response, payload: await response.json() };
}

module.exports = {
  freePort,
  listen,
  readJson,
  startAihServer,
  stopChild,
  waitFor,
  withTimeout
};
