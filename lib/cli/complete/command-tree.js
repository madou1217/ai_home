'use strict';

/**
 * `aih` 自身命令面的**唯一声明处**：补全候选、拼写建议、`aih shell` 的提示都从这里取。
 *
 * 为什么要有这张表：以前命令面只存在于 `help/messages.js` 的手写文案与 root router 的
 * handler 键里，任何「候选/建议」都只能再抄一份（必然漂移）。这里用声明式描述符表达
 * 「有哪些动作、每个动作一句话、下一层有什么」，消费方只查表，不再各写一遍分支。
 *
 * 边界（如实说明）：
 * - Provider 身份不在这里：它来自 Go 合同（`listSupportedAiClis()` → contracts/providers/manifest.json）。
 * - Provider 的通用动作在这里声明一次、对所有 provider 生效；`PROVIDER_ACTION_EXTRAS` 只放
 *   **只属于某个 CLI 的界面动作**（codex 的 set-mobile / policy），是 CLI 面数据，不是能力派发。
 * - 这里只描述「命令面」，不描述 provider 的参数：`aih codex -- <原生参数>` 一律透传，
 *   补全在账号位之后主动让路（返回空 = 交回 shell 的默认补全）。
 */

const {
  getAiCliConfig,
  listSupportedAiClis
} = require('../services/ai-cli/provider-registry');
// gatewayProfile 能力直接问合同（provider-catalog 只读生成清单），
// 不走 self-relay-account：后者会连带加载账号存储，补全热路径不能付这个开销。
const { listProvidersByCapability } = require('../../provider-catalog');

/** aih 自己的持久会话旗标（在 provider 参数之前被 aih 摘走，因此任何位置都可用）。 */
const AIH_SESSION_FLAGS = Object.freeze([
  Object.freeze({ name: '-S', summary: '本次启动的持久会话标签（等价 --session <标签>）' }),
  Object.freeze({ name: '--session', summary: '本次启动的持久会话标签' }),
  Object.freeze({ name: '-R', summary: '接管本项目最近的持久会话（--aih-resume）' }),
  Object.freeze({ name: '--aih-resume', summary: '接管本项目最近的持久会话' }),
  Object.freeze({ name: '-M', summary: '共享本项目最近的持久会话（--aih-mirror）' }),
  Object.freeze({ name: '--aih-mirror', summary: '共享本项目最近的持久会话' }),
  Object.freeze({ name: '--remote', summary: '指定远程主机名（远程粘贴通道）' }),
  Object.freeze({ name: '--model', summary: '本次启动请求的模型名' }),
  Object.freeze({ name: '--model-alias', summary: '本次启动的临时转发：A 请求实际用 B（不落库）' })
]);

const CORE_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'ls',
    aliases: Object.freeze(['list']),
    summary: '列出所有工具、账号与状态（provider 位支持通配，也可 --scope）',
    flags: Object.freeze(['--scope', '--help'])
  }),
  Object.freeze({
    name: 'resume',
    summary: '跨 provider 选择一段会话并续聊（不记得 id 时用这个）',
    flags: Object.freeze(['--provider', '--account', '--limit', '--json', '--help'])
  }),
  Object.freeze({
    name: 'ss',
    aliases: Object.freeze(['sessions']),
    summary: '选择并进入一个活跃的持久会话',
    subcommands: Object.freeze([
      Object.freeze({ name: '--list', summary: '按项目预览所有活跃会话' }),
      Object.freeze({ name: '--history', summary: '列出该 CLI 自己的历史会话（配合 resume/fork）' })
    ])
  }),
  Object.freeze({
    name: 'usage',
    summary: '按 provider / 模型统计 token 与成本',
    subcommands: Object.freeze([
      Object.freeze({ name: 'stats', summary: '总览' }),
      Object.freeze({ name: 'models', summary: '按模型汇总' }),
      Object.freeze({ name: 'sessions', summary: '按会话汇总' }),
      Object.freeze({ name: 'session-detail', summary: '单个会话明细' }),
      Object.freeze({ name: 'scan', summary: '重新扫描历史记录' }),
      Object.freeze({ name: 'recalculate-costs', summary: '用当前定价重算历史成本' })
    ]),
    flags: Object.freeze(['--from', '--to', '--provider', '--model', '--session-id', '--no-scan', '--json', '--reindex-codex-forks'])
  }),
  Object.freeze({
    name: 'update',
    summary: '检查更新或通过 npm 更新 ai-home',
    flags: Object.freeze(['--check', '--dry-run', '--force'])
  })
]);

