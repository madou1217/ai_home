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
    pluginHostId: 'pi',
    nativeResources: {
      plugin: { state: 'supported', mode: 'native', adapter: 'native-directory', pathBase: 'host-home', paths: ['.pi/agent/extensions'], launchArgument: '--extension' }
    },
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
    pluginHostId: 'deepseek',
    nativeResources: {
      plugin: { state: 'supported', mode: 'native', adapter: 'cordis-patch', pathBase: 'host-home', paths: ['.dsh/plugins'], entryExport: './deepseek', launchArgument: '--patch', launchFromInstall: true }
    },
    // 事实核对（2026-10-21 对照 GitHub 源码，tag dsh-v0.2.1-rc.2）：
    // - packages/bundle/ 只有 acp-app / base / headless / sdk-app / sdk-minimal / web-app，
    //   没有 tui-app；全仓 tree（18758 项，truncated=false）里非 .agents/ 的 tui 路径为 0。
    // - packages/boot/app-boot/src/profile.ts 的 PROFILE_TEMPLATES 只有
    //   acp / web / headless / sdk / sdk-minimal，没有 tui。
    // - 官方在 10bb9cbf4a22（2026-08-04，"cleanup: remove TUI package and legacy dsh
    //   entrypoints"）删除了 packages/ui/tui，相关笔记归档进 .agents/notes/archived/。
    // - docs/cli-help.md 里的 `dsh tui …` 是「安装过 tui profile」的示例口径，
    //   apps/cli/README.md 亦注明该行 "assuming the tui profile is installed"。
    // 因此官方交互入口只有 web profile；终端 TUI 属树外插件（例如
    // @deepseek-harness-tui/dsh-tui，peer 支持 0.2.1-rc.2），不随官方包分发，
    // 这里不把 web profile 伪装成终端 TUI。
    interactiveKind: 'web',
    supportsCrossProvider: true,
    supportsAccountPin: true,
    supportsModelSelection: true,
    description: 'DeepSeek 官方开源 Agent Harness（web profile；终端 TUI 为树外 profile，与 web 共享同一安装与升级）'
  }),
  Object.freeze({
    id: 'dsh-tui',
    label: 'DeepSeek Harness TUI',
    // 复用 DSH 的安装与升级生命周期：dsh-tui 不是独立二进制，它是装进
    // DSH profile 的 bundle，靠 `dsh --profile dsh-tui` 启动。
    managedAppId: 'dsh',
    binaryName: 'dsh',
    adapter: 'dsh-tui',
    packageName: '@deepseek-harness-tui/dsh-tui',
    // 事实核对（2026-10-21，dsh-tui 0.16.1 源码 + 真机）：
    // - 它是 DSH 的树外 profile 包：package.json 声明 dsh.bundle.patch，profile 的
    //   dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']，
    //   因此 aih 走 `dsh --profile dsh-tui`，不经过它自己的瘦壳启动器。
    // - 隔离可行：DATA_DIR = join(homedir(), '.dsh-tui')，HOME 投影即整体重定向；
    //   onboarding 可 Esc 跳过且可预写 completed；DSH_HOME 是官方凭据/会话根。
    // - 真机端到端：HOME/DSH_HOME 双投影下经网关出话（turn 1，4580 in / 168 out tokens），
    //   网关侧命中钉选账号的 POST /v1/chat/completions 200。
    interactiveKind: 'tui',
    supportsCrossProvider: true,
    supportsAccountPin: true,
    supportsModelSelection: true,
    description: 'DeepSeek Harness 的终端 TUI（树外 profile，经 DSH 启动）'
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
