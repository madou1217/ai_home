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
  Object.freeze({ name: '--remote', summary: '指定远程主机名（远程粘贴通道）' })
]);

const CORE_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'ls',
    aliases: Object.freeze(['list']),
    summary: '列出所有工具、账号与状态',
    flags: Object.freeze(['--help'])
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
    name: 'node',
    summary: '远程 worker 节点（内部命令）',
    subcommands: Object.freeze([
      Object.freeze({ name: 'join', summary: '用一次性邀请加入 Server' }),
      Object.freeze({ name: 'doctor', summary: '诊断本机节点状态' }),
      Object.freeze({ name: 'bootstrap', summary: '生成/执行远程自举计划' }),
      Object.freeze({ name: 'service', summary: '受管自启服务 status|install|uninstall' }),
      Object.freeze({ name: 'relay', summary: '中继连接与服务' }),
      Object.freeze({ name: 'webrtc', summary: 'WebRTC 连接与服务' })
    ]),
    flags: Object.freeze(['--json', '--help'])
  }),
  Object.freeze({
    name: 'fabric',
    summary: 'Server/profile/node/relay 组网工具',
    subcommands: Object.freeze([
      Object.freeze({ name: 'transport', summary: '传输探测与基准' }),
      Object.freeze({ name: 'closure', summary: '闭环状态/审计/验证' }),
      Object.freeze({ name: 'provider', summary: '远端 provider 账号审计与重认证' }),
      Object.freeze({ name: 'nodes', summary: '列出节点' }),
      Object.freeze({ name: 'session', summary: '远端会话 start|attach|events|message|slash|stop' }),
      Object.freeze({ name: 'registry', summary: '注册中心 publish/heartbeat/agent' }),
      Object.freeze({ name: 'broker', summary: '多 Server broker 连接' })
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
    flags: Object.freeze(['--provider', '--account', '--model', '--json', '--list', '--help'])
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
    summary: '导出 / 导入用法说明',
    flags: Object.freeze(['--help'])
  }),
  Object.freeze({
    name: 'provider',
    summary: 'Provider 资源边界与诊断',
    subcommands: Object.freeze([
      Object.freeze({ name: 'capabilities', summary: '列出各 provider 的资源边界' }),
      Object.freeze({ name: 'doctor', summary: '本机可用性与受管资源状态' })
    ]),
    flags: Object.freeze(['--json'])
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
 * Provider 动作的选项：按动作名声明（对所有 provider 一致），供补全给候选。
 * 不在表里的动作只补 `--help`——宁缺勿猜。
 */
const PROVIDER_ACTION_FLAGS = Object.freeze({
  usage: Object.freeze(['--refresh', '--preflight', '-j']),
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
  'node bootstrap': Object.freeze(['probe', 'apply']),
  'node service': Object.freeze(['status', 'install', 'uninstall']),
  'node relay': Object.freeze(['connect', 'service']),
  'node webrtc': Object.freeze(['connect', 'service']),
  'node relay service': Object.freeze(['install', 'status', 'uninstall']),
  'node webrtc service': Object.freeze(['install', 'status', 'uninstall']),
  'fabric transport': Object.freeze([
    'probe', 'echo', 'echo-server', 'tcp-echo', 'tcp-echo-server', 'readiness', 'status',
    'prerequisites', 'promotion-gate', 'cloud-edge', 'turn-relay', 'webtransport',
    'relay-durability', 'config'
  ]),
  'fabric closure': Object.freeze(['status', 'audit', 'verify', 'resume-check']),
  'fabric provider': Object.freeze(['accounts']),
  'fabric provider accounts': Object.freeze(['audit', 'revalidate', 'reauth', 'auth-job']),
  'fabric session': Object.freeze(['start', 'attach', 'events', 'message', 'slash', 'stop']),
  'fabric registry': Object.freeze(['publish', 'heartbeat', 'agent']),
  'fabric registry agent': Object.freeze(['service']),
  'native plugin': Object.freeze([
    'list', 'install', 'enable', 'disable', 'remove', 'inspect', 'project', 'doctor'
  ]),
  'ssh-clipboard probe': Object.freeze([]),
  'shell typo': Object.freeze(['list', 'forget'])
});

module.exports = {
  AIH_SESSION_FLAGS,
  NESTED_SUBCOMMAND_TABLES,
  PROVIDER_ACTIONS,
  PROVIDER_ACTION_EXTRAS,
  PROVIDER_ACTION_FLAGS,
  TOP_LEVEL_COMMANDS,
  findTopLevelCommand,
  isProviderName,
  listProviderActionFlags,
  listProviderActions,
  listProviderNames,
  listTopLevelCommandNames,
  supportsAihServerProfile
};