const SERVER_NODE_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'server',
    aliases: Object.freeze(['serve', 'daemon']),
    summary: '管理本机 OpenAI 兼容网关',
    subcommands: Object.freeze([
      Object.freeze({ name: 'start', summary: '启动（daemon 模式）' }),
      Object.freeze({ name: 'restart', summary: '重启' }),
      Object.freeze({ name: 'stop', summary: '停止' }),
      Object.freeze({ name: 'status', summary: '查看状态' }),
      Object.freeze({ name: 'serve', summary: '前台运行' }),
      Object.freeze({ name: 'add', summary: '保存并选中一个远程 Server' }),
      Object.freeze({ name: 'ls', summary: '列出已保存的 Server' }),
      Object.freeze({ name: 'use', summary: '切换当前 Server' }),
      Object.freeze({ name: 'remove', summary: '移除已保存的 Server' }),
      Object.freeze({ name: 'config', summary: '查看/设置服务端配置' }),
      Object.freeze({ name: 'autostart', summary: '开机自启 install|uninstall|status' }),
      Object.freeze({ name: 'env', summary: '打印可用的网关环境变量' }),
      Object.freeze({ name: 'sync-codex', summary: '同步 Codex 账号到远端 Server' })
    ]),
    flags: Object.freeze(['--json', '--help'])
  }),
  Object.freeze({
    name: 'desktop',
    summary: '桌面端版本总览（canonical / 影子 / 运行中）',
    subcommands: Object.freeze([
      Object.freeze({ name: 'status', summary: 'canonical 版本、影子副本、运行中实例与漂移' })
    ]),
    flags: Object.freeze(['--json', '--help'])
  }),
  Object.freeze({
    name: 'edge',
    summary: '本机入口转发（nginx / caddy / frp）',
    subcommands: Object.freeze([
      Object.freeze({ name: 'status', summary: '当前入口与转发状态' }),
      Object.freeze({ name: 'plan', summary: '只打印将要写入的配置' }),
      Object.freeze({ name: 'apply', summary: '写入配置并校验/重载' }),
      Object.freeze({ name: 'remove', summary: '移除受管条目' })
    ]),
    flags: Object.freeze(['--dry-run', '--json', '--help'])
  }),
  Object.freeze({
    name: 'claim',
    summary: '领取账号福利 / 活动（签到）',
    subcommands: Object.freeze([
      Object.freeze({ name: 'qoder', summary: 'Qoder 每日签到' }),
      Object.freeze({ name: 'qodercn', summary: 'Qoder 国内站每日签到' }),
      Object.freeze({ name: 'zcode', summary: 'ZCode 活动领取' }),
      Object.freeze({ name: 'all', summary: '全部可领取项（默认）' })
    ]),
    flags: Object.freeze(['--dry-run', '--account', '--json', '--quiet'])
  })
]);

// 外部 harness（pi / dsh / dsh-tui）：id 来自 harness/catalog 的唯一注册表，
// 补全列表与 aih harness 实际能跑的集合永远同源。
const EXTERNAL_HARNESS_SUBCOMMANDS = (() => {
  try {
    const { listExternalHarnesses } = require('../../harness/catalog');
    return Object.freeze(listExternalHarnesses().map((harness) => Object.freeze({
      name: harness.id,
      summary: String(harness.label || harness.description || '').trim()
    })));
  } catch (_error) {
    return Object.freeze([]);
  }
})();

