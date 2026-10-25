'use strict';

// ZCode 的「Project Access Token 定位信息」——记下**用哪个 org/project/apiKey 去签发 PAT**。
//
// 桌面端在 credentials.json 里存一个 `project-key-location:v1:<encoded JSON>` 键，值是
// `{organizationId, projectId, apiKeyId}`。缺了它，每次推理都要重新发现一遍 org/project/
// apiKey（多两次上游往返），上游抖动时直接表现为推理失败。aih 此前不写这个键，因此补上。
//
// 本模块只做「发现 + 组装键值」，不认识任何 provider 名：
//   * 区域 origin 与 biz API 的 Authorization 形态由调用方按**区域描述符**传入
//     （见 lib/server/zcode-region.js 的 apiOrigin / bizAuthScheme）——
//     桌面端 zai 用 `Bearer <token>`、bigmodel 用裸 token，这个差异是区域属性，不是分支；
//   * 登录凭据由调用方传入，本模块不读磁盘、不碰账号库、不写文件；
//   * 失败一律返回 null，原因只经 `observe` 上报 —— 它只是登录流程的**附加产物**，
//     拿不到不该阻断登录。
//
// 上游协议（逆向 ZCode Desktop 3.16.3 app.asar 的 ProjectAccessTokenClient，2026-10-25 复核）：
//   a) GET  ${origin}/api/biz/customer/getCustomerInfo
//        → { code, data: { customerNumber, organizations: [{ organizationId, organizationName,
//            projects: [{ projectId, projectName, projectType }] }] } }
//   b) GET  ${origin}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys
//        → 取 `name === 'zcode-api-key'` 那条的 **apiKey 字段**（它存的就是 apiKeyId）；
//          没有则 POST 同 URL，body `{ name: 'zcode-api-key', usageScene: 1 }`
//   （c：用 apiKeyId 签 PAT 的那一步不在本模块范围内 —— PAT 是短期凭据，内存持有，不落盘。）

const { isSuccessfulBusinessCode } = require('./business-token-resolver');

