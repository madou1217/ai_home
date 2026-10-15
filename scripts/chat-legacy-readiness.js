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

const ROOT = path.join(__dirname, '..');
const WEB_REGISTRY = path.join(ROOT, 'web', 'src', 'features', 'chat-runtime', 'runtime-provider-registry.ts');
const COMPOSITION = path.join(ROOT, 'lib', 'server', 'chat-runtime-composition.js');

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return '';
  }
}

/** web 表面：nativeCredentialProvider('codex') 这类注册。 */
function webRegisteredProviders() {
  const source = read(WEB_REGISTRY);
  return [...new Set([...source.matchAll(/nativeCredentialProvider\('([a-z0-9-]+)'\)/g)].map((match) => match[1]))].sort();
}

/** web 表面是否排除了 api-key 账号（legacy 允许 API-key 账号跑 work 会话）。 */
function webAcceptsApiKeyAccounts() {
  const source = read(WEB_REGISTRY);
  return !/!\s*account\.apiKeyMode/.test(source);
}

/** 服务端驱动：composition 里 createProviderDriverRegistration({ provider: '<x>' }) 的注册。 */
function serverDriverProviders() {
  const source = read(COMPOSITION);
  const inline = [...source.matchAll(/provider:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]);
  // 外部注册入口存在与否，决定「新增 provider 是否需要改 composition」。
  const injectable = /options\.providerDriverRegistrations/.test(source);
  return { providers: [...new Set(inline)].sort(), injectable };
}

function main() {
  // legacy 的真实服务面 = 原生会话引擎支持的 provider（引擎名单，不是合同声明）。
  const legacyProviders = [...OFFICIAL_NATIVE_SESSION_PROVIDERS].slice().sort();
  const declaredProviders = listProvidersByCapability('sessionRuntime').slice().sort();
  const undeclared = legacyProviders.filter((provider) => !declaredProviders.includes(provider));
  const webProviders = webRegisteredProviders();
  const server = serverDriverProviders();
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

  const gaps = [];
  if (missingWeb.length > 0) gaps.push(`web 表面未注册 ${missingWeb.length} 个 provider`);
  if (missingServer.length > 0) gaps.push(`服务端缺少 ${missingServer.length} 个 provider 的 canonical driver`);
  if (!acceptsApiKey) gaps.push('web 表面不接受 API-key 账号（legacy 接受）');

  if (gaps.length > 0) {
    console.log(`\n[aih] 结论: legacy 仍必需，不可删 —— ${gaps.join('；')}`);
    console.log('  就绪度清单见 docs/plans/2026-10-15-chat-legacy-retirement-readiness.md');
    process.exitCode = 1;
    return;
  }
  console.log('\n[aih] 结论: canonical 已覆盖全部 session_runtime provider，legacy surface 可以删除。');
}

main();
