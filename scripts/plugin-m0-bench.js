'use strict';

// 插件 M0 基线测量：空链（不触发 RPC）与启用一个插件（经真实 Plugin Host 往返）的 p50/p95/p99。
// 用法：node scripts/plugin-m0-bench.js [--json]
// 结果随机器与负载变化；报告里必须同时记下机器、Node 版本与这里的参数。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginHostSupervisor } = require('../lib/plugins/host/supervisor');
const { createPluginDispatcher } = require('../lib/plugins/host/dispatcher');

const ROOT = path.resolve(__dirname, '..');

function percentiles(samples) {
  const sorted = Float64Array.from(samples).sort();
  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))];
  return { n: sorted.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: sorted[sorted.length - 1] };
}

async function measure(iterations, warmup, run) {
  for (let index = 0; index < warmup; index += 1) await run(index);
  const samples = new Array(iterations);
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    await run(index);
    samples[index] = Number(process.hrtime.bigint() - started) / 1e3; // 微秒
  }
  return percentiles(samples);
}

async function main() {
  const base = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'aihb-'));
  const sample = path.join(base, 'echo');
  fs.cpSync(path.join(ROOT, 'examples', 'plugins', 'echo'), sample, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(sample, 'plugin.json'), 'utf8'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\aih-plugin-bench-${path.basename(base)}` : path.join(base, 'h.sock');
  const supervisor = createPluginHostSupervisor({ aiHomeDir: base, socketPath });
  const results = {};
  try {
    const idle = createPluginDispatcher({ supervisor });
    const request = { model: 'gpt-x', input: 'hello' };
    results.emptyChain = await measure(200000, 20000, () => idle.dispatch('gateway.request', request));
    results.hostStartedByEmptyChain = supervisor.status().running;

    await supervisor.start();
    await supervisor.call('prepare', { generation: 1, plugins: [{ instanceId: 'echo', manifest, entryPath: path.join(sample, 'index.mjs') }] });
    await supervisor.call('activate', { generation: 1 });
    const enabled = createPluginDispatcher({ supervisor });
    enabled.publish(1, [{ id: 'sample.echo.call', capability: 'command', instanceId: 'echo' }]);
    results.onePluginSmall = await measure(3000, 300, () => enabled.dispatch('command', request));
    const oneMiB = Buffer.alloc(1024 * 1024, 7);
    results.onePlugin1MiBPayload = await measure(300, 30, () => supervisor.call('invoke', { contributionId: 'sample.echo.call', value: null }, { payload: oneMiB }));
    results.hostPid = supervisor.status().pid;
  } finally {
    await supervisor.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
  results.environment = {
    node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
    totalMemGiB: Math.round(os.totalmem() / 2 ** 30)
  };
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const row = (name, stats) => `${name.padEnd(24)} n=${String(stats.n).padEnd(7)} p50=${stats.p50.toFixed(2)}µs p95=${stats.p95.toFixed(2)}µs p99=${stats.p99.toFixed(2)}µs max=${stats.max.toFixed(0)}µs`;
  console.log(row('empty chain', results.emptyChain));
  console.log(`  host started by empty chain: ${results.hostStartedByEmptyChain}`);
  console.log(row('1 plugin, small JSON', results.onePluginSmall));
  console.log(row('1 plugin, 1 MiB payload', results.onePlugin1MiBPayload));
  console.log(JSON.stringify(results.environment));
}

main().catch((error) => { console.error(error); process.exit(1); });
