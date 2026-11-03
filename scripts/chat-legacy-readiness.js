#!/usr/bin/env node
'use strict';

// Chat legacy 引擎退役就绪度检查（只读，无网络）。
//
// 目的：把「canonical 是否已经能完全替代 legacy」变成一条可打印、可守卫的事实，
// 防止在替换未完成时删掉 legacy surface（删了就有 provider 直接没有界面）。
//
// 判定口径（与运行时一致）：
//   1. 表面路由：web/src/features/chat-runtime/runtime-provider-registry.ts 注册了哪些 provider
//      （未注册 → work 模式落 legacy）。
//   2. 服务端驱动：lib/server/chat-runtime-composition.js 注册了哪些 provider 的 driver
//      （未注册 → canonical 里根本跑不起来）。
//   3. legacy 的服务面：生成合同里声明 session_runtime 能力的 provider（即 legacy 现在能服务的集合）。
//
// 退出码：0 = canonical 已覆盖全部 provider（legacy 可删）；1 = 仍必需（列出缺口）。

const fs = require('node:fs');
const path = require('node:path');
const { listProvidersByCapability } = require('../lib/provider-catalog');
const { OFFICIAL_NATIVE_SESSION_PROVIDERS } = require('../lib/server/native-session-chat-utils');
const {
  findApprovalTransport,
  resolveNativeApprovalTransport
} = require('../lib/server/chat-runtime/native-approval-transports');

const ROOT = path.join(__dirname, '..');
const WEB_REGISTRY = path.join(ROOT, 'web', 'src', 'features', 'chat-runtime', 'runtime-provider-registry.ts');
const WEB_PROVIDER_LIST = path.join(ROOT, 'web', 'src', 'features', 'chat-runtime', 'native-runtime-providers.ts');
const COMPOSITION = path.join(ROOT, 'lib', 'server', 'chat-runtime-composition.js');

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return '';
  }
}

/** web 表面：runtime-provider-registry 由 native-runtime-providers 的名单派生（或旧式逐个注册）。 */
function webRegisteredProviders() {
  const source = read(WEB_REGISTRY);
  const inline = [...source.matchAll(/nativeCredentialProvider\('([a-z0-9-]+)'\)/g)].map((match) => match[1]);
  const derived = /NATIVE_RUNTIME_PROVIDERS\.map\(/.test(source)
    ? arrayLiteral(read(WEB_PROVIDER_LIST), 'NATIVE_RUNTIME_PROVIDERS')
    : [];
  return [...new Set([...inline, ...derived])].sort();
}

/**
 * web 表面对 API-key 账号的口径：legacy 只在「原生 CLI 能用密钥跑真会话」的 provider 上让 API-key
 * 账号走原生（chat-runner-profile.apiKeyNativeReady），其余 API-key 账号走无状态代理而非原生会话。
 * 因此 canonical 必须至少覆盖这批 provider 的 API-key 账号，而不是「全部接受」。
 */
function webAcceptsApiKeyAccounts() {
  const source = read(WEB_REGISTRY);
  if (!/!\s*account\.apiKeyMode/.test(source)) return true;
  if (!/API_KEY_NATIVE_READY_PROVIDERS/.test(source)) return false;
  const web = new Set(setLiteral(read(WEB_PROVIDER_LIST), 'API_KEY_NATIVE_READY_PROVIDERS'));
  const { isApiKeyNativeReady } = require('../lib/server/chat-runner-profile');
  const legacyReady = ['codex', 'claude', 'gemini', 'agy', 'opencode', 'grok', 'zcode', 'qoder', 'qodercn',
    'cline', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'].filter((provider) => isApiKeyNativeReady(provider));
  return legacyReady.every((provider) => web.has(provider));
}

function arrayLiteral(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]`));
  return match ? [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((entry) => entry[1]) : [];
}

function setLiteral(source, name) {
  const match = source.match(new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]`));
  return match ? [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((entry) => entry[1]) : [];
}

/** 服务端驱动：composition 里注册了哪些 provider 的 driver（含引擎派生注册）。 */
function serverDriverProviders(engineProviders) {
  const source = read(COMPOSITION);
  const inline = [...source.matchAll(/provider:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]);
  // 引擎派生注册：名单来自 OFFICIAL_NATIVE_SESSION_PROVIDERS，不写死 provider 清单。
  const engineDerived = /OFFICIAL_NATIVE_SESSION_PROVIDERS/.test(source)
    && /nativeSessionProviderRegistrations/.test(source)
    ? engineProviders
    : [];
  const injectable = /options\.providerDriverRegistrations/.test(source);
  return {
    providers: [...new Set([...inline, ...engineDerived])].sort(),
    injectable,
    engineDerived: engineDerived.length > 0,
  };
}

