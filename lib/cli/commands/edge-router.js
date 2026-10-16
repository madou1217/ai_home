'use strict';

const nodeFs = require('node:fs');
const { EdgeProxyService } = require('../services/toolkit/edge-proxy/edge-proxy-service');
const frpProvider = require('../services/toolkit/edge-proxy/providers/frp');

/**
 * `aih edge`：本机入口转发（nginx / caddy / frp）的命令行入口。
 * 与 WebUI「应用与集成 → 入口与转发」共用同一个 EdgeProxyService，
 * 语义都是**先校验后落地**：frp 先 `frpc verify`、nginx 写片段后 `nginx -t`、caddy `caddy validate`，
 * 任何一步不过就整体回滚（有备份还原、没备份删除），绝不留坏配置。
 */

const EDGE_HELP = `用法：
  aih edge status
  aih edge plan  <frp|nginx|caddy> [...选项]
  aih edge apply <frp|nginx|caddy> [...选项] [--dry-run] [--no-reload]
  aih edge remove frp --name <名字>
选项：
  --remote-port <n>   frp 远端端口（必填）
  --local-port <n>    frp 本机端口（默认 AIH 端口 9527）
  --name <名字>       frp 条目名（默认 aih-server）
  --no-udp            不添加 UDP 条目（默认同时加，QUIC 走它）
  --domain <域名>     nginx / caddy 必填
  --mode <形态>       nginx：split（默认）/ passthrough / http-only
  --cert-dir <目录>   证书目录（nginx 用；Caddy 不需要）`;

function parseEdgeArgs(argv = []) {
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--remote-port') options.remotePort = Number(next());
    else if (arg === '--local-port') options.localPort = Number(next());
    else if (arg === '--name') options.name = next();
    else if (arg === '--domain') options.domain = next();
    else if (arg === '--mode') options.mode = next();
    else if (arg === '--cert-dir') options.certDir = next();
    else if (arg === '--no-udp') options.udp = false;
    else if (arg === '--udp') options.udp = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-reload') options.reload = false;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else options.positional.push(arg);
  }
  return options;
}

function printEdgePlan(plan, log = console.log) {
  log(`\n${plan.summary}`);
  (plan.notes || []).forEach((note) => log(`  · ${note}`));
  if (plan.entries) {
    log(plan.entries.map((entry) => `  ${entry.type} 127.0.0.1:${entry.localPort} -> 远端 ${entry.remotePort}`).join('\n'));
  }
  (plan.files || []).forEach((file) => {
    log(`\n--- ${file.path} ---\n${file.content}`);
  });
}

function resolveService(deps = {}) {
  if (deps.service) return deps.service;
  const Service = deps.EdgeProxyService || EdgeProxyService;
  return new Service();
}

function removeManagedFrpEntries(service, args, { log, error, fs }) {
  const configPath = frpProvider.resolveConfigPath({ fs, env: process.env });
  if (!configPath) {
    error('找不到 frpc 配置；用 AIH_EDGE_FRPC_CONFIG 指定');
    return 1;
  }
  const name = args.name || 'aih-server';
  const before = fs.readFileSync(configPath, 'utf8');
  let next = frpProvider.removeProxy(before, name);
  next = frpProvider.removeProxy(next, `${name}-udp`);
  if (next === before) {
    log(`没有找到受管条目 ${name}`);
    return 0;
  }
  const backupPath = service.writeAtomic(configPath, next, { backup: true });
  log(JSON.stringify({ ok: true, configPath, backupPath, removed: [name, `${name}-udp`] }, null, 1));
  const reloaded = service.reloadFrp();
  if (reloaded.reloaded !== true && reloaded.hint) log(`提示：${reloaded.hint}`);
  return 0;
}

/** 返回进程退出码；deps 可注入 service / consoleImpl / fs（测试用）。 */
function runEdgeCommand(argv = [], deps = {}) {
  const consoleImpl = deps.consoleImpl || console;
  const log = (line = '') => consoleImpl.log(line);
  const error = (line = '') => consoleImpl.error(line);
  const fs = deps.fs || nodeFs;
  const args = parseEdgeArgs(argv);
  const [action, kind] = args.positional;

  if (args.help || !action) {
    log(EDGE_HELP);
    return args.help ? 0 : 1;
  }

  const service = resolveService(deps);

  if (action === 'status') {
    log(JSON.stringify(service.status(), null, 1));
    return 0;
  }

  if (action === 'plan') {
    printEdgePlan(service.plan(kind, args), log);
    return 0;
  }

  if (action === 'apply') {
    if (args.dryRun) {
      printEdgePlan(service.plan(kind, args), log);
      log('\n（dry-run：没有写入任何文件）');
      return 0;
    }
    const result = service.apply(kind, args);
    log(JSON.stringify(result, null, 1));
    if (result.ok !== true) {
      error(`失败：${result.error}${result.detail ? `\n${result.detail}` : ''}`);
      return 1;
    }
    if (result.reloaded !== true && result.hint) log(`提示：${result.hint}`);
    return 0;
  }

  if (action === 'remove' && kind === 'frp') {
    return removeManagedFrpEntries(service, args, { log, error, fs });
  }

  error(EDGE_HELP);
  return 1;
}

module.exports = {
  EDGE_HELP,
  parseEdgeArgs,
  printEdgePlan,
  runEdgeCommand
};
