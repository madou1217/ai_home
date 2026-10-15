'use strict';

// **设计模式收口守卫**（Phase 4）——把「不许用 provider 名分支」从口头约定变成会红的测试。
//
// 三条不变量：
//   1. 采集面的策略链是唯一派发路径：描述符声明的 handler id 必须在注册表里真实存在
//      （写错 id / 忘了注册 → handler_unavailable → 这里红）。
//   2. provider 名分支不许**新增**：每个已知文件记录基线，处数只能减少不能增加（随迁移缩小）。
//   3. 新增文件（不在基线里）出现 ≥2 处 provider 名比较即红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listProviders, getProviderCapability } = require('../lib/providers');
const { getModelDiscoveryHandler } = require('../lib/server/model-discovery/handler-registry');
// 注册组合根（幂等）：保证检查的是「运行时真实可用的 handler」。
require('../lib/server/http-utils');

// 基线：引入本守卫时的真实快照（迁移中的文件 → provider 名比较处数）。**只能减，不能增**：
// 新增分支会让这条用例红，从而逼着改动走描述符/注册表；迁移完成后把条目删掉。
// 迁移完成一个文件就把它的条目删掉；新增条目需要 PR 说明理由（默认应当被拒绝）。
const PROVIDER_BRANCH_BASELINE = {
  'lib/account/account-default-pointer.js': 2,
  'lib/account/account-removal.js': 4,
  'lib/account/claude-login-recovery.js': 2,
  'lib/account/cline-native-credential-sync.js': 2,
  'lib/account/codebuddy-credential-sync.js': 4,
  'lib/account/codex-native-credential-sync.js': 2,
  'lib/account/credential-layout.js': 9,
  'lib/account/derived-state.js': 3,
  'lib/account/go-bridge/account-migration.js': 3,
  'lib/account/native-auth-projection.js': 18,
  'lib/account/self-relay-account.js': 2,
  'lib/account/transfer-core.js': 7,
  'lib/cli/commands/backup/router.js': 2,
  'lib/cli/services/usage/grok-quota-probe.js': 2,
  'lib/protocol/native-interactive-prompts.js': 3,
  'lib/runtime/zcode-desktop-bridge-binding.js': 2,
  'lib/server/accounts.js': 4,
  'lib/server/cline-token-refresh.js': 2,
  'lib/server/codex-default-cli-launcher.js': 2,
  'lib/server/control-plane-device-session-start.js': 3,
  'lib/server/go-account-sync.js': 4,
  'lib/server/http-utils-code-assist.js': 5,
  'lib/server/http-utils.js': 4,
  'lib/server/image-generation-model-specs.js': 6,
  'lib/server/kimi-token-refresh.js': 5,
  'lib/server/model-capability-index.js': 2,
  'lib/server/model-discovery/generic-models-probe.js': 9,
  'lib/server/models-dev-metadata.js': 7,
  'lib/server/models.js': 7,
  'lib/server/native-cli-model-discovery.js': 2,
  'lib/server/native-session-chat-command.js': 19,
  'lib/server/native-session-chat-failure.js': 3,
  'lib/server/native-session-chat-launch.js': 4,
  'lib/server/native-session-chat-sessions.js': 8,
  'lib/server/native-session-chat-stream.js': 5,
  'lib/server/native-session-chat.js': 21,
  'lib/server/native-slash-commands.js': 5,
  'lib/server/protocol-fallback-bridge.js': 2,
  'lib/server/provider-hook-event-normalizer.js': 5,
  'lib/server/provider-model-discovery.js': 4,
  'lib/server/request-pool-retry-policy.js': 2,
  'lib/server/retry-hints.js': 2,
  'lib/server/session-lifecycle/legacy-archive-recovery.js': 2,
  'lib/server/upstream-endpoints-transport-general.js': 5,
  'lib/server/upstream-endpoints-utils.js': 2,
  'lib/server/upstream-failure-policy.js': 4,
  'lib/server/v1-router.js': 5,
  'lib/server/web-account-auth-account-config.js': 6,
  'lib/server/web-account-auth-job.js': 2,
  'lib/server/web-account-auth-oauth-tokens.js': 9,
  'lib/server/web-account-auth.js': 6,
  'lib/server/webui-account-live.js': 2,
  'lib/server/webui-account-routes-utils.js': 4,
  'lib/server/webui-chat-routes-native-session.js': 2,
  'lib/server/webui-chat-routes.js': 26,
  'lib/server/webui-project-cache.js': 7,
  'lib/server/zcode-business-error.js': 2,
  'lib/sessions/session-reader.js': 9,
  'lib/usage/model-usage-api-record.js': 3,
  'lib/usage/model-usage-store.js': 8,
};

