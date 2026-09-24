#!/usr/bin/env node
'use strict';

// Go Core 性能基准（P4/S10）：同一只读端点在三种拓扑下的延迟、吞吐与进程资源。
//   node-direct : Node 公开宿主自己应答（未划转）
//   node-to-go  : Node 鉴权后透明转发给 Go
//   go-direct   : 直接打 Go 私有端点
// 默认端点 GET /v1/models/{id}：两端都不读账号、不打上游，只量网关本身 + 转发一跳。
// 真实推理基准会消耗 token，只在推理条目划转后按需另行执行。
//
// 用法: node scripts/go-core-benchmark.js [--requests 2000] [--concurrency 50] [--json]
// 在临时 AIH_HOME 中拉起隔离的 Node 与 Go（不触碰用户数据），结束后全部清理。

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { startLocalServer } = require('../lib/server/server');
const { createGoCoreHost } = require('../lib/server/go-core-host');
const { ensureGoServerBinary } = require('../test/helpers/go-bridge');
const {
  createProcessCapture,
  createServeOptions,
  createServerDeps,
  getFreePort
} = require('../test/helpers/local-server-harness');

const CLIENT_KEY = 'benchmark-client-key-that-is-long-enough';
const GO_CLIENT_KEY = 'benchmark-go-client-key-that-is-long-enough';
const BENCH_PATH = '/v1/models/claude-opus-5';

function parseArgs(argv) {
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? Number(argv[index + 1]) : fallback;
  };
  return {
    requests: read('--requests', 2000),
    concurrency: read('--concurrency', 50),
    warmup: read('--warmup', 200),
    json: argv.includes('--json')
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function request(agent, target, key) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let ttfb = 0;
    const req = http.request({
      host: target.host,
      port: target.port,
      path: BENCH_PATH,
      method: 'GET',
      agent,
      headers: { authorization: `Bearer ${key}` }
    }, (res) => {
      ttfb = Number(process.hrtime.bigint() - started) / 1e6;
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 200, ttfb, total: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
    req.on('error', () => resolve({ ok: false, ttfb: 0, total: Number(process.hrtime.bigint() - started) / 1e6 }));
    req.end();
  });
}

async function runLoad(target, key, { requests, concurrency }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const samples = [];
  let failures = 0;
  let issued = 0;
  const started = process.hrtime.bigint();
  async function worker() {
    while (issued < requests) {
      issued += 1;
      const result = await request(agent, target, key);
      if (result.ok) samples.push(result.ttfb);
      else failures += 1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  agent.destroy();
  samples.sort((a, b) => a - b);
  return {
    requests,
    failures,
    throughputRps: Math.round((samples.length / elapsedMs) * 1000),
    ttfbP50Ms: +percentile(samples, 50).toFixed(3),
    ttfbP99Ms: +percentile(samples, 99).toFixed(3)
  };
}

function sampleProcess(pid) {
  const out = childProcess.spawnSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' });
  const [rss, time] = String(out.stdout || '').trim().split(/\s+/);
  const cpuSeconds = String(time || '0:0').split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  return { rssMb: Math.round(Number(rss || 0) / 1024), cpuSeconds };
}

// 压测客户端跑在独立子进程里，Node 宿主进程的 CPU 读数才不含客户端开销。
function runLoadInChild(target, key, options) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [
      __filename, '--load', target.host, String(target.port),
      '--requests', String(options.requests), '--concurrency', String(options.concurrency)
    ], { env: { ...process.env, AIH_BENCH_KEY: key }, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`load generator exited ${code}`))));
  });
}

async function measure(label, target, key, options, pids) {
  await runLoadInChild(target, key, { requests: options.warmup, concurrency: options.concurrency });
  const before = Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, sampleProcess(pid)]));
  const load = await runLoadInChild(target, key, options);
  const after = Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, sampleProcess(pid)]));
  const processes = {};
  for (const name of Object.keys(pids)) {
    processes[name] = {
      rssMb: after[name].rssMb,
      cpuSeconds: +(after[name].cpuSeconds - before[name].cpuSeconds).toFixed(2)
    };
  }
  return { label, ...load, processes };
}