const TOOL_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'harness',
    summary: '用某个 Provider 的某个账号跑外部 harness（经本地网关 relay）',
    subcommands: EXTERNAL_HARNESS_SUBCOMMANDS,
    flags: Object.freeze(['--provider', '--account', '--model', '--model-alias', '--json', '--list', '--help'])
  }),
  Object.freeze({
    name: 'shell',
    summary: '终端集成：补全、拼写纠正、rc 片段管理',
    subcommands: Object.freeze([
      Object.freeze({ name: 'status', summary: '当前 shell 集成状态' }),
      Object.freeze({ name: 'plan', summary: '打印将要写入 rc 的片段（不写文件）' }),
      Object.freeze({ name: 'apply', summary: '写入 shell 集成（带备份）' }),
      Object.freeze({ name: 'remove', summary: '移除 aih 写入的片段' }),
      Object.freeze({ name: 'snippet', summary: '只打印片段（可 eval）' }),
      Object.freeze({ name: 'typo', summary: '查看/遗忘已学习的拼写纠正' })
    ]),
    flags: Object.freeze(['--shell', '--rc-file', '--no-typo', '--no-completion', '--no-wrapper', '--dry-run', '--json', '--help'])
  }),
  Object.freeze({
    name: 'agent',
    summary: 'TUI harness 的会话适配层：用哪个 adapter、三种交互从哪来',
    subcommands: Object.freeze([
      Object.freeze({ name: 'adapters', summary: '每个 harness 的 adapter 候选与实现状态' }),
      Object.freeze({ name: 'capabilities', summary: '某 harness 的审批/提问/计划确认支持级别' }),
      Object.freeze({ name: 'probe', summary: '现在实际会选中哪个 adapter' })
    ]),
    flags: Object.freeze(['--json', '--help'])
  }),
  Object.freeze({
    name: 'peer',
    summary: '给另一个正在跑的会话发消息 / 看收件箱（协议 / 注入 / chat 总线）',
    subcommands: Object.freeze([
      Object.freeze({ name: 'list', summary: '列出可发消息的会话' }),
      Object.freeze({ name: 'send', summary: '发一条消息：send <名字|id> "<正文>"' }),
      Object.freeze({ name: 'inbox', summary: '看收件箱：inbox [--target <名字>] [--self]' }),
      Object.freeze({ name: 'read', summary: '看一条消息全文：read <msg-id>' }),
      Object.freeze({ name: 'reply', summary: '回给原发送方：reply <msg-id> "<正文>"' }),
      Object.freeze({ name: 'flush', summary: '手动补投一轮待投递消息' }),
      Object.freeze({ name: 'channels', summary: '每条通道怎么投递' })
    ]),
    flags: Object.freeze([
      '--provider', '--channel', '--mode', '--from', '--target', '--reply-to',
      '--self', '--unread', '--state', '--limit', '--wait', '--no-envelope',
      '--dry-run', '--json', '--help'
    ])
  }),
  Object.freeze({
    name: 'export',
    summary: '导出账号（aih 原生 JSON，含明文凭据）'
  }),
  Object.freeze({
    name: 'import',
    summary: '导入 aih 账号文件',
    flags: Object.freeze(['--dry-run'])
  }),
  Object.freeze({
    name: 'backup',
    summary: '导出 / 导入 / 远程自动备份',
    subcommands: Object.freeze([
      Object.freeze({ name: 'add', summary: '添加 SSH 备份目标' }),
      Object.freeze({ name: 'list', summary: '列出目标与最近结果' }),
      Object.freeze({ name: 'remove', summary: '删除目标' }),
      Object.freeze({ name: 'enable', summary: '启用目标' }),
      Object.freeze({ name: 'disable', summary: '暂停目标' }),
      Object.freeze({ name: 'run', summary: '立即备份（默认增量）' }),
      Object.freeze({ name: 'status', summary: '查看本地状态 / 远端清单' }),
      Object.freeze({ name: 'test', summary: '测试 SSH 连接' }),
      Object.freeze({ name: 'restore', summary: '从远端恢复账号' }),
      Object.freeze({ name: 'config', summary: '修改自动备份参数' }),
      Object.freeze({ name: 'show', summary: '打印配置与状态' })
    ]),
    flags: Object.freeze([
      '--name', '--port', '--key', '--remote-dir', '--password-env', '--strategy',
      '--interval', '--debounce', '--enabled', '--full', '--dry-run', '--remote', '--help'
    ])
  }),
  Object.freeze({
    name: 'provider',
    summary: 'Provider 目录、资源边界与诊断',
    subcommands: Object.freeze([
      Object.freeze({ name: 'ls', summary: '列出 provider 与各自的账号数（支持通配）' }),
      Object.freeze({ name: 'capabilities', summary: '列出各 provider 的资源边界' }),
      Object.freeze({ name: 'doctor', summary: '本机可用性与受管资源状态' })
    ]),
    flags: Object.freeze(['--scope', '--json'])
  }),
  Object.freeze({
    name: 'native',
    summary: '原生宿主投影（plugin）',
    subcommands: Object.freeze([
      Object.freeze({ name: 'plugin', summary: 'Codex/Claude/OpenCode 原生插件投影' })
    ])
  }),
  Object.freeze({
    name: 'mcp',
    summary: '管理并测试原生 MCP 投影',
    subcommands: Object.freeze([
      Object.freeze({ name: 'list', summary: '列出已登记 MCP' }),
      Object.freeze({ name: 'add', summary: '登记一个 stdio MCP' }),
      Object.freeze({ name: 'test', summary: '运行并握手测试' }),
      Object.freeze({ name: 'tools', summary: '列出工具' }),
      Object.freeze({ name: 'call', summary: '调用一个工具' }),
      Object.freeze({ name: 'enable', summary: '写入原生配置' }),
      Object.freeze({ name: 'disable', summary: '停用原生投影' }),
      Object.freeze({ name: 'remove', summary: '移除登记' }),
      Object.freeze({ name: 'doctor', summary: '检查投影一致性' })
    ]),
    flags: Object.freeze(['--provider', '--json'])
  }),
  Object.freeze({
    name: 'skill',
    summary: '管理原生 skill 与指令投影',
    subcommands: Object.freeze([
      Object.freeze({ name: 'list', summary: '列出 skill' }),
      Object.freeze({ name: 'install', summary: '安装并启用' }),
      Object.freeze({ name: 'enable', summary: '启用' }),
      Object.freeze({ name: 'disable', summary: '停用' }),
      Object.freeze({ name: 'remove', summary: '移除' }),
      Object.freeze({ name: 'doctor', summary: '检查投影一致性' })
    ]),
    flags: Object.freeze(['--provider', '--all-supported', '--json'])
  }),
  Object.freeze({
    name: 'plugin',
    summary: 'AIH 插件包与实例',
    subcommands: Object.freeze([
      Object.freeze({ name: 'validate', summary: '校验插件包' }),
      Object.freeze({ name: 'pack', summary: '打包成离线插件包' }),
      Object.freeze({ name: 'keygen', summary: '生成发布密钥对' }),
      Object.freeze({ name: 'trust', summary: '把发布公钥加入本机信任根' }),
      Object.freeze({ name: 'untrust', summary: '移除发布公钥' }),
      Object.freeze({ name: 'trusted', summary: '列出信任的发布公钥' }),
      Object.freeze({ name: 'install', summary: '安装插件包' }),
      Object.freeze({ name: 'list', summary: '已安装插件与实例' }),
      Object.freeze({ name: 'enable', summary: '启用实例' }),
      Object.freeze({ name: 'disable', summary: '停用实例' }),
      Object.freeze({ name: 'uninstall', summary: '卸载插件' }),
      Object.freeze({ name: 'call', summary: '调试调用一个贡献项' }),
      Object.freeze({ name: 'doctor', summary: '检查制品/签名/权限' })
    ]),
    flags: Object.freeze(['--json'])
  }),
  Object.freeze({
    name: 'ssh',
    summary: '非零客户端 SSH 图片粘贴包装',
    flags: Object.freeze(['--help'])
  }),
  Object.freeze({
    name: 'ssh-clipboard',
    summary: '严格零客户端终端图片剪贴板探针',
    subcommands: Object.freeze([
      Object.freeze({ name: 'probe', summary: '诊断真实粘贴路径' })
    ]),
    flags: Object.freeze(['--json', '--paste-event', '--timeout-ms'])
  }),
  Object.freeze({
    name: 'clip-agent',
    summary: 'SSH RemoteForward 剪贴板图片提供方',
    subcommands: Object.freeze([
      Object.freeze({ name: 'start', summary: '启动本机剪贴板代理' })
    ])
  }),
  Object.freeze({
    name: 'help',
    summary: '打印用法',
    aliases: Object.freeze(['--help', '-h'])
  })
]);

