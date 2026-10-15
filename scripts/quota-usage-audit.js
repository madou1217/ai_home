#!/usr/bin/env node
'use strict';

// 用量（额度）审计：对 DB 里每个已登记账号跑一遍**产品自身的探测路径**，并客观记录：
//   1) 该 provider 自己声明的额度能力与策略链（来自 lib/providers/defs/<id>.js，脚本不写名单）；
//   2) 探测过程中是否 spawn 了**本机 provider 客户端**（NODE_DEBUG=child_process 的 CHILD_PROCESS 行
//      + 与客户端可执行名比对，排除 sw_vers/security 之类的系统探测）；
//   3) 结果（窗口百分比 / 错误 / 耗时）。
//
// 中继（relay）形态来自描述符声明（不在这里测量：那需要真的发一次推理请求）。
//
// 用法（只读；--refresh 会真的打上游，消耗一次额度查询）：
//   node scripts/quota-usage-audit.js [--json out.json] [--provider cline,codex]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { listProviderIds } = require('../lib/provider-catalog');
const { getProviderCapability, getProviderRegistry, listProviders } = require('../lib/providers');
const { listAccountCredentialRecords } = require('../lib/server/account-credential-store');
const { describeQuotaProvider, listQuotaProviders } = require('../lib/usage/quota');

// 会被误判成「客户端依赖」的系统探测/工具（不是 provider 客户端）。
const SYSTEM_PROBES = new Set([
  'sw_vers', 'uname', 'security', 'which', 'where', 'sh', 'bash', 'zsh', 'cmd.exe', 'powershell',
  'node', 'npm', 'npx', 'git', 'open', 'xdg-open', 'tasklist', 'ps', 'launchctl'
]);

function parseArgs(argv) {
  const options = { providers: null, jsonPath: '', timeoutMs: 120000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { options.jsonPath = String(argv[index + 1] || '').trim(); index += 1; }
    else if (arg === '--provider') { options.providers = String(argv[index + 1] || '').split(',').map((v) => v.trim()).filter(Boolean); index += 1; }
    else if (arg === '--timeout-ms') { options.timeoutMs = Math.max(5000, Number(argv[index + 1]) || options.timeoutMs); index += 1; }
  }
  return options;
}

function resolveAiHomeDir() {
  return String(process.env.AIH_HOME_DIR || process.env.AIH_HOME || '').trim() || path.join(os.homedir(), '.ai_home');
}

// CHILD_PROCESS 行是分多行的：`spawnSync [Object: null prototype] {` 之后有 args: [...] / file: '...'。
function readSpawnedCommands(stderr) {
  const commands = new Set();
  const lines = String(stderr || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('CHILD_PROCESS')) continue;
    const fileMatch = /file:\s*'([^']+)'/.exec(lines[index]);
    if (fileMatch) commands.add(path.basename(fileMatch[1]));
    for (let look = index + 1; look < Math.min(index + 30, lines.length); look += 1) {
      const argsLine = /^\s*args:\s*\[\s*'([^']+)'/.exec(lines[look]);
      if (argsLine) { commands.add(path.basename(argsLine[1])); break; }
      if (/^\s*args:\s*\[\s*$/.test(lines[look])) {
        const next = lines[look + 1] || '';
        const first = /'([^']+)'/.exec(next);
        if (first) commands.add(path.basename(first[1]));
        break;
      }
    }
  }
  return [...commands];
}

function runProviderAudit(provider, options) {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'ai-home.js'), provider, 'usage', '--refresh'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      env: { ...process.env, NODE_DEBUG: 'child_process', NO_COLOR: '1' }
    }
  );
  const stdout = String(result.stdout || '');
  const spawned = readSpawnedCommands(String(result.stderr || ''));
  const clientProcesses = spawned.filter((command) => !SYSTEM_PROBES.has(command));
  const lines = stdout.split('\n').map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  const summary = lines.filter((line) => /Account ID|Remaining|snapshot|error|No cached|Summary/i.test(line)).slice(0, 6);
  return {
    provider,
    durationMs: Date.now() - startedAt,
    exitCode: result.status,
    spawnedCommands: spawned,
    clientProcesses,
    clientDependent: clientProcesses.length > 0,
    stdoutSummary: summary
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const aiHomeDir = resolveAiHomeDir();
  const catalogIds = listProviderIds().map((id) => String(id).toLowerCase());
  const providers = (options.providers && options.providers.length > 0 ? options.providers : catalogIds).sort();
  const registry = getProviderRegistry();

  const withAccounts = new Map();
  for (const provider of providers) {
    let records = [];
    try { records = listAccountCredentialRecords(fs, aiHomeDir, provider) || []; } catch (_error) { records = []; }
    if (records.length > 0) withAccounts.set(provider, records);
  }

  console.log(`# 用量审计（只读）  aiHome=${aiHomeDir}`);
  console.log(`# catalog provider=${providers.length}，已登记账号的 provider=${withAccounts.size}`);
  console.log('');

  const rows = [];
  for (const [provider, records] of withAccounts) {
    const quota = describeQuotaProvider(provider);
    const relay = getProviderCapability(provider, 'relay');
    const audit = runProviderAudit(provider, options);
    rows.push({ provider, quota, relay, ...audit });
    const strategyLabel = quota && quota.supported
      ? quota.strategies.map((strategy) => `${strategy.id}(${strategy.transport}${strategy.clientDependent ? ',client' : ''})`).join(' > ')
      : `none: ${quota ? quota.reason : 'no descriptor'}`;
    console.log(`▶ ${provider}  accounts=${records.length}  ${audit.durationMs}ms`);
    console.log(`   quota: ${quota && quota.supported ? 'yes' : 'no'}  strategies: ${strategyLabel}`);
    console.log(`   relay: ${relay ? relay.transport + (relay.clientDependent ? ' (client)' : '') : 'undeclared'}`);
    console.log(`   spawned: [${audit.spawnedCommands.join(' ')}]  clientProcesses: [${audit.clientProcesses.join(' ')}]`);
    for (const line of audit.stdoutSummary) console.log(`   ${line.slice(0, 150)}`);
    console.log('');
  }

  const capable = listQuotaProviders();
  const noQuota = catalogIds.filter((id) => !capable.includes(id));
  const clientQuota = listProviders('quota').filter((id) => {
    const quota = describeQuotaProvider(id);
    return quota && quota.supported && quota.strategies.every((strategy) => strategy.clientDependent);
  });
  const clientRelay = listProviders('relay').filter((id) => getProviderCapability(id, 'relay').clientDependent);

  console.log('## 矩阵');
  console.log(`# 有额度: ${capable.join(',')}`);
  console.log(`# 无额度（各自声明原因）: ${noQuota.join(',')}`);
  console.log(`# 额度策略全部依赖客户端: ${clientQuota.join(',') || '(none)'}`);
  console.log(`# 中继依赖客户端: ${clientRelay.join(',') || '(none)'}`);
  console.log(`# 实测探测期 spawn 了客户端进程: ${rows.filter((row) => row.clientDependent).map((row) => row.provider).join(',') || '(none)'}`);
  if (options.jsonPath) {
    fs.writeFileSync(options.jsonPath, JSON.stringify({ aiHomeDir, generatedAt: new Date().toISOString(), rows }, null, 2));
    console.log(`# 证据写入 ${options.jsonPath}`);
  }
}

main();
