'use strict';

const { supportsAihServerProfile } = require('../../../account/self-relay-account');

const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// 中文在终端里占两列，`length` 只算一个字符 —— 对齐必须按显示宽度算。
function displayWidth(text) {
  let width = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    width += (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1;
  }
  return width;
}

function line(command, description, width = 34) {
  const padding = Math.max(2, width - displayWidth(command));
  return `  ${command}${' '.repeat(padding)}${DIM}${description}${RESET}`;
}

function section(title, rows, width = 0) {
  // 列宽按该组最长的命令自适应（上限 48），不手写列宽，避免长命令把说明挤成一团。
  const longest = rows.reduce((max, [command]) => Math.max(max, displayWidth(command)), 0);
  const columnWidth = Math.min(48, Math.max(Number(width) || 0, longest + 2));
  return [`\n${YELLOW}${title}${RESET}`, ...rows.map(([command, description]) => line(command, description, columnWidth))].join('\n');
}

function createCliHelpService(options = {}) {
  const {
    log = console.log
  } = options;

  function showHelp() {
    log([
      `\n${CYAN}AI Home (aih)${RESET} — 多账号沙箱 · 本地统一网关 · 会话续聊`,
      `${DIM}一个命令管住 codex / claude / codebuddy / gemini … 的多个账号，并把它们变成一个 OpenAI 兼容网关。${RESET}`,

      section('常用', [
        ['aih ls', '列出所有工具、账号与状态'],
        ['aih <cli>', '用默认账号启动（codex / claude / codebuddycn …）'],
        ['aih <cli> <id>', '用指定账号启动，例如 aih codex 2'],
        ['aih resume [关键词]', '选一段会话继续（跨 provider；可按标题过滤）'],
        ['aih harness <id>', '外部 harness（pi / dsh）用指定账号 relay，见下方']
      ]),

      section('会话', [
        ['aih resume [关键词]', '选择并续聊；--provider / --account / --limit / --json'],
        ['aih <cli> resume [<id>]', '直接续聊：TAB 补会话 id，也可以补标题片段'],
        ['aih <cli> fork [<id>]', '从某一段分叉出新会话（原会话不动）'],
        ['aih <cli> sessions [--history]', '列出该 CLI 的会话（--limit N、--all-projects）'],
        ['aih ss | sessions [<名字>]', '本机正在跑的持久会话：带名字直接进入，TAB 可补 pane 名'],
        ['aih <cli> -- <原生参数>', '逃生门：-- 之后原样交给原生 CLI']
      ]),

      section('外部 harness（relay 到某个账号）', [
        ['aih harness', '列出可用 harness：pi / dsh / dsh-tui'],
        ['aih harness pi --provider codex --account 2', '用 codex 2 号账号跑 pi（请求经本地网关）'],
        ['aih harness pi --account codex:2', '同上，简写'],
        ['aih harness pi --provider codex --json', '只打印解析结果（脚本/CI 用）']
      ], 44),

      section('账号', [
        ['aih <cli> ls', '列出账号（--help 有分页说明）'],
        ['aih <cli> login [--no-browser]', '新建账号并走登录流程'],
        ['aih <cli> detect', '扫描本机已登录的 CodeBuddy / WorkBuddy 账号'],
        ['aih <cli> delete <ids> | deleteall', '删除账号（支持 1,2,3 或 1-9）'],
        ['aih <cli> set-default <id>', '设置该 CLI 的宿主默认账号'],
        ['aih <cli> unset-default', '清除默认账号（网关类 CLI 会切到 AIH Server）'],
        ['aih <cli> usage [id] [--refresh]', '额度/用量查询（不给 id 就扫全部）'],
        ['aih export [...] [file.json]', '导出账号（含明文凭据，注意保存）'],
        ['aih import <file.json...>', '导入账号（同身份更新、不重复）']
      ], 40),

      section('网关与远程', [
        ['aih server start|restart|stop|status', '本机网关的生命周期'],
        ['aih server config list|get|set', '可设置项（TAB 可补旗标与枚举取值）'],
        ['aih server env', '打印可用的网关环境变量'],
        ['aih node <action>', '远程 worker：join / doctor / bootstrap / service / relay / webrtc'],
        ['aih fabric <action>', 'Server / 节点组网：transport / closure / provider / session'],
        ['aih ssh [...]', 'SSH 图片粘贴包装（非零客户端兜底）'],
        ['aih edge <status|plan|apply|remove>', '本机入口转发：nginx / caddy / frp']
      ], 40),

      section('终端与福利', [
        ['aih shell status|plan|apply|remove', '安装/移除 TAB 补全与拼写纠正'],
        ['aih shell snippet', '只打印片段（可 eval）'],
        ['aih shell typo [list|forget]', '查看/遗忘已学习的拼写纠正'],
        ['aih claim [qoder|qodercn|zcode|all]', '领取每日签到 / 活动福利']
      ], 40),

      section('进阶', [
        ['aih <cli> home [id]', '显示该账号真正使用的 HOME / 配置路径'],
        ['aih <cli> version', '该 CLI 的版本与可执行文件路径'],
        ['aih <cli> terminal-icon [--install]', '给终端配置真实的 provider 图标'],
        ['aih <cli> set-mobile <id>', 'codex：设置 Codex App 使用的账号'],
        ['aih <cli> policy ...', 'codex：查看/修改执行沙箱策略'],
        ['aih plugin | mcp | skill | native plugin', '插件 / MCP / 技能的原生投影管理'],
        ['aih provider capabilities --json', '各 provider 的资源边界与缺口'],
        ['aih update [--check|--dry-run|--force]', '检查或执行自更新'],
        ['aih backup --help', '导出 / 导入（备份恢复）说明']
      ], 44),

      `\n${YELLOW}看细节${RESET}`,
      line('aih <cli> --help', '该 provider 的全部动作与原生动词'),
      line('aih server|node|fabric|shell|skill|mcp --help', '各自子命令'),
      line('TAB', '所有能敲到的位置都有候选：命令 / provider / 账号 / 会话 / 枚举取值'),
      `${DIM}补全建议安装：aih shell apply（zsh / bash / fish / PowerShell）${RESET}`,
      ''
    ].join('\n'));
  }

  function showCliUsage(cliName) {
    const gatewayDefault = supportsAihServerProfile(cliName);
    const rows = [
      ['aih ' + cliName, '用默认账号启动（账号未设置时是 1 号）'],
      ['aih ' + cliName + ' <id> [args]', '用指定账号启动'],
      ['aih ' + cliName + ' resume [<id>]', '续聊指定会话（TAB 补 id / 标题片段）'],
      ['aih ' + cliName + ' fork [<id>]', '从指定会话分叉'],
      ['aih ' + cliName + ' sessions [--history]', '列出会话（--limit N、--all-projects）'],
      ['aih ' + cliName + ' -- <args>', '原样透传给原生 CLI（逃生门）']
    ];
    const accountRows = [
      ['aih ' + cliName + ' ls', '列出账号'],
      ['aih ' + cliName + ' login [--no-browser]', '新建账号并登录'],
      ['aih ' + cliName + ' delete <ids>', '删除账号（1,2,3 或 1-9）'],
      ['aih ' + cliName + ' deleteall', '删除全部账号'],
      ['aih ' + cliName + ' usage [id]', '额度/用量（--refresh 强制重探）'],
      ['aih ' + cliName + ' home [id]', '显示实际 HOME / 配置路径'],
      ['aih ' + cliName + ' version', '该 CLI 的版本与路径'],
      ['aih ' + cliName + ' set-default ' + (gatewayDefault ? '[<id>|.aih-server]' : '<id>'), '设置宿主默认账号'],
      ['aih ' + cliName + ' unset-default', gatewayDefault ? '切回 AIH Server 档' : '清除默认账号'],
      ['aih ' + cliName + ' import <file.json...>', '只导入该 provider 的账号']
    ];
    if (cliName === 'claude') {
      accountRows.push(['aih claude set-default <id> --desktop-mode <web|api>', '用指定模式启动 Claude Desktop']);
    }
    if (cliName === 'codex') {
      accountRows.push(['aih codex set-mobile <id>', '设置 Codex App 账号（ChatGPT OAuth）']);
      accountRows.push(['aih codex policy ...', '查看/修改执行沙箱策略']);
    }

    log([
      `\n${CYAN}AI Home (aih)${RESET} — ${YELLOW}${cliName}${RESET} 的子命令`,
      section('启动与会话', rows, 40),
      section('账号', accountRows, 46),
      section('进阶', [
        ['aih ' + cliName + ' detect', '扫描本机已登录的账号（CodeBuddy 家族）'],
        ['aih ' + cliName + ' terminal-icon [--install]', '终端图标'],
        ['aih ' + cliName + ' home [id]', '隔离路径诊断'],
        ['aih ' + cliName + ' --restart-client', '重启/拉起桌面客户端']
      ], 40),
      `\n${DIM}提示：账号位与 resume 之后都能 TAB；不记得会话 id 就用 aih resume。${RESET}`,
      ''
    ].join('\n'));
  }

  return {
    showHelp,
    showCliUsage
  };
}

module.exports = {
  createCliHelpService,
  displayWidth
};
