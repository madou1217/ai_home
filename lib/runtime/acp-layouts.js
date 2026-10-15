'use strict';

// ACP（Agent Client Protocol）公共布局表（ACP Layout Table）。
//
// 为什么要有这一层（2026-10-16 提前布局）：
// ACP 正在成为各家编码 CLI 的**统一 agent 入口协议**——客户端经 stdio NDJSON
// （`@agentclientprotocol/sdk` 的 ndJsonStream）与 agent 进程对话，事件、工具审批、
// 会话续接都有协议形状，是继「PTY/TUI」与「headless 一次性 run/-p」之后的第三条
// 会话通道。本表把「每个 provider 怎么进入 ACP 模式」做成数据描述符：入口形态
// （子命令 / 根旗标 / 外部适配器二进制）、传输、是否自带服务拓扑、证据与验证日期。
// 新增一个 ACP provider = 加一行；消费方（未来的 WebUI ACP 会话 / aih <provider> acp /
// harness）只问注册表，不认识 provider 名。
//
// 证据纪律（与 opencode-run-layouts 的「实测而不是猜」同一条）：
//   - `verified: true` 只给**本机实机验证过入口**的行（--help / 源码）；
//   - 家族共享内核的推断行标 `verified: false` 并把依据写进 evidence；
//   - 外部适配器行（claude / codex）给出 npm 包名（2026-10-16 registry 查证），
//     但二进制是否安装由运行期解析，未安装即 fail closed；
//   - **未登记 = 没有证据，不是「不支持」**：grok 的 streaming-json 只是借用了 ACP
//     事件形状、没有 ACP 服务入口；agy / qoder / qodercn / zcode / kiro 尚无可用证据
//     —— 补齐一行前先拿实机证据，绝不猜测入口旗标。
//
// 与 provider 描述符契约的关系（2026-10-16 已完成两步登记）：本模块是**入口数据的
// 唯一源**；provider 描述符只做能力登记（`acp: { supported: true }`，见
// lib/providers/defs/*），Go 合同同源声明 `acp_session`（core/providers/builtins.go）。
// 消费方可以问门面倒排（lib/providers 的 `listProviders('acp')`）发现支持 ACP 的
// provider，入口参数仍由本模块组装；三份集合的同源不变量由
// test/design-pattern-guard.test.js 守卫。
//
// 传输词汇表：
//   stdio-ndjson —— ACP 标准形态（进程 stdin/stdout 上的 NDJSON 帧）。
//   http-sse     —— ACP over HTTP SSE 变体（codebuddy 的 `--serve`；仅记录，
//                   没有该变体的 provider 不声明这一行）。

const ACP_TRANSPORTS = Object.freeze(['stdio-ndjson', 'http-sse']);
const ACP_ENTRY_KINDS = Object.freeze(['subcommand', 'root-flag', 'external-binary']);
// ACP 标准传输即默认：消费者不传 transport 时用它。
const DEFAULT_ACP_TRANSPORT = 'stdio-ndjson';

