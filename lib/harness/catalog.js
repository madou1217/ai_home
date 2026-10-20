'use strict';

// 外部 harness 注册表：它们不是 AIH Gateway provider（没有上游协议、没有账号池），
// 但可以由 aih 启动并通过本地网关使用任意 Provider 的账号。
//
// 新增一个 harness 只需要在这里加一条描述符（+ 必要时一个 projection 模块），
// account-app-launcher / WebUI / CLI 的派发都不需要出现 provider 名字分支。
const EXTERNAL_HARNESSES = Object.freeze([
  Object.freeze({
    id: 'pi',
    label: 'Pi',
    managedAppId: 'pi',
    binaryName: 'pi',
    // 投影适配器 id（lib/harness/adapters.js 注册表）；派发层只按这个 id 取，
    // 不出现 harness 名字比较。
    adapter: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
    // tui = 直接在当前终端内运行的交互界面；web = 启动本地 Web UI 的 profile。
    interactiveKind: 'tui',
    supportsCrossProvider: true,
    supportsAccountPin: true,
    supportsModelSelection: true,
    description: '轻量终端 Agent harness，支持自定义 OpenAI 兼容 provider'
  }),
  Object.freeze({
    id: 'dsh',
    label: 'DeepSeek Harness',
    managedAppId: 'dsh',
    binaryName: 'dsh',
    adapter: 'dsh',
    packageName: '@deepseek-ai/dsh',
    // DSH 0.2.x 已移除 TUI 包，交互入口是 web profile；这里如实标注，
    // 不把 web profile 伪装成终端 TUI。
    interactiveKind: 'web',
    supportsCrossProvider: true,
    supportsAccountPin: true,
    supportsModelSelection: true,
    description: 'DeepSeek 官方开源 Agent Harness（web profile，无 TUI）'
  })
]);

const EXTERNAL_HARNESS_BY_ID = Object.freeze(Object.fromEntries(
  EXTERNAL_HARNESSES.map((harness) => [harness.id, harness])
));

function normalizeHarnessId(value) {
  return String(value || '').trim().toLowerCase();
}

function getExternalHarness(id) {
  return EXTERNAL_HARNESS_BY_ID[normalizeHarnessId(id)] || null;
}

function isExternalHarness(id) {
  return Boolean(getExternalHarness(id));
}

function listExternalHarnesses() {
  return EXTERNAL_HARNESSES;
}

module.exports = {
  EXTERNAL_HARNESSES,
  getExternalHarness,
  isExternalHarness,
  listExternalHarnesses,
  normalizeHarnessId
};