/**
 * 旗标的一句话说明：补全列表里**每个**候选都要能解释自己是什么。
 * 这张表与 flag 声明同处一个文件，新增旗标时忘了写说明会落到兜底文案（仍非空）。
 */
const FLAG_SUMMARIES = Object.freeze({
  '--account': '账号编号或 accountRef',
  '--all-supported': '对所有支持的 Provider 生效',
  '--channel': '投递通道（native / inject / webui-chat）',
  '--check': '只检查是否有更新',
  '--dry-run': '只打印将要做的改动，不写文件',
  '--force': '跳过确认，强制执行',
  '--force-quit-client': '先强杀客户端再设置',
  '--from': '起始时间（含）',
  '--help': '打印用法',
  '--history': '列该 CLI 自己的历史会话',
  '--json': '以 JSON 输出',
  '--limit': '最多返回多少条',
  '--list': '只列出，不进入',
  '--mode': 'peer 的投递模式',
  '--model': '本次启动请求的模型名',
  '--model-alias': '本次启动的临时转发：请求 A 实际用 B',
  '--no-browser': '不打开浏览器（设备码直接打印）',
  '--no-completion': '不安装 TAB 补全',
  '--no-envelope': '发送时不带信封',
  '--no-scan': '不重新扫描历史记录',
  '--no-typo': '不安装拼写纠正',
  '--no-wrapper': '不安装 aih 包装函数',
  '--paste-event': '用真实粘贴事件测试',
  '--preflight': '先探测账号可用性',
  '--provider': '指定 Provider',
  '--quiet': '安静模式，只输出结果',
  '--rc-file': '写入哪个 shell rc 文件',
  '--refresh': '强制重新探测 / 刷新',
  '--reindex-codex-forks': '重建 codex fork 的索引',
  '--remaining': '剩余额度阈值（0-100，0 = 只在真的用完时换）',
  '--reply-to': '回复指定消息',
  '--restart-client': '设置后重启客户端',
  '--scope': '按 provider 过滤（支持 * 与 ? 通配）',
  '--self': '只看发给自己的',
  '--session-id': '限定某个会话',
  '--shell': '目标 shell（zsh / bash / fish / powershell）',
  '--state': '按消息状态过滤',
  '--target': '收件人（会话名或 id）',
  '--timeout-ms': '超时毫秒数',
  '--to': '结束时间（含）',
  '--unread': '只看未读',
  '--wait': '等待可投递后再发',
  '-j': '以 JSON 输出（简写）'
});