// 布局表：一行一个 provider。字段：
//   provider         —— provider id（与 lib/providers/defs 的 id 同域）
//   verified         —— 本机是否实机验证过该入口
//   selfContainedServer —— 入口进程是否自带服务拓扑（true = 进 ACP 模式不需要
//                          额外 --standalone/端口管理；opencode 内部用私有 server）
//   transports       —— transport → { kind, args?, flag?, loginArgs?, note? }
//                       · subcommand: args 为子命令参数（如 ['acp']）
//                       · root-flag : flag 为根级旗标（如 '--acp'）
//                       · external-binary: binaryNames + npmPackage（适配器即入口）
//   binaryNames      —— 原生 CLI 的候选二进制名（可空：由既有 CLI 定位链解析）
//   evidence         —— 实测出处（命令 + 关键输出），证据纪律的落点
//   verifiedAt       —— 证据日期
const ACP_LAYOUTS = Object.freeze([
  Object.freeze({
    provider: 'opencode',
    verified: true,
    selfContainedServer: true,
    binaryNames: Object.freeze(['opencode']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({
        kind: 'subcommand',
        args: Object.freeze(['acp']),
        // `opencode acp --login`：先跑 auth login 再退出（ACP terminal-auth 入口）。
        loginArgs: Object.freeze(['acp', '--login'])
      })
    }),
    evidence: 'opencode v2.0.29 实机：`opencode acp --help`（"Start an Agent Client Protocol server"，--login="Run auth login instead of starting the server"）；源码 handlers/acp.ts 内部 Standalone.start()（私有 server，无固定端口），并自行设 OPENCODE_CLIENT=acp',
    verifiedAt: '2026-10-16'
  }),
  Object.freeze({
    provider: 'gemini',
    verified: true,
    selfContainedServer: true,
    binaryNames: Object.freeze(['gemini']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({
        kind: 'root-flag',
        flag: '--acp',
        // 旧拼写仍可用但已弃用（官方文案：deprecated, use --acp instead）。
        deprecatedFlags: Object.freeze(['--experimental-acp'])
      })
    }),
    evidence: 'gemini CLI 实机 `gemini --help`："--acp  Starts the agent in ACP mode"；"--experimental-acp  Starts the agent in ACP mode (deprecated, use --acp instead)"',
    verifiedAt: '2026-10-16'
  }),
  Object.freeze({
    provider: 'cline',
    verified: true,
    selfContainedServer: true,
    binaryNames: Object.freeze(['cline']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({
        kind: 'root-flag',
        flag: '--acp'
      })
    }),
    evidence: 'cline v3.0.71 实机 `cline --help`："--acp  Run in Agent Client Protocol (ACP) mode for editor integration"',
    verifiedAt: '2026-10-16'
  }),
  Object.freeze({
    provider: 'codebuddy',
    verified: true,
    selfContainedServer: true,
    binaryNames: Object.freeze(['codebuddy']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({
        kind: 'root-flag',
        flag: '--acp'
      }),
      'http-sse': Object.freeze({
        kind: 'root-flag',
        flag: '--serve',
        note: 'ACP over HTTP SSE（官方文案：Web UI / REST API / ACP over HTTP SSE）；无 --acp 时 ACP 不走 stdio —— 两个传输是显式二选一'
      })
    }),
    evidence: 'codebuddy CLI v2.161.4 实机 `codebuddy --help`："--acp  Start in ACP (Agent Client Protocol) mode - enables communication via stdin/stdout using ndJsonStream"；"--serve  Start HTTP server (Web UI, REST API, ACP over HTTP SSE). Without --acp, ACP does not use stdio"',
    verifiedAt: '2026-10-16'
  }),
  Object.freeze({
    provider: 'kimi',
    verified: true,
    selfContainedServer: true,
    binaryNames: Object.freeze(['kimi']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({
        kind: 'subcommand',
        args: Object.freeze(['acp']),
        // `kimi acp --login` 是 ACP terminal-auth 入口（device-code；--region 选
        // mainland-cn / global，与 kimi 双区域账号口径一致，属于登录参数而非入口）。
        loginArgs: Object.freeze(['acp', '--login'])
      })
    }),
    evidence: 'kimi-code CLI v2.2.0 实机 `kimi acp --help`："Run kimi-code as an Agent Client Protocol (ACP) server over stdio."；"--login  Run the device-code login flow then exit (entry point for ACP terminal-auth)"；"--region  mainland-cn / global"',
    verifiedAt: '2026-10-16'
  }),
  // CodeBuddy 家族其余三支共享 CLI 内核（见 lib/runtime/codebuddy-family-layouts.js 的
  // FAMILY_PROVIDERS 与同构磁盘布局），入口形态按家族推断；本机未装对应二进制，
  // 按证据纪律标 verified: false —— 消费方要求硬保证时应先实机验证再放行。
  Object.freeze({
    provider: 'codebuddycn',
    verified: false,
    selfContainedServer: true,
    binaryNames: Object.freeze(['codebuddycn']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({ kind: 'root-flag', flag: '--acp' }),
      'http-sse': Object.freeze({ kind: 'root-flag', flag: '--serve' })
    }),
    evidence: '家族共享内核推断（codebuddy 行实机验证；codebuddycn 本机未安装）。验证方法：`codebuddycn --help` 查 --acp',
    verifiedAt: ''
  }),
  Object.freeze({
    provider: 'workbuddy',
    verified: false,
    selfContainedServer: true,
    binaryNames: Object.freeze(['workbuddy']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({ kind: 'root-flag', flag: '--acp' }),
      'http-sse': Object.freeze({ kind: 'root-flag', flag: '--serve' })
    }),
    evidence: '家族共享内核推断（codebuddy 行实机验证；workbuddy 本机未安装）。验证方法：`workbuddy --help` 查 --acp',
    verifiedAt: ''
  }),
  Object.freeze({
    provider: 'workbuddycn',
    verified: false,
    selfContainedServer: true,
    binaryNames: Object.freeze(['workbuddycn']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({ kind: 'root-flag', flag: '--acp' }),
      'http-sse': Object.freeze({ kind: 'root-flag', flag: '--serve' })
    }),
    evidence: '家族共享内核推断（codebuddy 行实机验证；workbuddycn 本机未安装）。验证方法：`workbuddycn --help` 查 --acp',
    verifiedAt: ''
  }),
  // 外部适配器：claude / codex CLI 本体没有 ACP 入口，官方配对是 Zed 维护的 ACP
  // 适配器（独立二进制，即 ACP 服务进程）。适配器未随 aih 分发：二进制存在与否由
  // 运行期解析（getAcpExternalBinary），未安装即 fail closed。
  Object.freeze({
    provider: 'claude',
    verified: false,
    selfContainedServer: true,
    binaryNames: Object.freeze(['claude-code-acp']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({
        kind: 'external-binary',
        binaryNames: Object.freeze(['claude-code-acp']),
        npmPackage: '@zed-industries/claude-code-acp'
      })
    }),
    evidence: 'claude CLI 本体 --help 无 ACP 入口（实机）；官方配对适配器 @zed-industries/claude-code-acp（npm 0.16.2，2026-10-16 registry 查证），本机未安装',
    verifiedAt: ''
  }),
  Object.freeze({
    provider: 'codex',
    verified: false,
    selfContainedServer: true,
    binaryNames: Object.freeze(['codex-acp']),
    transports: Object.freeze({
      'stdio-ndjson': Object.freeze({
        kind: 'external-binary',
        binaryNames: Object.freeze(['codex-acp']),
        npmPackage: '@zed-industries/codex-acp'
      })
    }),
    evidence: 'codex CLI 本体 --help 无 ACP 入口（实机）；官方配对适配器 @zed-industries/codex-acp（npm 0.16.0，2026-10-16 registry 查证），本机未安装；npm 上另有同名非官方包 codex-acp（1.10.1），解析时以 @zed-industries 为准',
    verifiedAt: ''
  })
]);

