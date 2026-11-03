'use strict';

// OpenCode 命令行布局表（OpenCode CLI Layout Table）。
//
// 背景（2026-10-15 多账号并发事故，排障必读）：
// opencode v2 引入了**后台托管服务**拓扑 —— `opencode run` / TUI 默认连接一个
// channel 固定的后台 service（`latest` / `dev` / `beta` / `next` → 0xC0DE = **49374**，
// 见官方源码 packages/cli/src/services/service-config.ts 的 defaultPort）。端口只由
// channel 决定、与 HOME / XDG 数据根无关，而 aih 的每个账号都有独立数据根 →
// 每个账号的 service 都来抢 49374：第一个账号绑上后，其余账号必吃
// `Managed service port 49374 on 127.0.0.1 is already in use by another process`。
// （事故现场：多账号并发时后启动的 opencode 会话与免费模型 relay 全部启动失败。）
//
// 两个布局事实（都用 `opencode run --help` 探测拿，不按版本号猜）：
//   v2（≥2.0）：`run` 不再有 `--dir`（写它会 `ERROR Unrecognized flag: --dir`），
//               工作目录改为 `root = PWD ?? cwd`（官方 run/run.ts 的 localDirectory，
//               随后 process.chdir(root)）—— 因此 spawn 只设 cwd 不够，宿主进程
//               （server / 终端）残留的 PWD 会把子进程带去错误的目录；
//               `--standalone`（「Run with a private server instead of the
//               background service」）让本次调用改用进程私有 server
//               （`opencode serve --stdio --port 0`，临时端口），并发拓扑冲突从根上消失。
//   v1（≤1.x）：`run` 有 `--dir <dir>`、TUI 在进程内跑（没有后台 service 拓扑），
//               也就没有 `--standalone`（传入会被拒）。目录由显式旗标表达，无 PWD 约定。
//
// 顺带记录（relay 解析器的兼容前提）：v2 `run --format json` 的事件体与 v1 同构 ——
// `{type:'text', sessionID, part:{text}}`（快照语义）、`{type:'step_finish', part:{reason,tokens}}`、
// `{type:'error', error:{message}}`；stdin 提示词在非 TTY 下同样被读取（readStdin 合并）。
//
// 本表是唯一事实来源：目录旗标 / standalone 旗标 / PWD 约定都从表里取，消费点
// （server 免费模型 relay、WebUI 原生会话、CLI 交互式启动策略）不做版本判断。
// 探针扫 `opencode run --help` 输出（实测 76ms），命中后按「路径 + mtime/size」缓存
// （二进制升级自动重探）；表按**新→旧**排列，多行命中时取最新一行。探测不出来
// （未安装 / 超时 / 帮助文本改版）时回落到最新布局（当前现实是 v2），且**不缓存失败**
// —— 一次瞬态失败不该被固化成永久结论。逃生门：`AIH_OPENCODE_GATEWAY` 的 runLayout=v1|v2 强制钉死。

const nodeFs = require('node:fs');
const { readOpencodeContextField } = require('./opencode-context');
const { spawnSync: defaultSpawnSync } = require('node:child_process');

// 布局来源钉选（逃生门）：只认表里存在的 id，非法值静默忽略（回到探测）。

// 表按新→旧排列：探测按数组顺序扫，命中即停（标记当前互斥，顺序只在未来布局
// 标记重叠时决定取谁）。新增一代布局 = 加一行 + 把行放到合适位置，消费点不动。
const LAYOUTS = Object.freeze([
  Object.freeze({
    id: 'v2',
    // `run` 的目录旗标：v2 移除（工作目录 = PWD ?? cwd，见模块头注释）
    directoryFlag: '',
    // 私有 server 旗标：绕开 channel 固定端口（49374）的后台 service 拓扑
    standaloneFlag: '--standalone',
    // 工作目录由 PWD 环境变量参与决定：spawn 只设 cwd 时宿主 PWD 会泄漏
    pwdDirectory: true,
    // 该布局在 `opencode run --help` 输出里必然出现的旗标（探测标记）
    helpMarkers: Object.freeze(['--standalone'])
  }),
  Object.freeze({
    id: 'v1',
    directoryFlag: '--dir',
    standaloneFlag: '',
    pwdDirectory: false,
    helpMarkers: Object.freeze(['--dir'])
  })
]);

