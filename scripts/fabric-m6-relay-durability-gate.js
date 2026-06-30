#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  runFabricTransportEcho
} = require('../lib/cli/services/fabric/transport-echo');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_ECHO_PATH = '/v0/fabric/transport/echo';
const DEFAULT_ROUNDS = 6;
const DEFAULT_COUNT_PER_ROUND = 20;
const DEFAULT_PAYLOAD_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_ROUND_INTERVAL_MS = 1000;
const DEFAULT_ECHO_INTERVAL_MS = 0;
const DEFAULT_MIN_SUCCESS_RATE = 1;

function showHelp() {
  console.log(`AIH Fabric M6 relay durability gate

Usage:
  node scripts/fabric-m6-relay-durability-gate.js [options]

Options:
  --endpoint <url>              AWS/current endpoint, default ${DEFAULT_ENDPOINT}.
  --target <ws-url>             Direct WebSocket echo target; overrides --endpoint/--path.
  --path <path>                 Echo path on endpoint, default ${DEFAULT_ECHO_PATH}.
  --rounds <n>                  Echo rounds, default ${DEFAULT_ROUNDS}.
  --count-per-round <n>         Echo frames per round, default ${DEFAULT_COUNT_PER_ROUND}.
  --payload-size <n>            Echo payload bytes, default ${DEFAULT_PAYLOAD_SIZE}.
  --timeout-ms <n>              Per echo open/frame timeout, default ${DEFAULT_TIMEOUT_MS}.
  --round-interval-ms <n>       Delay between rounds, default ${DEFAULT_ROUND_INTERVAL_MS}.
  --echo-interval-ms <n>        Delay between frames within one round, default ${DEFAULT_ECHO_INTERVAL_MS}.
  --min-success-rate <n|n%>     Required aggregate success rate, default 1 / 100%.
  --diagnostics-file <path>     Write aggregate report JSON.
  --json                        Print JSON only.
  -h, --help                    Show this help.

This gate is a small real durability check for the current default relay
fallback. It does not import provider credentials, open product ports, or touch
retired VPS targets.
`);
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) throw new Error(`${flag} requires a value`);
  return { value: String(value), consumed: 2 };
}