/** 嵌套子命令的一句话说明（NESTED_SUBCOMMAND_TABLES 的配套表，按名字复用）。 */
const NESTED_SUBCOMMAND_SUMMARIES = Object.freeze({
  accounts: '列出 / 审计该 Provider 的账号',
  agent: '注册中心 agent 操作',
  apply: '应用配置',
  attach: '附着到运行中的会话',
  audit: '审计一致性',
  'auth-job': '查看 / 重跑认证任务',
  caddy: 'Caddy 入口',
  'cloud-edge': '云边通道',
  config: '查看 / 修改配置',
  connect: '建立连接',
  disable: '停用',
  doctor: '诊断一致性',
  echo: '回声测试',
  'echo-server': '启动回声服务端',
  enable: '启用',
  events: '读取会话事件',
  forget: '遗忘已学习的记录',
  frp: 'frp 入口',
  get: '读取配置项',
  heartbeat: '发送心跳',
  inspect: '查看详情',
  install: '安装',
  list: '列出',
  message: '给会话发消息',
  nginx: 'nginx 入口',
  off: '关闭',
  on: '开启',
  prerequisites: '检查前置条件',
  probe: '探测可用性',
  project: '投影原生配置',
  'promotion-gate': '晋升门禁检查',
  publish: '发布',
  readiness: '就绪检查',
  reauth: '重新认证',
  'relay-durability': '中继持久性检查',
  remove: '移除',
  'resume-check': '断点续传检查',
  revalidate: '重新校验',
  service: '服务管理',
  set: '写入配置项',
  show: '显示当前配置',
  slash: '发送斜杠命令',
  start: '启动',
  status: '查看状态',
  stop: '停止',
  'tcp-echo': 'TCP 回声测试',
  'tcp-echo-server': '启动 TCP 回声服务端',
  'turn-relay': 'TURN 中继检查',
  uninstall: '卸载',
  verify: '验证',
  webtransport: 'WebTransport 检查'
});

