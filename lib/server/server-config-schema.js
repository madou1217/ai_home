'use strict';

// server config 的**唯一描述符表**：`aih server config list`、`--help` 与
// `test/server-config-schema.test.js` 全部从这张表派生。
//
// 纪律：新增可持久化设置项时，先在这里加一条描述符（`key` 必须与
// `DEFAULT_SERVER_CONFIG` 的键一致），否则测试会红——与「新增环境变量必须重跑
// `npm run env:inventory -- --write`」同级。
//
// 字段语义：
//   key       DEFAULT_SERVER_CONFIG 的键（app-state `config:server` 里保存的名字）
//   flag      写入用的旗标（`aih server config set <flag> …`）
//   clearFlag 恢复默认值的旗标（没有就省略）
//   type      展示/校验类型：ip | port | bool | url | hosts | secret | int | enum | csv | duration
//   values    enum 的合法取值
//   env       部署 fallback 的环境变量（config 显式设置时优先；空数组 = 无 env）
//   applies   生效方式：serve-arg（变成 serve 参数）| process-env（写进程环境）| runtime（运行期读配置）
//   samples   解析器一致性用例：`aih server config set <args…>` 必须落到该 key 且等于 expect
//   summary   一句话说明（中文，面向使用者，不是实现注释）

const SERVER_CONFIG_FIELDS = [
  {
    key: 'host',
    group: '监听与网络',
    flag: '--host <ip>',
    type: 'ip',
    env: ['AIH_SERVER_HOST'],
    applies: 'serve-arg',
    summary: '监听地址。默认 127.0.0.1 只对本机开放；填 0.0.0.0 等同于 --open-network，会对局域网/公网暴露端口。',
    samples: [{ args: ['--host', '127.0.0.1'], expect: '127.0.0.1' }]
  },
  {
    key: 'port',
    group: '监听与网络',
    flag: '--port <1..65535>',
    type: 'port',
    min: 1,
    max: 65535,
    env: ['AIH_SERVER_PORT'],
    applies: 'serve-arg',
    summary: '监听端口。网关、WebUI、中转的 TCP 分流器与 UDP 前端共用这一个端口号。',
    samples: [{ args: ['--port', '9527'], expect: 9527 }]
  },
  {
    key: 'openNetwork',
    group: '监听与网络',
    flag: '--open-network|--local-only',
    type: 'bool',
    env: [],
    applies: 'serve-arg',
    summary: '是否对外监听（等价于把 host 设为 0.0.0.0）。关闭时仅本机可访问；打开后请务必设置 client key 与 management key。',
    samples: [
      { args: ['--open-network'], expect: true },
      { args: ['--local-only'], expect: false }
    ]
  },
  {
    key: 'proxyUrl',
    group: '监听与网络',
    flag: '--proxy-url <url>',
    clearFlag: '--clear-proxy-url',
    type: 'url',
    env: ['AIH_SERVER_PROXY_URL'],
    applies: 'serve-arg',
    summary: '上游请求走的 HTTP(S) 代理。空 = 直连（系统 NO_PROXY 语义仍生效）。',
    samples: [{ args: ['--proxy-url', 'http://127.0.0.1:7890'], expect: 'http://127.0.0.1:7890' }],
    clear: { expect: '' }
  },
  {
    key: 'noProxy',
    group: '监听与网络',
    flag: '--no-proxy <hosts>',
    clearFlag: '--clear-no-proxy',
    type: 'hosts',
    env: ['AIH_SERVER_NO_PROXY', 'NO_PROXY'],
    applies: 'serve-arg',
    summary: '不走代理的主机列表（逗号分隔，支持 * 通配与域名后缀）。',
    samples: [{ args: ['--no-proxy', 'localhost,*.local'], expect: 'localhost,*.local' }],
    clear: { expect: '' }
  },
  {
    key: 'apiKey',
    group: '鉴权',
    flag: '--client-key <key>',
    clearFlag: '--clear-client-key',
    type: 'secret',
    env: ['AIH_SERVER_API_KEY'],
    applies: 'serve-arg',
    secret: true,
    summary: '客户端调用 /v1 与 /v1beta 所需的 key（Authorization: Bearer）。空 = 不校验，只建议在本机监听时使用。',
    samples: [{ args: ['--client-key', 'sk-test'], expect: 'sk-test' }],
    clear: { expect: '' }
  },
  {
    key: 'managementKey',
    group: '鉴权',
    flag: '--management-key <key>',
    clearFlag: '--clear-management-key',
    type: 'secret',
    env: ['AIH_SERVER_MANAGEMENT_KEY'],
    applies: 'serve-arg',
    secret: true,
    summary: '管理面（/v0/webui、/v0/management、远程重启、中转服务）所需的 key。空 = 管理面关闭。',
    samples: [{ args: ['--management-key', 'mk-test'], expect: 'mk-test' }],
    clear: { expect: '' }
  },
  {
    key: 'modelsProbeAccounts',
    group: '模型探测',
    flag: '--models-probe-accounts <1..8>',
    type: 'int',
    min: 1,
    max: 8,
    default: 2,
    env: [],
    applies: 'serve-arg',
    summary: '每次模型目录刷新时并发探测的账号数。调大更快但也更容易吃到上游限流。',
    samples: [{ args: ['--models-probe-accounts', '4'], expect: 4 }]
  },
  {
    key: 'windowActivation',
    group: '窗口激活',
    flag: '--window-activation|--no-window-activation',
    type: 'bool',
    env: [],
    applies: 'serve-arg',
    summary: '窗口激活的全局闸门（还要在账号页逐账号打开）。默认关：每次探测都是一次真实上游请求。',
    samples: [
      { args: ['--window-activation'], expect: true },
      { args: ['--no-window-activation'], expect: false }
    ]
  },
  {
    key: 'windowActivationDefaultIntervalMs',
    group: '窗口激活',
    flag: '--window-activation-default-interval-ms <ms>',
    type: 'duration',
    min: 60000,
    max: 31536000000,
    default: 3600000,
    env: [],
    applies: 'serve-arg',
    summary: '观察不到窗口时的兜底探测间隔（≥ 1 分钟）。能观察到窗口的账号按关窗时刻续窗，不看这个值。',
    samples: [{ args: ['--window-activation-default-interval-ms', '7200000'], expect: 7200000 }]
  },
  {
    key: 'windowActivationMinIntervalMs',
    group: '窗口激活',
    flag: '--window-activation-min-interval-ms <ms>',
    type: 'duration',
    min: 60000,
    max: 31536000000,
    default: 3600000,
    env: [],
    applies: 'serve-arg',
    summary: '探测间隔下限。逐账号设置的间隔不得小于它（小于会被拒绝，不会被静默抬高）。',
    samples: [{ args: ['--window-activation-min-interval-ms', '1800000'], expect: 1800000 }]
  },
  {
    key: 'goCoreEnabled',
    group: '路由与 Go Core',
    flag: '--go-core|--no-go-core',
    type: 'bool',
    env: ['AIH_GO_CORE_ENABLED'],
    applies: 'runtime',
    summary: '是否由 Go Core 承接数据面。需要已构建的 aih-server 工件（npm run go:build）。',
    samples: [
      { args: ['--go-core'], expect: true },
      { args: ['--no-go-core'], expect: false }
    ]
  },
  {
    key: 'goCoreRoutes',
    group: '路由与 Go Core',
    flag: '--go-core-routes <entry-ids>',
    clearFlag: '--clear-go-core-routes',
    type: 'csv',
    env: ['AIH_GO_CORE_ROUTES'],
    applies: 'runtime',
    summary: '由 Go 承接的 route-ownership 条目 ID（逗号分隔）。空 = 全部走 Node；写错条目在启动时直接失败（fail closed）。',
    samples: [{ args: ['--go-core-routes', 'a,b'], expect: ['a', 'b'] }],
    clear: { expect: [] }
  },
  {
    key: 'upstreamErrorRuleProviders',
    group: '路由与 Go Core',
    flag: '--upstream-error-rules <providers>',
    clearFlag: '--clear-upstream-error-rules',
    type: 'csv',
    env: ['AIH_SERVER_UPSTREAM_ERROR_RULES'],
    applies: 'runtime',
    summary: '哪些 Provider 的账号自定义上游错误规则交给 Go 执行（小写、逗号分隔）。空 = 全部规则仍在 Node 求值。',
    samples: [{ args: ['--upstream-error-rules', 'Codex, AGY'], expect: ['codex', 'agy'] }],
    clear: { expect: [] }
  },
  {
    key: 'relayUdp',
    group: '中转',
    flag: '--relay-udp on|off|default',
    type: 'enum',
    values: ['default', 'on', 'off'],
    env: ['AIH_RELAY_SETTINGS'],
    applies: 'process-env',
    summary: '中转 UDP：on = 在同一个端口号的 UDP 侧承接 SOCKS5 UDP ASSOCIATE（QUIC/HTTP3 可用），off = 只放行 TCP，default = 跟随环境变量/默认开。',
    samples: [{ args: ['--relay-udp', 'off'], expect: 'off' }]
  },
  {
    key: 'relayUdpAdvertiseHost',
    group: '中转',
    flag: '--relay-udp-advertise-host <host>',
    clearFlag: '--clear-relay-udp-advertise-host',
    type: 'ip',
    env: ['AIH_RELAY_SETTINGS'],
    applies: 'process-env',
    summary: '播报给客户端的 UDP 入口主机（NAT / frp / 公网映射时填外部地址）。空 = 自动推断。',
    samples: [{ args: ['--relay-udp-advertise-host', '203.0.113.9'], expect: '203.0.113.9' }],
    clear: { expect: '' }
  },
  {
    key: 'relayUdpAdvertisePort',
    group: '中转',
    flag: '--relay-udp-advertise-port <1..65535>',
    clearFlag: '--clear-relay-udp-advertise-port',
    type: 'port',
    min: 1,
    max: 65535,
    env: ['AIH_RELAY_SETTINGS'],
    applies: 'process-env',
    summary: '播报给客户端的 UDP 端口（外部端口与本地不同时用）。0 / 清空 = 与 AIH 端口相同。',
    samples: [{ args: ['--relay-udp-advertise-port', '29527'], expect: 29527 }],
    clear: { expect: 0 }
  },
  {
    key: 'relayPortMode',
    group: '中转',
    flag: '--relay-port-mode server|dedicated|default',
    type: 'enum',
    values: ['default', 'server', 'dedicated'],
    env: ['AIH_RELAY_SETTINGS'],
    applies: 'process-env',
    summary: '中转端口布局：server = 跟随 AIH 端口做首字节分流（默认，不开新端口，反代需四层透传），dedicated = 每节点一个端口（23100+，需在防火墙/安全组放行）。',
    samples: [{ args: ['--relay-port-mode', 'dedicated'], expect: 'dedicated' }]
  },
  {
    key: 'relayListenHost',
    group: '中转',
    flag: '--relay-listen-host <host>',
    clearFlag: '--clear-relay-listen-host',
    type: 'ip',
    env: ['AIH_RELAY_SETTINGS'],
    applies: 'process-env',
    summary: '中转入口绑定的网卡。空 = 本机请求 127.0.0.1、远端请求 0.0.0.0（并自动启用认证）。',
    samples: [{ args: ['--relay-listen-host', '0.0.0.0'], expect: '0.0.0.0' }],
    clear: { expect: '' }
  },
  {
    key: 'maxAttempts',
    group: '调度',
    flag: '--max-attempts <1..32>',
    clearFlag: '--clear-max-attempts',
    type: 'int',
    min: 1,
    max: 32,
    env: [],
    applies: 'serve-arg',
    zeroMeans: '3',
    summary: '单次请求最多尝试几个账号（同名别名回落也计入）。0 / 清空 = 默认 3。',
    samples: [{ args: ['--max-attempts', '5'], expect: 5 }],
    clear: { expect: 0 }
  }
];

const SERVER_CONFIG_GROUP_ORDER = [...new Set(SERVER_CONFIG_FIELDS.map((field) => field.group))];
const SERVER_CONFIG_FIELD_BY_KEY = new Map(SERVER_CONFIG_FIELDS.map((field) => [field.key, field]));

function getServerConfigField(key) {
  return SERVER_CONFIG_FIELD_BY_KEY.get(String(key || '')) || null;
}

module.exports = {
  SERVER_CONFIG_FIELDS,
  SERVER_CONFIG_GROUP_ORDER,
  getServerConfigField
};