function normalizeText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizePath(value) {
  const text = normalizeText(value, 512) || DEFAULT_ECHO_PATH;
  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeHttpEndpoint(value, flag = '--endpoint') {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid_protocol');
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function normalizeWsTarget(value, flag = '--target') {
  const raw = normalizeText(value, 2048);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('invalid_protocol');
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    throw new Error(`${flag} must be a valid ws(s) URL`);
  }
}

function parseInteger(value, flag, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseSuccessRate(value, flag = '--min-success-rate') {
  const raw = normalizeText(value, 64);
  if (!raw) return DEFAULT_MIN_SUCCESS_RATE;
  const parsed = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a number between 0 and 1, or a percent between 0% and 100%`);
  }
  return parsed;
}

function buildWebSocketUrlFromEndpoint(endpoint, suffix = DEFAULT_ECHO_PATH) {
  const parsed = new URL(normalizeHttpEndpoint(endpoint));
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = normalizePath(suffix);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    json: false,
    endpoint: DEFAULT_ENDPOINT,
    target: '',
    path: DEFAULT_ECHO_PATH,
    rounds: DEFAULT_ROUNDS,
    countPerRound: DEFAULT_COUNT_PER_ROUND,
    payloadSize: DEFAULT_PAYLOAD_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    roundIntervalMs: DEFAULT_ROUND_INTERVAL_MS,
    echoIntervalMs: DEFAULT_ECHO_INTERVAL_MS,
    minSuccessRate: DEFAULT_MIN_SUCCESS_RATE,
    diagnosticsFile: ''
  };

  for (let index = 0; index < argv.length;) {
    const token = normalizeText(argv[index], 256);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--target' || token.startsWith('--target=')) {
      const next = readOptionValue(argv, index, '--target');
      options.target = normalizeWsTarget(next.value, '--target');
      index += next.consumed;
      continue;
    }
    if (token === '--path' || token.startsWith('--path=')) {
      const next = readOptionValue(argv, index, '--path');
      options.path = normalizePath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--rounds' || token.startsWith('--rounds=')) {
      const next = readOptionValue(argv, index, '--rounds');
      options.rounds = parseInteger(next.value, '--rounds', DEFAULT_ROUNDS, 1, 1440);
      index += next.consumed;
      continue;
    }
    if (token === '--count-per-round' || token.startsWith('--count-per-round=')) {
      const next = readOptionValue(argv, index, '--count-per-round');
      options.countPerRound = parseInteger(next.value, '--count-per-round', DEFAULT_COUNT_PER_ROUND, 1, 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--payload-size' || token.startsWith('--payload-size=')) {
      const next = readOptionValue(argv, index, '--payload-size');
      options.payloadSize = parseInteger(next.value, '--payload-size', DEFAULT_PAYLOAD_SIZE, 0, 1024 * 1024);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parseInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--round-interval-ms' || token.startsWith('--round-interval-ms=')) {
      const next = readOptionValue(argv, index, '--round-interval-ms');
      options.roundIntervalMs = parseInteger(next.value, '--round-interval-ms', DEFAULT_ROUND_INTERVAL_MS, 0, 60000);
      index += next.consumed;
      continue;
    }
    if (token === '--echo-interval-ms' || token.startsWith('--echo-interval-ms=')) {
      const next = readOptionValue(argv, index, '--echo-interval-ms');
      options.echoIntervalMs = parseInteger(next.value, '--echo-interval-ms', DEFAULT_ECHO_INTERVAL_MS, 0, 60000);
      index += next.consumed;
      continue;
    }
    if (token === '--min-success-rate' || token.startsWith('--min-success-rate=')) {
      const next = readOptionValue(argv, index, '--min-success-rate');
      options.minSuccessRate = parseSuccessRate(next.value, '--min-success-rate');
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function percentile(values, rank) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1))];
}

function summarizeRttValues(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round((sum / sorted.length) * 100) / 100,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

function normalizeFailureReason(value) {
  return normalizeText(value, 160) || 'relay_echo_failed';
}

function summarizeFailureReasons(rounds = []) {
  const counts = new Map();
  rounds.forEach((round) => {
    (round.failures || []).forEach((failure) => {
      const reason = normalizeFailureReason(failure.error || failure.reason);
      counts.set(reason, (counts.get(reason) || 0) + 1);
    });
    if (!round.ok && (!round.failures || round.failures.length === 0)) {
      counts.set('round_incomplete', (counts.get('round_incomplete') || 0) + 1);
    }
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => ({ reason, count }));
}

function classifyRoundReport(report = {}, index = 1) {
  const count = Number(report.count || 0);
  const successes = Number(report.successes || 0);
  const failures = Array.isArray(report.failures) ? report.failures.map((failure) => ({
    id: String(failure.id || ''),
    error: normalizeFailureReason(failure.error)
  })) : [];
  return {
    index,
    ok: Boolean(report.ok && count > 0 && successes === count && failures.length === 0),
    target: report.target || '',
    count,
    successes,
    failureCount: Math.max(0, count - successes) + failures.length,
    payloadSize: Number(report.payloadSize || 0),
    durationMs: Number(report.durationMs || 0),
    rttMs: report.rttMs || summarizeRttValues([]),
    failures
  };
}

function classifyErroredRound(error, options = {}, index = 1, target = '') {
  return {
    index,
    ok: false,
    target,
    count: Number(options.countPerRound || 0),
    successes: 0,
    failureCount: Number(options.countPerRound || 0),
    payloadSize: Number(options.payloadSize || 0),
    durationMs: 0,
    rttMs: summarizeRttValues([]),
    failures: [{
      id: 'round',
      error: normalizeFailureReason(error && (error.code || error.message) || error)
    }]
  };
}

function buildSummary(rounds = [], options = {}) {
  const totalAttempts = rounds.reduce((sum, round) => sum + Number(round.count || 0), 0);
  const successes = rounds.reduce((sum, round) => sum + Number(round.successes || 0), 0);
  const failures = Math.max(0, totalAttempts - successes);
  const successRate = totalAttempts > 0 ? successes / totalAttempts : 0;
  const rttValues = [];
  rounds.forEach((round) => {
    if (!round.rttMs || Number(round.rttMs.count || 0) <= 0) return;
    if (Array.isArray(round.samples)) {
      round.samples.forEach((sample) => rttValues.push(Number(sample.rttMs)));
    }
  });
  const blockers = [];
  if (rounds.some((round) => !round.ok)) blockers.push('relay_rounds_failed');
  if (successes < totalAttempts) blockers.push('relay_echo_failures');
  if (successRate < Number(options.minSuccessRate || DEFAULT_MIN_SUCCESS_RATE)) {
    blockers.push('relay_success_rate_below_budget');
  }
  if (successes > 0 && rttValues.length < successes) blockers.push('relay_rtt_samples_missing');

  return {
    ok: blockers.length === 0,
    rounds: rounds.length,
    passedRounds: rounds.filter((round) => round.ok).length,
    failedRounds: rounds.filter((round) => !round.ok).length,
    totalAttempts,
    successes,
    failures,
    successRate: Math.round(successRate * 10000) / 10000,
    requiredSuccessRate: Number(options.minSuccessRate || DEFAULT_MIN_SUCCESS_RATE),
    rttMs: summarizeRttValues(rttValues),
    failureReasons: summarizeFailureReasons(rounds),
    blockers
  };
}

async function runRound(target, options = {}, deps = {}, index = 1) {
  const runner = deps.runFabricTransportEcho || runFabricTransportEcho;
  const report = await runner([
    target,
    '--count',
    String(options.countPerRound),
    '--payload-size',
    String(options.payloadSize),
    '--timeout-ms',
    String(options.timeoutMs),
    '--interval-ms',
    String(options.echoIntervalMs),
    '--json'
  ], deps);
  const round = classifyRoundReport(report, index);
  round.samples = Array.isArray(report.samples) ? report.samples.map((sample) => ({
    id: String(sample.id || ''),
    rttMs: Number(sample.rttMs || 0),
    payloadBytes: Number(sample.payloadBytes || 0)
  })) : [];
  return round;
}

async function runDurabilityGate(rawOptions = {}, deps = {}) {
  const options = {
    endpoint: DEFAULT_ENDPOINT,
    target: '',
    path: DEFAULT_ECHO_PATH,
    rounds: DEFAULT_ROUNDS,
    countPerRound: DEFAULT_COUNT_PER_ROUND,
    payloadSize: DEFAULT_PAYLOAD_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    roundIntervalMs: DEFAULT_ROUND_INTERVAL_MS,
    echoIntervalMs: DEFAULT_ECHO_INTERVAL_MS,
    minSuccessRate: DEFAULT_MIN_SUCCESS_RATE,
    diagnosticsFile: '',
    ...rawOptions
  };
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.path = normalizePath(options.path);
  if (options.target) options.target = normalizeWsTarget(options.target, '--target');
  const target = options.target || buildWebSocketUrlFromEndpoint(options.endpoint, options.path);
  const startedAt = Date.now();
  const rounds = [];

  for (let index = 1; index <= options.rounds; index += 1) {
    try {
      rounds.push(await runRound(target, options, deps, index));
    } catch (error) {
      rounds.push(classifyErroredRound(error, options, index, target));
    }
    if (index < options.rounds && options.roundIntervalMs > 0) {
      await sleep(options.roundIntervalMs);
    }
  }

  const summary = buildSummary(rounds, options);
  const report = {
    ok: summary.ok,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: {
      endpoint: options.endpoint,
      echoUrl: target,
      path: options.path
    },
    budget: {
      rounds: options.rounds,
      countPerRound: options.countPerRound,
      payloadSize: options.payloadSize,
      timeoutMs: options.timeoutMs,
      roundIntervalMs: options.roundIntervalMs,
      echoIntervalMs: options.echoIntervalMs,
      minSuccessRate: options.minSuccessRate
    },
    summary,
    rounds
  };
  if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

function writeDiagnosticsFile(filePath, report) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 10000) / 100}%`;
}

function formatReport(report = {}) {
  const summary = report.summary || {};
  const rtt = summary.rttMs || {};
  const lines = [
    'AIH Fabric M6 relay durability gate',
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  target: ${report.target && report.target.echoUrl || ''}`,
    `  rounds: ${Number(summary.passedRounds || 0)}/${Number(summary.rounds || 0)}`,
    `  attempts: ${Number(summary.successes || 0)}/${Number(summary.totalAttempts || 0)} success_rate=${formatPercent(summary.successRate)}`,
    `  rtt: min=${Number(rtt.min || 0)}ms p50=${Number(rtt.p50 || 0)}ms p95=${Number(rtt.p95 || 0)}ms p99=${Number(rtt.p99 || 0)}ms max=${Number(rtt.max || 0)}ms avg=${Number(rtt.avg || 0)}ms`
  ];
  if (Array.isArray(summary.failureReasons) && summary.failureReasons.length) {
    lines.push('  failure_reasons:');
    summary.failureReasons.forEach((item) => {
      lines.push(`    - ${item.reason}: ${item.count}`);
    });
  }
  if (Array.isArray(summary.blockers) && summary.blockers.length) {
    lines.push('  blockers:');
    summary.blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  lines.push(`  result: ${report.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runDurabilityGate(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-m6-relay-durability-gate] ${String(error && error.message || error)}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_COUNT_PER_ROUND,
  DEFAULT_ECHO_PATH,
  DEFAULT_ENDPOINT,
  DEFAULT_MIN_SUCCESS_RATE,
  DEFAULT_PAYLOAD_SIZE,
  DEFAULT_ROUNDS,
  buildSummary,
  buildWebSocketUrlFromEndpoint,
  classifyRoundReport,
  formatReport,
  parseArgs,
  runDurabilityGate,
  summarizeFailureReasons,
  summarizeRttValues
};