function describeFlag(flag) {
  const name = normalizeToken(flag);
  return FLAG_SUMMARIES[name] || `选项：${name.replace(/^-+/, '')}`;
}

function describeNestedSubcommand(name) {
  const key = normalizeToken(name);
  return NESTED_SUBCOMMAND_SUMMARIES[key] || `子命令：${key}`;
}

/** Provider 通用动作：对每个声明了 CLI 的 provider 都成立（事实来自 Go 合同）。 */
const PROVIDER_ACTIONS = Object.freeze([
  Object.freeze({ name: 'ls', summary: '列出该工具的账号' }),
  Object.freeze({ name: 'sessions', summary: '进入/列出该账号的持久会话' }),
  Object.freeze({ name: 'resume', summary: '续接上一段对话（翻译成原生 resume 参数）' }),
  Object.freeze({ name: 'fork', summary: '从上一段对话分叉（翻译成原生 fork 参数）' }),
  Object.freeze({ name: 'login', summary: '新建账号并跑登录流程' }),
  Object.freeze({ name: 'detect', summary: '扫描本机已登录账号（仅支持的 CLI 有效）' }),
  Object.freeze({ name: 'import', summary: '从目录/zip/JSON 导入账号' }),
  Object.freeze({ name: 'export', summary: '导出该工具的账号包' }),
  Object.freeze({ name: 'usage', summary: '查询账号额度（可带 id）' }),
  Object.freeze({ name: 'auto-switch', summary: '原生模式自动换号：额度见底 / 429 冷却时换下一个账号' }),
  Object.freeze({ name: 'home', summary: '打印生效的 HOME/配置路径' }),
  Object.freeze({ name: 'version', summary: '打印原生 CLI 版本与路径' }),
  Object.freeze({ name: 'terminal-icon', summary: '安装终端里的 provider 图标' }),
  Object.freeze({ name: 'set-default', summary: '设置宿主默认账号 / AIH Server 档' }),
  Object.freeze({ name: 'unset-default', summary: '清除宿主默认账号' }),
  Object.freeze({ name: 'delete', summary: '按 id 删除账号（如 1,2,3 或 1-9）' }),
  Object.freeze({ name: 'deleteall', summary: '删除该工具的全部账号' })
]);

/**
 * 只属于某个 CLI 的界面动作（CLI 面数据，非能力派发）。
 * 判据是「该动作在 aih 里只对这一个 provider 有意义」：codex 的 App 账号指针与 exec 沙箱策略。
 */
const PROVIDER_ACTION_EXTRAS = Object.freeze({
  codex: Object.freeze([
    Object.freeze({ name: 'set-mobile', summary: '设置 Codex App 账号（仅 ChatGPT OAuth）' }),
    Object.freeze({ name: 'unset-mobile', summary: '清除 Codex App 账号指针' }),
    Object.freeze({ name: 'policy', summary: '查看/设置 exec 沙箱策略' })
  ])
});

/**
 * Provider 动作自己的子命令层（`aih <cli> <action> <TAB>`）。
 * 只放动作本身确实有固定取值的；没有声明的动作保持「只补旗标」。
 */
const PROVIDER_ACTION_SUBCOMMANDS = Object.freeze({
  'auto-switch': Object.freeze(['on', 'off', 'status'])
});

/**
 * Provider 动作的选项：按动作名声明（对所有 provider 一致），供补全给候选。
 * 不在表里的动作只补 `--help`——宁缺勿猜。
 */
const PROVIDER_ACTION_FLAGS = Object.freeze({
  usage: Object.freeze(['--refresh', '--preflight', '-j']),
  'auto-switch': Object.freeze(['--remaining']),
  login: Object.freeze(['--no-browser']),
  sessions: Object.freeze(['--history', '--limit']),
  import: Object.freeze(['-j', '--dry-run']),
  'set-default': Object.freeze(['--restart-client', '--force-quit-client']),
  'set-mobile': Object.freeze([]),
  resume: Object.freeze([]),
  fork: Object.freeze([])
});

function listProviderActionFlags(action) {
  const name = normalizeToken(action);
  return ['--help', ...(PROVIDER_ACTION_FLAGS[name] || [])];
}