async function startStack(goRoutes) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-bench-'));
  const processObj = createProcessCapture();
  Object.assign(processObj.env, {
    HOME: aiHomeDir,
    AIH_GO_CORE_ENABLED: '1',
    AIH_GO_CORE_BINARY: ensureGoServerBinary(),
    AIH_GO_CORE_PORT: String(await getFreePort()),
    AIH_GO_CORE_ACCOUNT_SYNC: '0',
    AIH_GO_CORE_CLIENT_KEY: GO_CLIENT_KEY,
    AIH_GO_CORE_ROUTES: goRoutes
  });
  const port = await getFreePort();
  let goHost = null;
  const lifecycle = { logTimers: new Set(), logTimersCleared: 0 };
  const handle = await startLocalServer(
    createServeOptions(port, { manageProcessLifecycle: false, clientKey: CLIENT_KEY }),
    createServerDeps(aiHomeDir, processObj, lifecycle, {
      createGoCoreHost: (options) => {
        goHost = createGoCoreHost({ ...options, spawn: childProcess.spawn, fetchImpl: fetch });
        return goHost;
      }
    })
  );
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && goHost.status().state !== 'ready') {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (goHost.status().state !== 'ready') throw new Error(`Go Core not ready: ${goHost.status().error}`);
  return {
    node: { host: '127.0.0.1', port },
    go: new URL(goHost.status().endpoint),
    goPid: goHost.status().pid,
    async stop() {
      await handle.stop('benchmark');
      fs.rmSync(aiHomeDir, { recursive: true, force: true });
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = [];

  // node-direct：不划转，Node 自己应答。
  const direct = await startStack('');
  try {
    results.push(await measure('node-direct', direct.node, CLIENT_KEY, options, { node: process.pid }));
  } finally {
    await direct.stop();
  }

  // node-to-go 与 go-direct：同一对进程，只差是否经过 Node 转发。
  const forwarded = await startStack('gateway.models.detail');
  try {
    results.push(await measure('node-to-go', forwarded.node, CLIENT_KEY, options, { node: process.pid, go: forwarded.goPid }));
    const goTarget = { host: forwarded.go.hostname, port: Number(forwarded.go.port) };
    results.push(await measure('go-direct', goTarget, GO_CLIENT_KEY, options, { node: process.pid, go: forwarded.goPid }));
  } finally {
    await forwarded.stop();
  }

  if (options.json) {
    console.log(JSON.stringify({ path: BENCH_PATH, requests: options.requests, concurrency: options.concurrency, results }, null, 2));
    return;
  }
  console.log(`GET ${BENCH_PATH}  requests=${options.requests} concurrency=${options.concurrency}`);
  console.log('topology      rps     p50(ms)  p99(ms)  fail  node rss/cpu      go rss/cpu');
  for (const row of results) {
    const node = row.processes.node || { rssMb: 0, cpuSeconds: 0 };
    const go = row.processes.go;
    console.log(
      `${row.label.padEnd(12)} ${String(row.throughputRps).padStart(6)}  ${String(row.ttfbP50Ms).padStart(7)}  ${String(row.ttfbP99Ms).padStart(7)}  ${String(row.failures).padStart(4)}  `
      + `${`${node.rssMb}MB/${node.cpuSeconds}s`.padEnd(16)}  ${go ? `${go.rssMb}MB/${go.cpuSeconds}s` : '-'}`
    );
  }
}

async function loadMain(argv) {
  const index = argv.indexOf('--load');
  const target = { host: argv[index + 1], port: Number(argv[index + 2]) };
  const options = parseArgs(argv);
  process.stdout.write(JSON.stringify(await runLoad(target, process.env.AIH_BENCH_KEY || '', options)));
}

if (require.main === module && process.argv.includes('--load')) {
  loadMain(process.argv.slice(2)).then(() => process.exit(0), () => process.exit(1));
} else if (require.main === module) {
  main().then(() => process.exit(0), (error) => {
    console.error(`[aih] benchmark failed: ${error.message}`);
    process.exit(1);
  });
}