const LAYOUT_BY_PROVIDER = new Map(ACP_LAYOUTS.map((layout) => [layout.provider, layout]));

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeTransport(transport) {
  const value = String(transport == null ? '' : transport).trim().toLowerCase();
  return value || DEFAULT_ACP_TRANSPORT;
}

/** 布局表全量（含未实机验证行；过滤交给调用方，`verified` 字段可观察）。 */
function listAcpLayouts() {
  return ACP_LAYOUTS.slice();
}

/** provider 列表；`verifiedOnly` 只要实机验证过的行（硬保证场景）。 */
function listAcpProviders(options = {}) {
  return ACP_LAYOUTS.filter((layout) => !options.verifiedOnly || layout.verified)
    .map((layout) => layout.provider);
}

/** provider → 布局描述符；未登记返回 null（fail closed，绝不给猜测形态）。 */
function getAcpLayout(provider) {
  return LAYOUT_BY_PROVIDER.get(normalizeProvider(provider)) || null;
}

function isAcpProvider(provider) {
  return getAcpLayout(provider) !== null;
}

/**
 * 组装 ACP 入口参数（不包含二进制路径本身；原生 CLI 由调用方的 CLI 定位链解析，
 * 外部适配器走 getAcpExternalBinary）。
 * 返回：
 *   string[] —— 入口参数（external-binary 形态为 []：适配器进程本身就是服务）；
 *   null     —— provider 未登记 / transport 未声明 / 请求 login 但该入口没有
 *               loginArgs（调用方回退到 provider 自身的登录通道，绝不猜）。
 */
function buildAcpEntryArgs(provider, options = {}) {
  const layout = getAcpLayout(provider);
  if (!layout) return null;
  const entry = layout.transports[normalizeTransport(options.transport)];
  if (!entry) return null;
  if (options.login) {
    return Array.isArray(entry.loginArgs) ? entry.loginArgs.slice() : null;
  }
  if (entry.kind === 'external-binary') return [];
  if (entry.kind === 'subcommand') return (entry.args || []).slice();
  if (entry.kind === 'root-flag') return entry.flag ? [entry.flag] : null;
  return null;
}

/**
 * 外部适配器信息（仅 external-binary 行）：{ binaryNames, npmPackage }。
 * 其余行返回 null —— 原生入口的二进制由既有 CLI 定位链（resolveProviderCliPath）解析。
 */
function getAcpExternalBinary(provider, options = {}) {
  const layout = getAcpLayout(provider);
  if (!layout) return null;
  const entry = layout.transports[normalizeTransport(options.transport)];
  if (!entry || entry.kind !== 'external-binary') return null;
  return {
    binaryNames: (entry.binaryNames || []).slice(),
    npmPackage: String(entry.npmPackage || '')
  };
}

module.exports = {
  ACP_ENTRY_KINDS,
  ACP_LAYOUTS,
  ACP_TRANSPORTS,
  DEFAULT_ACP_TRANSPORT,
  buildAcpEntryArgs,
  getAcpExternalBinary,
  getAcpLayout,
  isAcpProvider,
  listAcpLayouts,
  listAcpProviders
};
