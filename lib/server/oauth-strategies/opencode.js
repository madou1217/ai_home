'use strict';

const { DEFAULT_STRATEGY } = require('./base');

// OpenCode Console 登录 = 官方 CLI 的**设备码**流程（2026-10-29 真机取证）：
//   `opencode auth login opencode --method device`
//   - 方法枚举（用非法值触发）：`Available: device, key`；
//   - `--standalone` **必须加**：v2 默认连 channel 固定的后台 service（端口 49374），
//     已有实例在跑时登录进程直接失败（实测 `Managed service port 49374 ... already in use`）；
//   - 凭据**不落 auth.json**，而是落 `<data>/opencode.db` 的 `credential` 表
//     （`integration_id='opencode'`、`value.type='oauth'`、`metadata{accountID,email,orgID,…}`），
//     因此登录成功后由 `lib/account/opencode-native-credential-sync.js` 的宿主观察者登记成账号。
const OPENCODE_DEVICE_STRATEGY = {
  ...DEFAULT_STRATEGY,

  buildLoginArgs({ baseArgs = [] } = {}) {
    const args = Array.isArray(baseArgs) ? baseArgs.slice() : [];
    const has = (flag) => args.includes(flag);
    if (!has('auth')) args.push('auth');
    if (!has('login')) args.push('login');
    if (!args.includes('opencode')) args.push('opencode');
    if (!has('--method')) args.push('--method', 'device');
    if (!has('--standalone')) args.push('--standalone');
    return args;
  }
};

const OPENCODE_STRATEGY = {
  ...OPENCODE_DEVICE_STRATEGY,
  // 契约里的 authOption 声明 `strategy: 'opencode:device'`；这里给 default 兜底，
  // 于是任何请求名（含未登记的历史值）都解析到设备码策略。
  default: OPENCODE_DEVICE_STRATEGY,
  'opencode:device': OPENCODE_DEVICE_STRATEGY
};

module.exports = {
  OPENCODE_STRATEGY,
  OPENCODE_DEVICE_STRATEGY
};