function main() {
  // legacy 的真实服务面 = 原生会话引擎支持的 provider（引擎名单，不是合同声明）。
  const legacyProviders = [...OFFICIAL_NATIVE_SESSION_PROVIDERS].slice().sort();
  const declaredProviders = listProvidersByCapability('sessionRuntime').slice().sort();
  const undeclared = legacyProviders.filter((provider) => !declaredProviders.includes(provider));
  const webProviders = webRegisteredProviders();
  const server = serverDriverProviders(legacyProviders);
  const acceptsApiKey = webAcceptsApiKeyAccounts();

  const missingWeb = legacyProviders.filter((provider) => !webProviders.includes(provider));
  const missingServer = legacyProviders.filter((provider) => !server.providers.includes(provider));

  console.log('[aih] chat legacy 退役就绪度');
  console.log(`  legacy 服务面（原生会话引擎）: ${legacyProviders.join(', ') || '(空)'}`);
  console.log(`  合同声明 session_runtime: ${declaredProviders.join(', ') || '(空)'}${undeclared.length > 0 ? `（引擎多服务: ${undeclared.join(', ')} → 合同与引擎不同源）` : ''}`);
  console.log(`  canonical 表面注册（web）: ${webProviders.join(', ') || '(空)'}`);
  console.log(`  canonical 服务端驱动: ${server.providers.join(', ') || '(空)'}${server.injectable ? '（支持外部注册）' : ''}`);
  console.log(`  work 模式允许 API-key 账号: ${acceptsApiKey ? '是' : '否（legacy 允许 → 覆盖缺口）'}`);
  console.log(`  表面未覆盖: ${missingWeb.join(', ') || '(无)'}`);
  console.log(`  驱动未覆盖: ${missingServer.join(', ') || '(无)'}`);

  // 审批传输（策略表）：注册了原生驱动就必须有审批声明，否则 confirm/plan 只能 fail closed。
  const approvalRows = legacyProviders
    .filter((provider) => provider !== 'codex')
    .map((provider) => {
      const row = findApprovalTransport({ provider, approvalMode: 'confirm' });
      const resolution = resolveNativeApprovalTransport({ provider, approvalMode: 'confirm' });
      return { provider, row, resolution };
    });
  const approvalNative = approvalRows.filter((entry) => entry.resolution.support === 'native');
  const approvalUndeclared = approvalRows.filter((entry) => !entry.row);
  const approvalBlocked = approvalRows.filter((entry) => entry.row && entry.resolution.support !== 'native');
  console.log(`  审批传输（confirm/plan）: ${approvalNative.map((entry) => `${entry.provider}=${entry.row.channel}`).join(', ') || '(无)'}`);
  if (approvalUndeclared.length > 0) {
    console.log(`    未声明（confirm/plan 直接拒绝）: ${approvalUndeclared.map((entry) => entry.provider).join(', ')}`);
  }
  if (approvalBlocked.length > 0) {
    console.log(`    已声明未接线: ${approvalBlocked.map((entry) => `${entry.provider}(${entry.resolution.reason})`).join(', ')}`);
  }

  const gaps = [];
  if (missingWeb.length > 0) gaps.push(`web 表面未注册 ${missingWeb.length} 个 provider`);
  if (missingServer.length > 0) gaps.push(`服务端缺少 ${missingServer.length} 个 provider 的 canonical driver`);
  if (!acceptsApiKey) gaps.push('web 表面不接受 API-key 账号（legacy 接受）');
  if (approvalUndeclared.length > 0) {
    gaps.push(`审批传输未声明 ${approvalUndeclared.length} 个 provider（confirm/plan 不可用）`);
  }

  if (gaps.length > 0) {
    console.log(`\n[aih] 结论: legacy 仍必需，不可删 —— ${gaps.join('；')}`);
    console.log('  就绪度清单见 docs/plans/2026-10-15-chat-legacy-retirement-readiness.md');
    process.exitCode = 1;
    return;
  }
  console.log('\n[aih] 结论: canonical 已覆盖全部 session_runtime provider，legacy surface 可以删除。');
}

main();