const DEFAULT_TIMEOUT_MS = 15_000;
// 桌面端 `di.CODING_PLAN`：键数组第 5 位与建 key 的 usageScene 用的是同一个常量。
const CODING_PLAN_USAGE_SCENE = 1;
// 桌面端个人项目的 key 名（团队模式是 'zcode-team-api-key'，本模块不覆盖）。
const ZCODE_API_KEY_NAME = 'zcode-api-key';
const NON_TEAM_SELECTION = 'non-team';
// 默认机构/项目常量（桌面端 rF / iF）：同名命中优先，否则取第一个。
const DEFAULT_ORGANIZATION_NAME = '默认机构';
const DEFAULT_PROJECT_NAME = '默认项目';
// 桌面端个人默认选择会排除 projectType === '2'（团队项目）。
const TEAM_PROJECT_TYPE = '2';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function projectKeyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** 归一成 URL origin；无法解析时返回空串（宁可不写这个键，也不写一个错 origin）。 */
function normalizeOrigin(value) {
  const raw = normalizeString(value);
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

/**
 * 组装桌面端同款键名：`project-key-location:v1:<encodeURIComponent(JSON.stringify([...]))>`。
 *
 * 数组六个位置是协议本身，顺序不可改：
 *   [origin, family, accountId, team ?? null, CODING_PLAN, personalProjectSelection ?? 'non-team']
 * team 非空时个人选择位恒为 null（团队项目不做个人默认选择），与桌面端同构。
 */
function buildZcodeProjectKeyLocationKey(options = {}) {
  const origin = normalizeOrigin(options.origin);
  const family = normalizeString(options.family);
  const accountId = normalizeString(options.accountId);
  const team = isPlainObject(options.team)
    ? {
      organizationId: normalizeString(options.team.organizationId),
      projectId: normalizeString(options.team.projectId)
    }
    : null;
  const personalProjectSelection = team
    ? null
    : (normalizeString(options.personalProjectSelection) || NON_TEAM_SELECTION);
  const tuple = [origin, family, accountId, team, CODING_PLAN_USAGE_SCENE, personalProjectSelection];
  return `project-key-location:v1:${encodeURIComponent(JSON.stringify(tuple))}`;
}

/**
 * biz API 的 Authorization 头。scheme 由区域描述符声明：
 *   'bearer' → `Bearer <token>`（zai）；其它/缺省 → 裸 token（bigmodel）。
 * 与桌面端一致：先剥掉 token 上可能带的 `Bearer ` 前缀，再按区域重新拼。
 */
function buildAuthorizationHeader(loginToken, authScheme) {
  const token = normalizeString(loginToken).replace(/^Bearer\s+/i, '');
  return normalizeString(authScheme) === 'bearer' ? `Bearer ${token}` : token;
}

/**
 * 个人项目的机构/项目选择（桌面端 `#n` 的非团队分支）：
 * 排除团队项目 → 优先「默认机构」/「默认项目」→ 否则取第一个。
 */
function selectPersonalProject(customerInfo, personalProjectSelection) {
  const organizations = Array.isArray(customerInfo && customerInfo.organizations)
    ? customerInfo.organizations.filter(isPlainObject)
    : [];
  const candidates = personalProjectSelection === 'default'
    ? organizations.map((organization) => ({
      ...organization,
      projects: (Array.isArray(organization.projects) ? organization.projects : []).filter(isPlainObject)
    }))
    : organizations
      .map((organization) => ({
        ...organization,
        projects: (Array.isArray(organization.projects) ? organization.projects : [])
          .filter(isPlainObject)
          .filter((project) => String(project.projectType === null || project.projectType === undefined ? '' : project.projectType).trim() !== TEAM_PROJECT_TYPE)
      }))
      .filter((organization) => normalizeString(organization.organizationId) && organization.projects.length > 0);
  const organization = candidates.find((item) => normalizeString(item.organizationName).includes(DEFAULT_ORGANIZATION_NAME))
    || candidates[0];
  const projects = organization && Array.isArray(organization.projects) ? organization.projects : [];
  const project = projects.find((item) => normalizeString(item.projectName).includes(DEFAULT_PROJECT_NAME)) || projects[0];
  const organizationId = normalizeString(organization && organization.organizationId);
  const projectId = normalizeString(project && project.projectId);
  if (!organizationId || !projectId) return null;
  return { organizationId, projectId };
}

/**
 * 建一个 biz API 调用器：统一超时、HTTP 状态与业务码判定，只把 `data` 交给调用方。
 * 上游把「token 过期」也包在 HTTP 200 里（`{code:401,…}`），所以业务码必须查。
 */
function createBizRequester(options = {}) {
  const request = options.request;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  if (typeof request !== 'function') return null;
  return async function bizRequest(url, init = {}) {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const response = await request(url, signal ? { ...init, signal } : init);
    if (!response || response.ok === false) {
      const error = projectKeyError('project_token_request_failed');
      error.status = Number(response && response.status) || 0;
      throw error;
    }
    const rawText = await response.text().catch(() => '');
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }
    if (!isPlainObject(payload)) throw projectKeyError('project_token_invalid_response');
    // 业务码判定复用业务 token 换取器的同一套口径（0/200 数字或字符串，缺省视为成功）。
    if (!isSuccessfulBusinessCode(payload.code)) {
      const error = projectKeyError('project_token_request_failed');
      error.upstreamCode = payload.code;
      throw error;
    }
    return payload.data;
  };
}

/**
 * 取（必要时建）项目下的 zcode-api-key，返回它的 apiKeyId。
 * 找不到即建 —— 与桌面端同策略：个人项目下同名 key 全局唯一，重复建没有意义。
 */
async function resolveApiKeyId({ bizRequest, origin, location, authorization }) {
  const url = `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}`
    + `/projects/${encodeURIComponent(location.projectId)}/api_keys`;
  const headers = {
    Authorization: authorization,
    'Content-Type': 'application/json',
    accept: 'application/json'
  };
  const listed = await bizRequest(url, { method: 'GET', headers });
  const entries = Array.isArray(listed) ? listed.filter(isPlainObject) : [];
  const existing = entries.find((entry) => normalizeString(entry.name) === ZCODE_API_KEY_NAME);
  if (existing) {
    const apiKeyId = normalizeString(existing.apiKey);
    if (!apiKeyId) throw projectKeyError('project_token_invalid_response');
    return apiKeyId;
  }
  const created = await bizRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: ZCODE_API_KEY_NAME, usageScene: CODING_PLAN_USAGE_SCENE })
  });
  const apiKeyId = normalizeString(isPlainObject(created) ? created.apiKey : '');
  if (!apiKeyId) throw projectKeyError('project_token_invalid_response');
  return apiKeyId;
}

