'use strict';

// **「长期 jwt 直通」套餐的判定**（唯一实现处）。
//
// 为什么单独成模块：同一条事实（「这个套餐用长期 jwt 作推理凭据」）有两个消费方 ——
//   * `upstream-credential-resolver`：决定**用哪个 token**（jwt 直通，不换取业务 token）；
//   * `relay-auth-headers`：决定**鉴权头形态**（单头 `Authorization: Bearer <jwt>`，
//     而不是 access_token + X-Zcode-Authorization 双头）。
// 两者必须同源，否则会出现「拿 jwt 去拼双头」这种自相矛盾的请求。
//
// 判定面是描述符声明的 `relay.auth.jwtPlanKinds` 与账号快照里的 plan_id / 展示名：
//   * plan_id（事实）优先：`zcode-v3-start-plan-1024` 一眼可判；
//   * 展示名只作兜底：真机教训是 phone 账号的展示名是 "ZCode 1024 Dev Day"，
//     不含任何 start-plan 字样，只看展示名会判 false。
// 不写 provider 名，也不写死具体套餐名。

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 该账号是否属于「直接用长期 jwt 推理」的套餐类型。
 *
 * @param {object} account 运行池账号（需带 planIds / planType / 长期 jwt 字段）
 * @param {object} auth    描述符的 relay.auth 声明（需带 jwtPlanKinds / extraTokenField）
 * @returns {boolean}
 */
function isJwtPlanAccount(account, auth) {
  const kinds = Array.isArray(auth && auth.jwtPlanKinds) ? auth.jwtPlanKinds : [];
  if (kinds.length === 0) return false;
  const planIds = Array.isArray(account && account.planIds)
    ? account.planIds.map((id) => normalizeText(id).toLowerCase()).filter(Boolean)
    : [];
  const planText = normalizeText(account && (account.planType || account.plan)).toLowerCase();
  const matches = (haystacks) => kinds.some((kind) => {
    const needle = normalizeText(kind).toLowerCase();
    if (!needle) return false;
    // plan_id 用连字符（start-plan），展示名用空格（Start Plan），两种都认。
    const spaced = needle.replace(/-/g, ' ');
    return haystacks.some((text) => text.includes(needle) || text.includes(spaced));
  });
  // 1) 套餐事实（plan_id）或展示名命中声明的套餐类型 → jwt 直通。
  if (matches([...planIds, planText].filter(Boolean))) return true;
  // 2) **没有 plan_id** 时按 jwt 直通处理。判据必须是「planIds 为空」而不是
  //    「所有套餐文本为空」—— 真机教训：这些账号的 planType 字段被写成了
  //    'oauth'（非空但没有任何套餐语义），若把它算作「已有套餐信息」，
  //    兜底就永远不触发，于是拿过期的 access_token 去拼双头 → 上游 401
  //    （空正文），再被判成 auth_invalid（1 年冷却）。
  //    理由不是猜：换取业务 token 需要**有效**的 access_token，而这类账号普遍
  //    不持有 refresh_token（真机：凭据里只有 access_token / zcodejwttoken /
  //    user_info），access_token 一过期就再也换不出来；长期 jwt 是唯一还能用的凭据。
  //    端点侧同理（resolveZcodeInferenceBaseUrl 的未知套餐兜底），两者必须同源。
  if (planIds.length === 0) {
    const jwtField = normalizeText(auth && auth.extraTokenField) || 'zcodeJwtToken';
    return Boolean(normalizeText(account && (account[jwtField] || account.jwtToken)));
  }
  // 3) 有 plan_id 但不属于声明的套餐类型（例：coding plan）→ 不是 jwt 直通。
  return false;
}

module.exports = { isJwtPlanAccount };