const LAYOUT_BY_ID = new Map(LAYOUTS.map((layout) => [layout.id, layout]));
// 探测不出时的回落：最新一行（探测失败最常见于「还没装 / 帮助文本改版」，
// 装好的现实版本是 v2）。
const DEFAULT_LAYOUT = LAYOUTS[0];

const PROBE_ARGS = Object.freeze(['run', '--help']);
const PROBE_TIMEOUT_MS = 5000;

// 探测结果缓存：键 = `路径|mtimeSize`。只放「文件真实存在 + 探测命中」的结果
// （见 resolveOpenCodeRunLayout 的缓存守卫）。
const probeCache = new Map();

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 布局适用的 provider 身份。当前只有 opencode 本体（付费 / 免费模型同栈）。
 * 需要的消费点（如 WebUI 原生会话 lane）用它判断「是否 opencode 子进程」，
 * 与 codebuddy-family-layouts 的 isCodebuddyFamilyProvider 同一模式。
 */
function isOpenCodeRunLayoutProvider(provider) {
  return normalizeString(provider).toLowerCase() === 'opencode';
}

/**
 * 探测用 CLI 路径：优先调用方显式传入（server 侧已解析过），否则按 provider 定位。
 * 懒 require：lib/runtime ↔ lib/cli/services 之间不留顶层环依赖；定位失败返回 ''
 * （`aih opencode` 未安装时的正常形态 —— 回落布局、不影响启动链路自身报错）。
 */
function resolveCliPathForProbe(input) {
  const explicit = normalizeString(input.cliPath);
  if (explicit) return explicit;
  try {
    const { resolveProviderCliPath } = require('../cli/services/ai-cli/ensure-native-cli');
    return normalizeString(resolveProviderCliPath('opencode'));
  } catch (_error) {
    return '';
  }
}

/** 缓存键里的文件指纹；stat 不到（测试替身 / 未安装）返回 '' 并以此禁用缓存。 */
function readCliStatKey(fsImpl, cliPath) {
  try {
    const stat = fsImpl.statSync(cliPath);
    return `${Number(stat.mtimeMs) || 0}:${Number(stat.size) || 0}`;
  } catch (_error) {
    return '';
  }
}

/** 帮助文本 → 布局：按表序扫标记，全部命中即该行。 */
function parseLayoutFromHelp(text) {
  const normalized = typeof text === 'string' ? text : '';
  if (!normalized) return null;
  for (const layout of LAYOUTS) {
    if (layout.helpMarkers.every((marker) => normalized.includes(marker))) return layout;
  }
  return null;
}

function probeRunHelp(input, cliPath) {
  const spawnSyncImpl = typeof input.spawnSync === 'function' ? input.spawnSync : defaultSpawnSync;
  const platform = normalizeString(input.platform) || process.platform;
  let result = null;
  try {
    result = spawnSyncImpl(cliPath, [...PROBE_ARGS], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      // Windows 上 npm 垫片是 .cmd：script 不经 shell spawn 一律 EINVAL
      // （CVE-2024-27980 防护），与 opencode-free-cli-transport 的 spawn 口径一致。
      shell: platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath)
    });
  } catch (_error) {
    result = null;
  }
  if (!result) return null;
  // 帮助输出可能在 stdout（effect/cli 主流）或 stderr（部分 CLI 约定），两边都扫。
  return parseLayoutFromHelp(`${result.stdout || ''}\n${result.stderr || ''}`);
}

/**
 * 解析 opencode 的 `run`/TUI 布局。优先级：env 钉选 → 缓存 → 探测 → 回落最新布局。
 * 返回布局描述符的浅拷贝 + `source`（'env' | 'cache' | 'probe' | 'default'，可观测）。
 */