const TOP_LEVEL_COMMANDS = Object.freeze([
  ...CORE_COMMANDS,
  ...SERVER_NODE_COMMANDS,
  ...TOOL_COMMANDS
]);

const TOP_LEVEL_BY_NAME = new Map();
for (const command of TOP_LEVEL_COMMANDS) {
  TOP_LEVEL_BY_NAME.set(command.name, command);
  for (const alias of command.aliases || []) TOP_LEVEL_BY_NAME.set(alias, command);
}

function normalizeToken(value) {
  return String(value == null ? '' : value).trim();
}

/** 该 token 是否是 aih 的顶层命令（含别名）。 */
function findTopLevelCommand(token) {
  return TOP_LEVEL_BY_NAME.get(normalizeToken(token).toLowerCase()) || null;
}

function listTopLevelCommandNames() {
  const names = [];
  for (const command of TOP_LEVEL_COMMANDS) {
    names.push(command.name);
    for (const alias of command.aliases || []) names.push(alias);
  }
  return names;
}

function isProviderName(token) {
  return listSupportedAiClis().includes(normalizeToken(token).toLowerCase());
}

/** 该 provider 是否声明了网关档（`gateway_profile`）——`set-default .aih-server` 只对它有意义。 */
function supportsAihServerProfile(provider) {
  const id = normalizeToken(provider).toLowerCase();
  return Boolean(id) && listProvidersByCapability('gatewayProfile').includes(id);
}

function listProviderNames() {
  return listSupportedAiClis().slice();
}

/**
 * 某个 provider 的动作候选：通用动作 + 该 CLI 的界面动作。
 * 事实来源是 Go 合同（loginArgs / desktopClient / gatewayProfile），不在这里手写 provider 名单。
 */
function listProviderActions(provider) {
  const id = normalizeToken(provider).toLowerCase();
  const cliConfig = getAiCliConfig(id) || {};
  const loginArgs = Array.isArray(cliConfig.loginArgs) ? cliConfig.loginArgs : [];
  const supportsHostDefault = Boolean(cliConfig.desktopClient)
    || listProvidersByCapability('gatewayProfile').includes(id);
  const actions = PROVIDER_ACTIONS
    .filter((action) => {
      if (action.name === 'login') return loginArgs.length > 0;
      if (action.name === 'set-default' || action.name === 'unset-default') return supportsHostDefault;
      return true;
    })
    .map((action) => ({ name: action.name, summary: action.summary }));
  for (const extra of PROVIDER_ACTION_EXTRAS[id] || []) {
    actions.push({ name: extra.name, summary: extra.summary });
  }
  return actions;
}

/**
 * 第三层及更深的下钻表：键是「前两级 token」，值是下一层候选。
 * 只覆盖 `aih <命令> <子命令> …` 这类确实有固定动作的地方；表里没有的层级
 * 一律不给候选（把控制权交回 shell），绝不去猜 provider 的原生参数。
 */
const NESTED_SUBCOMMAND_TABLES = Object.freeze({
  'server config': Object.freeze(['show', 'get', 'set', 'list']),
  'server autostart': Object.freeze(['install', 'uninstall', 'status']),
  'native plugin': Object.freeze([
    'list', 'install', 'enable', 'disable', 'remove', 'inspect', 'project', 'doctor'
  ]),
  'ssh-clipboard probe': Object.freeze([]),
  'shell typo': Object.freeze(['list', 'forget']),
  'edge status': Object.freeze(['frp', 'nginx', 'caddy']),
  'edge plan': Object.freeze(['frp', 'nginx', 'caddy']),
  'edge apply': Object.freeze(['frp', 'nginx', 'caddy']),
  'edge remove': Object.freeze(['frp', 'nginx', 'caddy'])
});

module.exports = {
  AIH_SESSION_FLAGS,
  NESTED_SUBCOMMAND_TABLES,
  PROVIDER_ACTIONS,
  PROVIDER_ACTION_EXTRAS,
  PROVIDER_ACTION_FLAGS,
  PROVIDER_ACTION_SUBCOMMANDS,
  TOP_LEVEL_COMMANDS,
  describeFlag,
  describeNestedSubcommand,
  findTopLevelCommand,
  isProviderName,
  listProviderActionFlags,
  listProviderActions,
  listProviderNames,
  listTopLevelCommandNames,
  supportsAihServerProfile
};
