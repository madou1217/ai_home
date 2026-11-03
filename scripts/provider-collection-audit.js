#!/usr/bin/env node
'use strict';

// **采集面审计**：把「每个 provider × 每个采集面（额度 / 模型发现）」的通道与依赖讲清楚。
//
// 为什么需要它（2026-10-15 kiro 事故的教训）：kiro 的额度与模型当时只有「跑本地 CLI」一条路，
// 用户没装 CLI 就同时报 `native_cli_model_discovery_cli_not_found` 与 `kiro_identity_access_denied`，
// 而这两个错看起来都不像「缺客户端」。事后只能靠人肉逐个 provider 翻代码。
//
// 现在把「有没有不依赖本机客户端的通道」变成**可审计、可守卫的声明**：
//   * 有 API 通道 → 策略链里必须有 clientDependent=false 的那条（且排在最前）；
//   * 真的没有   → 必须显式声明 `clientFree: false` + `reason`（不许沉默）。
//
// 用法：
//   node scripts/provider-collection-audit.js            # 人读表格
//   node scripts/provider-collection-audit.js --json     # 机器读（CI / 守卫用）
//   node scripts/provider-collection-audit.js --gaps     # 只列出「没有 API 通道」的 provider

const {
  getProviderCapability,
  listProviderDescriptorLoadErrors,
  listProviders
} = require('../lib/providers');
const { PROVIDER_IDS } = require('../lib/provider-catalog');

const FACES = Object.freeze(['quota', 'models']);

function describeFace(provider, face) {
  const capability = getProviderCapability(provider, face);
  if (!capability) return { declared: false, supported: false, reason: '', apiStrategies: [], cliStrategies: [] };
  if (capability.supported !== true) {
    return {
      declared: true,
      supported: false,
      reason: String(capability.reason || ''),
      clientFree: false,
      apiStrategies: [],
      cliStrategies: []
    };
  }
  const strategies = Array.isArray(capability.strategies) ? capability.strategies : [];
  const apiStrategies = strategies.filter((strategy) => strategy.clientDependent !== true).map((strategy) => strategy.id);
  const cliStrategies = strategies.filter((strategy) => strategy.clientDependent === true).map((strategy) => strategy.id);
  return {
    declared: true,
    supported: true,
    // 契约把「为什么没有不依赖客户端的通道」放在能力级（clientFreeReason），
    // 这里必须读它 —— 否则 CLI-only 的面明明写了原因也显示不出来，报告不可信。
    reason: String(capability.clientFreeReason || ''),
    source: String(capability.source || ''),
    clientFree: apiStrategies.length > 0,
    apiStrategies,
    cliStrategies,
    orderedFirstIsApi: strategies.length > 0 && strategies[0].clientDependent !== true
  };
}

function auditProvider(provider) {
  const faces = {};
  for (const face of FACES) faces[face] = describeFace(provider, face);
  const gaps = FACES.filter((face) => faces[face].declared && faces[face].supported && faces[face].clientFree === false);
  return { provider, faces, gaps };
}

function collectAudit() {
  const providers = PROVIDER_IDS.length > 0 ? PROVIDER_IDS : listProviders('quota');
  const rows = providers.map(auditProvider);
  return {
    descriptorLoadErrors: listProviderDescriptorLoadErrors(),
    rows,
    // 「只有 CLI 一条路」的面：这些必须带显式原因（说明为什么无法纯 API），否则就是 kiro 同类隐患。
    cliOnlyFaces: rows.flatMap((row) => row.gaps.map((face) => ({
      provider: row.provider,
      face,
      reason: row.faces[face].reason,
      strategies: row.faces[face].cliStrategies
    })))
  };
}

function formatCell(face) {
  if (!face.declared) return '未声明';
  if (!face.supported) return `no(${face.reason.slice(0, 18)})`;
  const api = face.apiStrategies.length > 0 ? `API×${face.apiStrategies.length}` : 'API×0';
  const cli = face.cliStrategies.length > 0 ? ` CLI×${face.cliStrategies.length}` : '';
  return `${api}${cli}`;
}

function formatLines(audit) {
  const lines = [];
  lines.push('provider      quota                models');
  for (const row of audit.rows) {
    lines.push(`${row.provider.padEnd(13)} ${formatCell(row.faces.quota).padEnd(20)} ${formatCell(row.faces.models)}`);
  }
  lines.push('');
  lines.push(`只有 CLI 通道的采集面：${audit.cliOnlyFaces.length}`);
  for (const gap of audit.cliOnlyFaces) {
    const why = String(gap.reason || '').trim();
    lines.push(`  ${gap.provider}.${gap.face} → ${gap.strategies.join(', ')}${why ? `
      原因：${why}` : '  ⚠️ 未声明原因'}`);
  }
  if (audit.descriptorLoadErrors.length > 0) {
    lines.push(`描述符加载错误 ${audit.descriptorLoadErrors.length}：`);
    for (const error of audit.descriptorLoadErrors) {
      lines.push(`  ${error.code}: ${error.detail} (${error.target || ''})`);
    }
  }
  return lines;
}

function main() {
  const audit = collectAudit();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    return;
  }
  if (process.argv.includes('--gaps')) {
    for (const gap of audit.cliOnlyFaces) {
      process.stdout.write(`${gap.provider}\t${gap.face}\t${gap.strategies.join(',')}\n`);
    }
    return;
  }
  for (const line of formatLines(audit)) process.stdout.write(`${line}\n`);
}

if (require.main === module) main();

module.exports = { FACES, auditProvider, collectAudit, formatLines };
