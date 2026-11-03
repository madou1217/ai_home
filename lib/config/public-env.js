'use strict';

// **公开环境变量白名单：上限 10 个。**
//
// 这是 aih 唯一承认的「部署时可以由人设置」的环境变量集合：
//   - `aih server config set …` / WebUI 能表达的，一律不进这里（config 才是正式入口）；
//   - 其余 `AIH_*` 全部是内部变量（进程间传递的身份/标记、实验开关、测试钩子），
//     `docs/architecture/env-flags.internal.md` 里列出但**不承诺兼容**，不要写进部署脚本。
//
// `scripts/collect-env-flags.js` 用它渲染 `docs/architecture/env-flags.md`，
// `test/env-inventory.test.js` 守住「≤10 + 每个都在源码里真实存在 + 文档只出现这些」。
// 新增一条必须同时降级/删除一条，并在 PR 里说明为什么 config/WebUI 放不下。

const PUBLIC_ENV_VARS = Object.freeze([
  {
    name: 'AIH_HOME_DIR',
    summary: '数据根目录（账号库、配置、会话注册表、日志）。容器 / 多实例部署改这里。',
    default: '~/.ai_home',
    configEquivalent: '无（定位 data root 必须在读配置之前）'
  },
  {
    name: 'AIH_HOST_HOME',
    summary: '宿主真实家目录。在 provider 沙箱会话里启动 server/autostart 时必须钉住，否则会从投影目录装 launchd job。',
    default: '$HOME（沙箱会话里不要依赖）',
    configEquivalent: '无（启动前就需要）'
  },
  {
    name: 'AIH_SERVER_HOST',
    summary: '网关监听地址。容器里通常设 0.0.0.0（等价 --open-network，务必同时设 key）。',
    default: '127.0.0.1',
    configEquivalent: '`aih server config set --host <ip>`（推荐）'
  },
  {
    name: 'AIH_SERVER_PORT',
    summary: '网关监听端口（HTTP/WS、WebUI、中转 TCP 分流与 UDP 侧共用）。',
    default: '9527',
    configEquivalent: '`aih server config set --port <n>`（推荐）'
  },
  {
    name: 'AIH_SERVER_API_KEY',
    summary: '客户端调用 /v1 的 key（Bearer）。容器编排一次性注入时用；长期部署建议写进 server config。',
    default: '（空 = 不校验）',
    configEquivalent: '`aih server config set --client-key <key>`'
  },
  {
    name: 'AIH_SERVER_MANAGEMENT_KEY',
    summary: '管理面 key（WebUI / 远程管理 / 中转服务）。',
    default: '（空 = 管理面关闭）',
    configEquivalent: '`aih server config set --management-key <key>`'
  },
  {
    name: 'AIH_SERVER_PROXY_URL',
    summary: '上游请求出口代理（HTTP(S)）。',
    default: '（空 = 直连）',
    configEquivalent: '`aih server config set --proxy-url <url>`'
  },
  {
    name: 'AIH_SERVER_NO_PROXY',
    summary: '不走代理的主机列表（逗号分隔，兼容标准 NO_PROXY 语义）。',
    default: '（空）',
    configEquivalent: '`aih server config set --no-proxy <hosts>`'
  },
  {
    name: 'AIH_MULTIPLEXER',
    summary: '持久会话/后台运行使用的复用器（auto / tmux / herdr / off）。off = 关闭复用器直接前台运行（排障用）。',
    default: 'auto',
    configEquivalent: '无（CLI 运行时选择，不属于 server 配置）'
  },
  {
    name: 'AIH_NO_PERSIST',
    summary: '交互式 CLI 的逃生门：=1 时不套 tmux/psmux，直接前台运行（排查卡死/嵌套会话时用）。',
    default: '（未设置 = 启用持久会话）',
    configEquivalent: '无（一次性排障开关）'
  }
]);

const PUBLIC_ENV_NAMES = Object.freeze(PUBLIC_ENV_VARS.map((item) => item.name));
const PUBLIC_ENV_NAME_SET = new Set(PUBLIC_ENV_NAMES);
const PUBLIC_ENV_LIMIT = 10;

function isPublicEnvVar(name) {
  return PUBLIC_ENV_NAME_SET.has(String(name || ''));
}

module.exports = {
  PUBLIC_ENV_VARS,
  PUBLIC_ENV_NAMES,
  PUBLIC_ENV_LIMIT,
  isPublicEnvVar
};