function resolveOpenCodeRunLayout(input = {}) {
  const env = input.env || process.env || {};
  const forced = normalizeString(readOpencodeContextField(env, 'runLayout')).toLowerCase();
  if (forced && LAYOUT_BY_ID.has(forced)) {
    return { ...LAYOUT_BY_ID.get(forced), source: 'env' };
  }
  const cliPath = resolveCliPathForProbe(input);
  if (!cliPath) return { ...DEFAULT_LAYOUT, source: 'default', cliPath: '' };
  const fsImpl = input.fs || nodeFs;
  const statKey = readCliStatKey(fsImpl, cliPath);
  const cacheKey = `${cliPath}|${statKey}`;
  const cached = input.force ? null : probeCache.get(cacheKey);
  if (cached) return { ...cached, source: 'cache' };
  const layout = probeRunHelp(input, cliPath);
  const resolved = layout
    ? { ...layout, source: 'probe', cliPath }
    : { ...DEFAULT_LAYOUT, source: 'default', cliPath };
  // 只缓存「文件真实存在（有指纹）+ 探测命中」：探测失败缓存会把瞬态失败固化
  // （二进制后来装好也不重探）；无指纹路径缓存会污染测试替身间相互独立的前提。
  if (layout && statKey) probeCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * `run` 子命令的目录旗标参数（v1: `['--dir', dir]`；v2: `[]` —— 目录由 PWD/cwd 表达，
 * 调用方 spawn 时把 cwd 设为工作目录，并按 openCodeRunEnvPatch 对齐 PWD）。
 */
function openCodeRunDirectoryArgs(layout, directory) {
  const dir = normalizeString(directory);
  if (!layout || !layout.directoryFlag || !dir) return [];
  return [layout.directoryFlag, dir];
}

/** 私有 server 旗标参数（v2: `['--standalone']`；v1: `[]`）。 */
function openCodeRunStandaloneArgs(layout) {
  if (!layout || !layout.standaloneFlag) return [];
  return [layout.standaloneFlag];
}

/**
 * opencode 子进程 env 补丁：v2 用 `PWD ?? cwd` 推断工作目录（见模块头注释），而 spawn
 * 只设 cwd、不改 PWD —— 宿主（server / 终端）残留的 PWD 会让子进程跑错目录，
 * PWD 指向已不存在的目录时 opencode 直接启动失败。非 opencode provider、布局无该
 * 约定（v1 用 `--dir`）、或没给 cwd 时返回 null（不动 env）。
 */
function openCodeRunEnvPatch(provider, input = {}) {
  if (!isOpenCodeRunLayoutProvider(provider)) return null;
  const layout = resolveOpenCodeRunLayout(input);
  if (!layout.pwdDirectory) return null;
  const cwd = normalizeString(input.cwd);
  if (!cwd) return null;
  return { PWD: cwd };
}

function hasExplicitServerArg(args) {
  return args.some((arg) => {
    const text = normalizeString(arg);
    return text === '--standalone' || text === '--server' || text.startsWith('--server=');
  });
}

/**
 * 交互式 CLI 启动的参数整形（launch-profile 策略调用）：
 *  - v2 TUI（无子命令，含根级旗标形态）：注入 `--standalone` —— 没有它，多个账号的
 *    TUI 抢同一个 49374 后台 service（见模块头注释）；注入放在 `--` 分隔符之前，
 *    分隔符后的内容（`opencode run -- …` 的 message）绝不会被污染。
 *  - v2 `run` 子命令：插在 `run` 之后、位置参数之前。
 *  - 用户自带 `--standalone` / `--server`（含 `--server=<url>`）时尊重原样。
 *  - 登录流程与其它子命令（auth / models / serve / session / …）不动：只有会进
 *    TUI / run 的形态才需要私有 server。首参不是旗标也不是 `run` 时按「未知子命令 /
 *    目录位置参数」处理，保持原样（v2 根命令的目录位置参数 `opencode <dir>` 也走这条）。
 */
function shapeOpenCodeRuntimeArgs(args, input = {}) {
  const current = Array.isArray(args) ? args.slice() : [];
  if (input.isLogin) return current;
  const layout = resolveOpenCodeRunLayout(input);
  if (!layout.standaloneFlag || hasExplicitServerArg(current)) return current;
  if (current.length === 0) return [layout.standaloneFlag];
  const first = normalizeString(current[0]);
  const isRun = first === 'run';
  const isRootFlags = first.startsWith('-');
  if (!isRun && !isRootFlags) return current;
  const separatorIndex = current.findIndex((arg) => arg === '--');
  const limit = separatorIndex === -1 ? current.length : separatorIndex;
  const insertAt = isRun ? Math.min(1, limit) : limit;
  const next = [...current];
  next.splice(insertAt, 0, layout.standaloneFlag);
  return next;
}

module.exports = {
  LAYOUTS,
  isOpenCodeRunLayoutProvider,
  openCodeRunDirectoryArgs,
  openCodeRunEnvPatch,
  openCodeRunStandaloneArgs,
  resolveOpenCodeRunLayout,
  shapeOpenCodeRuntimeArgs,
  __private: {
    clearProbeCache: () => probeCache.clear(),
    parseLayoutFromHelp,
    PROBE_ARGS
  }
};