const PROVIDER_BRANCH_PATTERN = /\b(?:normalizedProvider|provider)\s*[!=]==?\s*['"][a-z0-9_-]+['"]/g;

function countProviderBranches(source) {
  return (source.match(PROVIDER_BRANCH_PATTERN) || []).length;
}

function listSourceFiles(rootDir, baseDir = rootDir) {
  const out = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full, baseDir));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path.relative(baseDir, full));
  }
  return out;
}

test('采集面：描述符声明的 handler 必须都在注册表里（写错 id 不再静默降级）', () => {
  const missing = [];
  for (const provider of listProviders('models')) {
    const capability = getProviderCapability(provider, 'models');
    if (!capability || capability.supported !== true) continue;
    for (const strategy of capability.strategies) {
      if (!strategy.handler) continue;
      if (!getModelDiscoveryHandler(strategy.handler)) missing.push(`${provider}:${strategy.id}→${strategy.handler}`);
    }
  }
  assert.deepEqual(missing, [], `以下模型发现 handler 未注册：${missing.join(', ')}`);
});

test('hooks 档案：描述符声明的 adapter 必须与 Go 合同 sessionSync.adapter 一致（防漂移）', () => {
  const { getProviderSessionSync } = require('../lib/provider-catalog');
  const mismatches = [];
  for (const provider of listProviders('hooks')) {
    const capability = getProviderCapability(provider, 'hooks');
    const sync = getProviderSessionSync(provider);
    const contractAdapter = (sync && sync.adapter) || '';
    if (!contractAdapter) {
      mismatches.push(`${provider}: 描述符声明了 hooks 但合同没有 sessionSync.adapter`);
      continue;
    }
    if (capability.adapter !== contractAdapter) {
      mismatches.push(`${provider}: 描述符 ${capability.adapter} ≠ 合同 ${contractAdapter}`);
    }
  }
  // 反向：合同声明 hook 的 provider 必须有档案，否则目标路径会静默变成 ''。
  const { listProviderDefinitions } = require('../lib/provider-catalog');
  for (const definition of listProviderDefinitions()) {
    const sync = definition.sessionSync || {};
    if (sync.mode !== 'hook' || !sync.adapter) continue;
    const capability = getProviderCapability(definition.id, 'hooks');
    if (!capability || capability.supported !== true) mismatches.push(`${definition.id}: 合同声明 hook 但描述符没有 hooks 档案`);
  }
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('provider 名分支只能减少：已知文件不得超过基线', () => {
  const root = path.join(__dirname, '..');
  const regressions = [];
  for (const [relativePath, baseline] of Object.entries(PROVIDER_BRANCH_BASELINE)) {
    const full = path.join(root, relativePath);
    if (!fs.existsSync(full)) continue;
    const count = countProviderBranches(fs.readFileSync(full, 'utf8'));
    if (count > baseline) regressions.push(`${relativePath}: ${count} > 基线 ${baseline}`);
  }
  assert.deepEqual(regressions, [],
    `provider 名分支增加了（请改用「描述符声明 + 注册表倒排 + 策略链」）：\n${regressions.join('\n')}`);
});

test('新增文件不得引入 ≥2 处 provider 名分支（新代码一律走注册表/策略链）', () => {
  const root = path.join(__dirname, '..');
  const violations = [];
  for (const relativePath of listSourceFiles(path.join(root, 'lib'))) {
    const key = `lib/${relativePath}`.split(path.sep).join('/');
    if (Object.prototype.hasOwnProperty.call(PROVIDER_BRANCH_BASELINE, key)) continue;
    const count = countProviderBranches(fs.readFileSync(path.join(root, key), 'utf8'));
    if (count >= 2) violations.push(`${key}: ${count} 处`);
  }
  assert.deepEqual(violations, [],
    `lib/ 下新增文件出现 provider 名分支：\n${violations.join('\n')}`);
});

test('基线里已迁移完成的文件应当从基线删除（防止白名单长期滞留）', () => {
  const root = path.join(__dirname, '..');
  const stale = [];
  for (const [relativePath, baseline] of Object.entries(PROVIDER_BRANCH_BASELINE)) {
    const full = path.join(root, relativePath);
    if (!fs.existsSync(full)) { stale.push(`${relativePath}: 文件已不存在`); continue; }
    const count = countProviderBranches(fs.readFileSync(full, 'utf8'));
    if (count === 0) stale.push(`${relativePath}: 已无 provider 名分支，请从基线移除`);
  }
  assert.deepEqual(stale, [], stale.join('\n'));
});