/**
 * 解析项目定位键。
 *
 * @param {object} options
 * @param {string} options.origin             biz API origin（区域描述符的 apiOrigin）
 * @param {string} options.family             区域 family（zai / bigmodel），只作数据，不作分支
 * @param {string} options.accountId          账号 ID（账号身份的 id）
 * @param {string} options.loginToken         登录凭据（区域 access_token）；`jwtToken` 为同义别名
 * @param {string} [options.authScheme]       区域描述符的 bizAuthScheme：'bearer' | 'raw'
 * @param {function} options.request          (url, init) => Promise<Response>，标准 fetch 形态
 * @param {number} [options.timeoutMs]
 * @param {string} [options.personalProjectSelection]
 * @param {function} [options.observe]        ({ family, stage, code }) => void，只上报原因
 * @returns {Promise<{key: string, value: string}|null>} 失败返回 null，绝不抛错
 */
async function resolveZcodeProjectKeyLocation(options = {}) {
  const observe = typeof options.observe === 'function' ? options.observe : null;
  const family = normalizeString(options.family);
  const report = (code) => {
    if (!observe) return;
    try {
      observe({ family, stage: 'resolve', code });
    } catch {
      // 观测回调不得影响主流程。
    }
  };
  // 团队项目的键形状与建 key 参数都不同（team 对象 + zcode-team-api-key + keyType 2），
  // 本模块只覆盖个人项目；收到团队输入时如实拒绝，而不是写一个错形状的键。
  if (isPlainObject(options.team)) {
    report('project_token_team_unsupported');
    return null;
  }
  const origin = normalizeOrigin(options.origin);
  const loginToken = normalizeString(options.loginToken) || normalizeString(options.jwtToken);
  if (!origin || !family || !loginToken) {
    report('project_token_login_required');
    return null;
  }
  const bizRequest = createBizRequester({ request: options.request, timeoutMs: options.timeoutMs });
  if (!bizRequest) {
    report('project_token_request_unavailable');
    return null;
  }
  const authorization = buildAuthorizationHeader(loginToken, options.authScheme);
  const personalProjectSelection = normalizeString(options.personalProjectSelection) || NON_TEAM_SELECTION;
  try {
    const customerInfo = await bizRequest(`${origin}/api/biz/customer/getCustomerInfo`, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        accept: 'application/json'
      }
    });
    const location = selectPersonalProject(customerInfo, personalProjectSelection);
    if (!location) {
      report('project_token_project_unavailable');
      return null;
    }
    // 账号 ID 优先用账号身份（与桌面端一致：zai 是 userinfo 的 sub、bigmodel 是 customerNumber）；
    // 身份缺失时回落到 getCustomerInfo 的 customerNumber，避免因缺一个字段放弃整个键。
    const accountId = normalizeString(options.accountId)
      || normalizeString(isPlainObject(customerInfo) ? customerInfo.customerNumber : '');
    if (!accountId) {
      report('project_token_account_unresolved');
      return null;
    }
    const apiKeyId = await resolveApiKeyId({ bizRequest, origin, location, authorization });
    return {
      key: buildZcodeProjectKeyLocationKey({
        origin,
        family,
        accountId,
        team: null,
        personalProjectSelection
      }),
      value: JSON.stringify({ ...location, apiKeyId })
    };
  } catch (error) {
    report(normalizeString(error && error.code) || 'project_token_request_failed');
    return null;
  }
}

module.exports = {
  CODING_PLAN_USAGE_SCENE,
  DEFAULT_TIMEOUT_MS,
  NON_TEAM_SELECTION,
  ZCODE_API_KEY_NAME,
  buildAuthorizationHeader,
  buildZcodeProjectKeyLocationKey,
  resolveZcodeProjectKeyLocation,
  selectPersonalProject
};
