'use strict';

// ZCode 的「区域」是**上游 provider 维度**，不是 hostname 维度 —— 这是本模块存在的唯一理由。
//
// 实测（2026-10-24）：
//   * `POST /api/v1/oauth/cli/init {"provider":"zai"}` 返回
//       https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg
//         &redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai&state=…
//   * `POST /api/v1/oauth/cli/init {"provider":"bigmodel"}` 返回
//       https://bigmodel.cn/login?appId=zcode
//         &redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel&state=…
//   两者 flow_id / poll 通道完全同构，只有授权入口与凭据键前缀不同。
//
// 而 `https://zchat.z.ai/` 与 `https://chat.z.ai/` 是**同一个服务的两个域名**：
// 同样的 client_id 校验、同样 307 到 `/auth`、同样接受官方 redirect_uri。
// 它**不是**另一个 region —— 区域由上面的 `provider` 字段决定。
// （`zchat.z.ai` 因此不单独建模；真要用它，见 rewriteZcodeAuthorizeOrigin。）
//
// 凭据键前缀随 provider 走（桌面端同一套命名）：
//   oauth:zai:access_token / oauth:zai:refresh_token / oauth:zai:user_info
//   oauth:bigmodel:access_token / oauth:bigmodel:refresh_token / oauth:bigmodel:user_info
// `zcodejwttoken` 与 `oauth:active_provider` 两个键与区域无关，两者共用。

const ZCODE_REGION_PROVIDER_IDS = Object.freeze(['zai', 'bigmodel']);

const ZCODE_DEFAULT_REGION = 'zai';

// 凭据键只在这里拼装一次：新增区域 = 加一行表项，不在别处写 `if (region === …)`。
//
// `apiOrigin` / `bizAuthScheme` 供「Project Access Token 定位」用
// （见 lib/server/zcode-project-key-location.js）：
//   * apiOrigin 是 biz 面（`/api/biz/...`）的 host —— 它与 authorizeOrigin 不同
//     （zai 授权在 chat.z.ai、biz 在 api.z.ai），所以单独一列，不复用 authorizeOrigin；
//   * bizAuthScheme 是 Authorization 头的形态：zai 用 `Bearer <token>`，
//     bigmodel 用**裸 token**（桌面端 `family === 'zai' ? 'Bearer ' + token : token`）。
//     这是区域属性，不是需要分支的判断。
const ZCODE_REGION_TABLE = Object.freeze({
  zai: Object.freeze({
    provider: 'zai',
    label: 'Z.AI（国际站）',
    authorizeOrigin: 'https://chat.z.ai',
    apiOrigin: 'https://api.z.ai',
    bizAuthScheme: 'bearer',
    accessTokenKey: 'oauth:zai:access_token',
    refreshTokenKey: 'oauth:zai:refresh_token',
    userInfoKey: 'oauth:zai:user_info'
  }),
  bigmodel: Object.freeze({
    provider: 'bigmodel',
    label: 'BigModel（国内站）',
    authorizeOrigin: 'https://bigmodel.cn',
    apiOrigin: 'https://bigmodel.cn',
    bizAuthScheme: 'raw',
    accessTokenKey: 'oauth:bigmodel:access_token',
    refreshTokenKey: 'oauth:bigmodel:refresh_token',
    userInfoKey: 'oauth:bigmodel:user_info'
  })
});

function normalizeString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 把任意输入（provider id / 用户输入 / 旧别名）归一成区域描述符。
 * 未知值回落到默认区域（与上游 cli/init 的默认行为一致），不抛错 ——
 * 区域只是入口选择，不该让一次登录整体失败。
 */
function resolveZcodeRegion(value) {
  const normalized = normalizeString(value);
  return ZCODE_REGION_TABLE[normalized] || ZCODE_REGION_TABLE[ZCODE_DEFAULT_REGION];
}

function listZcodeRegions() {
  return ZCODE_REGION_PROVIDER_IDS.map((id) => ZCODE_REGION_TABLE[id]);
}

/**
 * 授权入口覆盖：让用户把授权页指到镜像域名（例如大陆网络下把 chat.z.ai 换成 zchat.z.ai）。
 *
 * 只替换**授权入口**的 origin；`redirect_uri`、`state`、`client_id` 等查询参数原样保留
 * —— 回调仍由 zcode.z.ai 官方地址接收，token 交换仍走 zcode.z.ai，因此不改变流程语义。
 * 上游 cli/init 不接受区域/镜像参数（实测 site/region/origin 都被忽略），
 * 所以镜像只能在客户端这一侧改写。
 */
function rewriteZcodeAuthorizeOrigin(authorizeUrl, originOverride) {
  const override = String(originOverride || '').trim();
  const raw = typeof authorizeUrl === 'string' ? authorizeUrl.trim() : '';
  if (!override || !raw) return raw;
  let overrideUrl;
  let parsed;
  try {
    overrideUrl = new URL(override);
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  // 只接受 http(s)，且必须是纯 origin（带路径说明调用方给错了东西，宁可不改）。
  if (!['http:', 'https:'].includes(overrideUrl.protocol)) return raw;
  if (overrideUrl.pathname !== '/' || overrideUrl.search || overrideUrl.hash) return raw;
  parsed.protocol = overrideUrl.protocol;
  parsed.host = overrideUrl.host;
  return parsed.toString();
}

module.exports = {
  ZCODE_REGION_PROVIDER_IDS,
  ZCODE_DEFAULT_REGION,
  ZCODE_REGION_TABLE,
  resolveZcodeRegion,
  listZcodeRegions,
  rewriteZcodeAuthorizeOrigin
};
