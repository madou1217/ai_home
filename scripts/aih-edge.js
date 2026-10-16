#!/usr/bin/env node
'use strict';

/**
 * 本机边缘转发管理的一次性入口（nginx / caddy / frp）。
 *
 * 用法：
 *   node scripts/aih-edge.js status
 *   node scripts/aih-edge.js plan  frp --remote-port 29527 [--udp|--no-udp]
 *   node scripts/aih-edge.js plan  nginx --domain aih.example.com [--mode split|passthrough|http-only] [--cert-dir DIR]
 *   node scripts/aih-edge.js apply frp --remote-port 29527 [--dry-run] [--no-reload]
 *   node scripts/aih-edge.js apply nginx --domain aih.example.com --mode split --cert-dir /etc/letsencrypt/live/aih.example.com
 *   node scripts/aih-edge.js apply caddy --domain aih.example.com
 *   node scripts/aih-edge.js remove frp --name aih-server        （删受管条目；nginx/caddy 用 --domain）
 *
 * 语义：apply 一律「先校验后落地」——frp 先写临时文件并 `frpc verify`，nginx 写片段后 `nginx -t`，
 * caddy `caddy validate`；任何一步不过就整体回滚（有备份还原、没备份删除），绝不留坏配置。
 */

const { EdgeProxyService } = require('../lib/cli/services/toolkit/edge-proxy/edge-proxy-service');
const frpProvider = require('../lib/cli/services/toolkit/edge-proxy/providers/frp');

const HELP = `用法：
  aih-edge status
  aih-edge plan  <frp|nginx|caddy> [...选项]
  aih-edge apply <frp|nginx|caddy> [...选项] [--dry-run] [--no-reload]
  aih-edge remove frp --name <名字>
选项：
  --remote-port <n>   frp 远端端口（必填）
  --local-port <n>    frp 本机端口（默认 AIH 端口 9527）
  --name <名字>       frp 条目名（默认 aih-server）
  --no-udp            不添加 UDP 条目（默认同时加，QUIC 走它）
  --domain <域名>     nginx / caddy 必填
  --mode <形态>       nginx：split（默认）/ passthrough / http-only
  --cert-dir <目录>   证书目录（nginx 用；Caddy 不需要）`;

function parseArgs(argv) {
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

function printPlan(plan) {
  console.log(`\n${plan.summary}`);
  (plan.notes || []).forEach((note) => console.log(`  · ${note}`));
  if (plan.entries) {
    console.log(plan.entries.map((entry) => `  ${entry.type} 127.0.0.1:${entry.localPort} -> 远端 ${entry.remotePort}`).join('\n'));
  }
  (plan.files || []).forEach((file) => {
    console.log(`\n--- ${file.path} ---\n${file.content}`);
  });
}

function main() {
  const service = new EdgeProxyService();
  const args = parseArgs(process.argv.slice(2));
  const [action, kind] = args.positional;
  if (args.help || !action) {
    console.log(HELP);
    return 0;
  }

  if (action === 'status') {
    const status = service.status();
    console.log(JSON.stringify(status, null, 1));
    return 0;
  }

  if (action === 'plan') {
    printPlan(service.plan(kind, args));
    return 0;
  }

  if (action === 'apply') {
    if (args.dryRun) {
      printPlan(service.plan(kind, args));
      console.log('\n（dry-run：没有写入任何文件）');
      return 0;
    }
    const result = service.apply(kind, args);
    console.log(JSON.stringify(result, null, 1));
    if (result.ok !== true) {
      console.error(`失败：${result.error}${result.detail ? `\n${result.detail}` : ''}`);
      return 1;
    }
    if (result.reloaded !== true && result.hint) console.log(`提示：${result.hint}`);
    return 0;
  }

  if (action === 'remove' && kind === 'frp') {
    const configPath = frpProvider.resolveConfigPath({ fs: require('node:fs'), env: process.env });
    const fs = require('node:fs');
    if (!configPath) {
      console.error('找不到 frpc 配置；用 AIH_EDGE_FRPC_CONFIG 指定');
      return 1;
    }
    const name = args.name || 'aih-server';
    const before = fs.readFileSync(configPath, 'utf8');
    let next = frpProvider.removeProxy(before, name);
    next = frpProvider.removeProxy(next, `${name}-udp`);
    if (next === before) {
      console.log(`没有找到受管条目 ${name}`);
      return 0;
    }
    const backupPath = service.writeAtomic(configPath, next, { backup: true });
    console.log(JSON.stringify({ ok: true, configPath, backupPath, removed: [name, `${name}-udp`] }, null, 1));
    const reloaded = service.reloadFrp();
    if (reloaded.reloaded !== true && reloaded.hint) console.log(`提示：${reloaded.hint}`);
    return 0;
  }

  console.error(HELP);
  return 1;
}

process.exit(main());
