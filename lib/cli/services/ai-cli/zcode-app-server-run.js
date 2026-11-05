'use strict';

// ZCode 的 **headless 单次问答**（`aih zcode <id> -p <prompt>`）—— 走官方 **app-server** 通道。
//
// 为什么不能直接让 CLI 自己的 `-p` 干：standalone CLI 的账号 provider 枚举（`ejn()`）写死
// `access.mode === 'individual-coding-plan'`，start-plan 账号在 standalone 下注册表为空 →
// `-p` 报 "Select a model before sending a message"（详见 AGENTS.md 的 zcode 条目）。
// app-server 模式下宿主可以**声明账号 provider**（`provider/updateAccountConfig`），
// 于是官方客户端会照常发请求并完成整轮 —— 实测 `model.network.completed` + `finishReason:stop`
// + `turn.completed`。
//
// 协议要点（全部真机取证，逐字见 AGENTS.md）：
//   * 报文信封是裸 `{id,method,params}`（**不带 jsonrpc**）；
//   * 必须应答的反向请求：`session/requestRuntimePreferences`（schema `Utn`）、
//     `interaction/requestProviderRuntimeHeaders`（`{headersApplied:true,requestAuth:{apiKey,apiKeyId}}`：
//     start-plan/off-peak/highspeed 送 zcode JWT；coding-plan 必须送**换来的
//     Project Access Token**——登录态里的业务 access_token 不是 PAT，直接当 apiKey
//     会让 SDK 报 `Client signing requires an API Key or Project Access Token`）、
//     `interaction/requestPermission`；
//   * 顺序：`provider/updateAccountConfig` → `provider/refreshRegistry` → `session/create`
//     → `session/resume` → **`session/setMode`**（缺它 turn 不启动）→ `session/send`
//     （带 `modelSelection`）；
//   * 答案不从这里读：`session/messages` 只有用户消息，助手文本落在
//     `<hostHome>/.zcode/cli/db/db.sqlite` 的 `message`/`part` 表里，用
//     `lib/sessions/zcode-session-store.js` 的 `readZcodeSessionMessages` 读（唯一读取器）。
//   * **turn 的成败从 v4 遥测通知读**：`v4/conversation/frame` / `v4/telemetry/event`
//     在 stdio 上照常推送（真机 2026-10-31 抓包：订阅后先收到 initial/online 两帧，
//     随后 `turn-started`、`model.request.status`、`turn.terminal` 依次到达），
//     不需要额外的 WebSocket hello 帧。`turn.terminal.status=failed` 时立刻带
//     `errorCode`/`errorMessage` 返回，避免把「上游有原因的失败」拖成静默超时。

const { spawn } = require('node:child_process');
const nodeCrypto = require('node:crypto');
const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { readZcodeSessionMessages } = require('../../../sessions/zcode-session-store');
const { decryptZcodeCredentialRecord, readZcodeLiveOAuthCredential } = require('../../../account/zcode-credential');
const { readAccountCredentialRecord } = require('../../../server/account-credential-store');
const { resolveZcodeRegion } = require('../../../server/zcode-region');
const {
  NON_TEAM_SELECTION,
  buildZcodeProjectKeyLocationKey,
  resolveZcodeProjectAccessToken,
  resolveZcodeProjectKeyLocation
} = require('../../../server/zcode-project-key-location');
const { createZcodeConversationStream } = require('./zcode-conversation-stream');

const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  toolSearchMode: 'off',
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1'
});

const ACCEPTED_V4_COMMAND_STATUSES = new Set(['accepted', 'duplicate', 'noop']);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * v4 command ACKs are structured results, not JSON-RPC errors.  In particular,
 * a command can return `status: "failed"` with `reasonCode: "modelUnavailable"`
 * while the transport-level response has no `error` field.  Treat every
 * non-success ACK as a failure so an unavailable model cannot degrade into a
 * misleading headless timeout.
 */
function assertV4CommandAckOk(commandType, response) {
  const envelope = response && typeof response === 'object' ? response : {};
  if (envelope.error) {
    throw new Error(`v4/command ${commandType} 被拒: ${JSON.stringify(envelope.error).slice(0, 200)}`);
  }
  // RPC 回包信封是 `{id, result}`，ACK 本体（status/reasonCode/message）在 `result` 里，
  // 不在顶层（真机 2026-10-31 抓包：`{"id":3,"result":{"status":"accepted",…}}`）。
  // 读顶层会把每一个成功 ACK 误判成 `ack_missing_status`；同时保留裸 ACK 形状兼容。
  const ack = envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope;
  const status = normalizeText(ack.status);
  if (!status) {
    throw new Error(`v4/command ${commandType} 被拒: ack_missing_status`);
  }
  if (ACCEPTED_V4_COMMAND_STATUSES.has(status)) return ack;
  const reasonCode = normalizeText(ack.reasonCode);
  const message = normalizeText(ack.message);
  const detail = `${status}${reasonCode ? ` (${reasonCode})` : ''}${message ? `: ${message}` : ''}`;
  throw new Error(`v4/command ${commandType} 被拒: ${detail.slice(0, 240)}`);
}

/**
 * 解析 requestAuth 用的 Project Access Token 身份：PAT 是 JWT，payload 里的
 * `api_key` 就是 apiKeyId（bundle `nPr` 的同一判据）。
 */
function parseProjectAccessTokenIdentity(value) {
  const token = normalizeText(value);
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[2]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const apiKeyId = normalizeText(payload && payload.api_key);
    return apiKeyId ? { apiKeyId } : null;
  } catch (_error) {
    return null;
  }
}

/** 桌面端 `#t` 的同一口径：登录态变化会让 scope 变化，CLI 据此判断是否需要重取 token。 */
function buildZcodeAccountScope({ family, planMode, oauth }) {
  return nodeCrypto.createHash('sha256').update(JSON.stringify([
    family,
    planMode,
    null,
    normalizeText(oauth && oauth.accessToken),
    normalizeText(oauth && oauth.jwtToken) || null
  ])).digest('hex');
}

/** 解密一份 credentials.json（live 或 DB 快照）；失败返回空对象。 */
function readZcodePlainCredentialMap(fsImpl, aiHomeDir, accountRef, credential) {
  const candidates = [];
  if (credential && credential.liveCredentials && typeof credential.liveCredentials === 'object') {
    candidates.push(credential.liveCredentials);
  }
  if (aiHomeDir && accountRef) {
    try {
      const record = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
      const raw = record && record.nativeAuth && record.nativeAuth.credentials;
      if (raw && typeof raw === 'object') candidates.push(raw);
    } catch (_error) {
      // 读不到 DB 快照时仍可用 live 文件。
    }
  }
  for (const candidate of candidates) {
    try {
      const plain = decryptZcodeCredentialRecord(candidate);
      if (plain && Object.keys(plain).length > 0) return plain;
    } catch (_error) {
      // 密钥不匹配等：换下一份候选。
    }
  }
  return {};
}

function parseStoredProjectLocation(credentials, key) {
  const value = credentials && typeof credentials === 'object' ? credentials[key] : '';
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    const organizationId = normalizeText(parsed && parsed.organizationId);
    const projectId = normalizeText(parsed && parsed.projectId);
    const apiKeyId = normalizeText(parsed && parsed.apiKeyId);
    return organizationId && projectId && apiKeyId ? { organizationId, projectId, apiKeyId } : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 在凭据里找现成的项目定位。先试精确键，再按**键里的六元组**匹配
 * （origin/family/accountId/team）—— 桌面端同时存 `non-team` 与 `default` 两个
 * personalProjectSelection，值相同；只认精确键会白白多打两次上游。
 */
function findStoredProjectLocation(credentials, input = {}) {
  if (!credentials || typeof credentials !== 'object') return null;
  const origin = normalizeText(input.origin);
  const family = normalizeText(input.family);
  const accountId = normalizeText(input.accountId);
  const team = input.team && typeof input.team === 'object'
    ? {
      organizationId: normalizeText(input.team.organizationId),
      projectId: normalizeText(input.team.projectId)
    }
    : null;
  const exactKey = buildZcodeProjectKeyLocationKey({
    origin,
    family,
    accountId,
    team,
    personalProjectSelection: team ? undefined : NON_TEAM_SELECTION
  });
  const exact = parseStoredProjectLocation(credentials, exactKey);
  if (exact) return exact;
  for (const key of Object.keys(credentials)) {
    if (!key.startsWith('project-key-location:v1:')) continue;
    let tuple = null;
    try {
      tuple = JSON.parse(decodeURIComponent(key.slice('project-key-location:v1:'.length)));
    } catch (_error) {
      continue;
    }
    if (!Array.isArray(tuple)) continue;
    if (normalizeText(tuple[0]) !== origin) continue;
    if (normalizeText(tuple[1]) !== family) continue;
    if (normalizeText(tuple[2]) !== accountId) continue;
    const storedTeam = tuple[3] && typeof tuple[3] === 'object' ? tuple[3] : null;
    if (team) {
      if (!storedTeam
        || normalizeText(storedTeam.organizationId) !== team.organizationId
        || normalizeText(storedTeam.projectId) !== team.projectId) continue;
    } else if (storedTeam) {
      continue;
    }
    const parsed = parseStoredProjectLocation(credentials, key);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 为一次 app-server turn 解析 `requestAuth`。
 *
 * 三种凭据形态（桌面端 AccountProviderRequestAuthService 的实际分叉）：
 *   1. start-plan / off-peak / highspeed：SDK 不做客户端签名，直接送 zcode JWT；
 *   2. access_token 本身已是 PAT（payload.api_key）：直接当 apiKey；
 *   3. individual/team coding-plan：先用登录态换取 **Project Access Token**
 *      （定位 org/project/apiKey → 调 access_tokens 签发）。把裸业务 token 塞进
 *      apiKey 会让 SDK 报 `Client signing requires an API Key or Project Access Token`
 *      （2026-11-04 账号 1 真机根因）。
 *
 * @returns {Promise<{ok: boolean, auth?: object, error?: string}>}
 */
async function resolveZcodeProviderRequestAuth(input = {}) {
  const oauth = input.oauth && typeof input.oauth === 'object' ? input.oauth : {};
  const planMode = normalizeText(input.planMode);
  const accessToken = normalizeText(oauth.accessToken);
  const jwtToken = normalizeText(oauth.jwtToken);
  const family = normalizeText(oauth.activeProvider) || 'zai';

  if (/start-plan|off-peak|highspeed/i.test(planMode)) {
    return jwtToken
      ? { ok: true, auth: { apiKey: jwtToken } }
      : { ok: false, error: 'missing_zcode_jwt' };
  }
  const direct = parseProjectAccessTokenIdentity(accessToken);
  if (direct) {
    return {
      ok: true,
      auth: {
        apiKey: accessToken,
        apiKeyId: direct.apiKeyId,
        accountScope: buildZcodeAccountScope({ family, planMode, oauth })
      }
    };
  }
  if (!accessToken) return { ok: false, error: 'missing_access_token' };
  // 没有套餐形态（例如只有 API-key provider）时保持旧行为，不擅自签发项目 token。
  if (!planMode) return { ok: true, auth: { apiKey: accessToken } };

  const region = resolveZcodeRegion(family);
  const origin = normalizeText(input.origin) || region.apiOrigin;
  const request = typeof input.request === 'function' ? input.request : fetch;
  const accountId = normalizeText(input.accountId)
    || normalizeText(oauth.userInfo && oauth.userInfo.id)
    || normalizeText(oauth.userInfo && oauth.userInfo.rawProfile && oauth.userInfo.rawProfile.user_id);
  const team = input.team && typeof input.team === 'object'
    ? {
      organizationId: normalizeText(input.team.organizationId),
      projectId: normalizeText(input.team.projectId)
    }
    : null;
  let lastCode = '';
  const observe = (event) => {
    if (event && event.code) lastCode = String(event.code);
    if (typeof input.observe === 'function') {
      try {
        input.observe(event);
      } catch (_error) {
        // 观测回调不得影响主流程。
      }
    }
  };

  let location = findStoredProjectLocation(input.plainCredentials, {
    origin, family, accountId, team
  });
  // 团队项目的定位发现（getCustomerInfo + 团队 key 校验/创建）未实现；有缓存定位
  // 就能签发，没有就如实报错，绝不拿个人项目 token 冒充团队。
  if (!location && !team) {
    const resolved = await resolveZcodeProjectKeyLocation({
      origin,
      family,
      accountId,
      loginToken: accessToken,
      authScheme: region.bizAuthScheme,
      request,
      timeoutMs: input.timeoutMs,
      observe
    });
    if (resolved) {
      try {
        const parsed = JSON.parse(resolved.value);
        location = parsed && parsed.organizationId && parsed.projectId && parsed.apiKeyId
          ? parsed
          : null;
      } catch (_error) {
        location = null;
      }
    }
  }
  if (!location) return { ok: false, error: lastCode || 'project_token_location_unresolved' };

  const material = await resolveZcodeProjectAccessToken({
    origin,
    loginToken: accessToken,
    organizationId: location.organizationId,
    projectId: location.projectId,
    apiKeyId: location.apiKeyId,
    request,
    timeoutMs: input.timeoutMs,
    clientVersion: input.clientVersion,
    observe
  });
  if (!material) return { ok: false, error: lastCode || 'project_token_mint_failed' };
  return {
    ok: true,
    auth: {
      apiKey: material.token,
      apiKeyId: material.apiKeyId,
      accountScope: buildZcodeAccountScope({ family, planMode, oauth })
    }
  };
}

/**
 * 跑一次 headless 问答。
 *
 * @param {object} input
 * @param {string} input.env             已装配好的 CLI 启动环境（含 ZCODE_DATA_BASE_DIR / HOME / 凭据密钥）
 * @param {string} input.cliPath         bundle 内的 `zcode.cjs`
 * @param {string} input.prompt          提示词
 * @param {string} input.providerId      账号 provider（如 `account:zai-start-plan`）
 * @param {string} input.modelId         模型 id（如 `GLM-5.3-Flash`）
 * @param {string} [input.workspacePath] 工作目录（默认 process.cwd()）
 * @param {string} [input.cliDbPath]     会话库路径（默认 `<hostHome>/.zcode/cli/db/db.sqlite`）
 * @param {number} [input.timeoutMs]     总超时（默认 180000）
 * @param {object} [input.deps]          { spawnImpl, fs, path, aiHomeDir, accountRef, hostHomeDir }
 * @returns {Promise<{ok: boolean, text: string, sessionId: string, error: string}>}
 */
async function runZcodeAppServerPrompt(input = {}) {
  const deps = input.deps || {};
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const spawnImpl = deps.spawnImpl || spawn;
  const env = input.env && typeof input.env === 'object' ? input.env : process.env;
  const cliPath = normalizeText(input.cliPath);
  const prompt = String(input.prompt || '').trim();
  const providerId = normalizeText(input.providerId);
  const modelId = normalizeText(input.modelId);
  const workspacePath = normalizeText(input.workspacePath) || process.cwd();
  const timeoutMs = Number(input.timeoutMs) > 0 ? Math.floor(Number(input.timeoutMs)) : 180000;
  if (!cliPath || !prompt || !providerId || !modelId) {
    return { ok: false, text: '', sessionId: '', error: 'zcode_app_server_input_invalid' };
  }
  const cliDbPath = normalizeText(input.cliDbPath)
    || pathImpl.join(normalizeText(deps.hostHomeDir) || require('node:os').homedir(),
      '.zcode', 'cli', 'db', 'db.sqlite');
  // `basedOnZCodeBuiltinRevision` 必须是**内置 provider 配置的 revision**，否则账号 provider 的
  // overlay 会被注册表丢弃（表现：turn 报 `Provider Registry 中不存在 Provider/Model`）。
  let builtinRevision = normalizeText(input.builtinRevision);
  if (!builtinRevision && normalizeText(input.builtinConfigPath)) {
    try {
      const builtin = JSON.parse(fsImpl.readFileSync(normalizeText(input.builtinConfigPath), 'utf8'));
      builtinRevision = normalizeText(String(builtin && builtin.revision || ''));
    } catch (_error) {
      builtinRevision = '';
    }
  }
  // 凭据形态按套餐分叉（与描述符 `relay.auth.jwtPlanKinds` 同源；逆向桌面端
  // AccountProviderRequestAuthService 的结论）：start-plan / off-peak / highspeed
  // → 长期 zcode jwt 直通；coding-plan 等 → **必须换取 Project Access Token**
  // （登录态里的 access_token 是业务 token，payload 没有 `api_key`，不能直接当
  // requestAuth.apiKey —— 否则 SDK 报 ClientRequestSigningV4Error，见
  // lib/server/zcode-project-key-location.js 的说明）。
  const planMode = normalizeText(input.planMode);
  let credential = null;
  try {
    // DB 快照兜底：live 文件缺失/过期时仍能拿到登录态（此前未传 record，直接空）。
    let record = null;
    try {
      record = readAccountCredentialRecord(fsImpl, deps.aiHomeDir, deps.accountRef);
    } catch (_error) {
      record = null;
    }
    credential = readZcodeLiveOAuthCredential(fsImpl, deps.aiHomeDir, deps.accountRef, record || {});
  } catch (_error) {
    credential = null;
  }
  const oauth = input.oauth && typeof input.oauth === 'object'
    ? input.oauth
    : ((credential && credential.oauth) || {});
  const plainCredentials = input.plainCredentials && typeof input.plainCredentials === 'object'
    ? input.plainCredentials
    : readZcodePlainCredentialMap(fsImpl, deps.aiHomeDir, deps.accountRef, credential);
  // 解析结果按 turn 缓存；CLI 在 token 被拒（401）时会带 rejectedProjectTokenFingerprint
  // 再问一次，此时必须重新签发，不能把同一枚 token 再回一遍。
  // 团队套餐的 org/project 只出现在 requestProviderRuntimeHeaders 的参数里，因此
  // 团队账号不预解析，等第一次请求到达时按 accountAccess 解析。
  const authState = { auth: null, resolved: false, promise: null, error: '', teamKey: '' };
  const readRequestTeam = (params) => {
    const access = params && params.accountAccess;
    if (!access || typeof access !== 'object') return null;
    const organizationId = normalizeText(access.organizationId);
    const projectId = normalizeText(access.projectId);
    return organizationId && projectId ? { organizationId, projectId } : null;
  };
  const resolveRuntimeAuth = (params = {}) => {
    const rejected = normalizeText(params && params.rejectedProjectTokenFingerprint);
    const expectedScope = normalizeText(params && params.expectedAccountScope);
    const team = readRequestTeam(params);
    const teamKey = team ? `${team.organizationId}:${team.projectId}` : '';
    if (authState.teamKey !== teamKey) {
      authState.teamKey = teamKey;
      authState.auth = null;
      authState.resolved = false;
      authState.error = '';
    }
    if (authState.resolved && !rejected && !authState.promise
      && (!expectedScope || expectedScope === normalizeText(authState.auth && authState.auth.accountScope))) {
      return Promise.resolve(authState.auth);
    }
    if (!authState.promise) {
      authState.promise = (async () => {
        let lastCode = '';
        const result = await resolveZcodeProviderRequestAuth({
          planMode,
          oauth,
          plainCredentials,
          team,
          request: typeof deps.fetch === 'function' ? deps.fetch : fetch,
          clientVersion: input.clientVersion,
          observe: (event) => {
            if (event && event.code) lastCode = String(event.code);
          }
        });
        authState.resolved = true;
        authState.promise = null;
        if (result.ok) {
          authState.auth = result.auth;
          authState.error = '';
          return result.auth;
        }
        authState.auth = null;
        authState.error = result.error || lastCode || 'request_auth_unavailable';
        return null;
      })();
    }
    return authState.promise;
  };
  // 先解析一次：失败就直接把原因报出来，别让 CLI 用「签名缺凭据」的泛化错误
  // 把真实原因（定位失败/签发失败）盖掉。团队账号例外（org/project 要等请求参数）。
  const deferredAuth = /team-coding-plan/i.test(planMode);
  const initialAuth = deferredAuth ? null : await resolveRuntimeAuth();
  if (!deferredAuth && (!initialAuth || !normalizeText(initialAuth.apiKey))) {
    return {
      ok: false,
      text: '',
      sessionId: '',
      error: `zcode_app_server_auth_failed:${authState.error || 'missing_request_auth'}`
    };
  }

  // 出站画像整形：CLI 自报的 (bundle 版本, 它自己那版 system) 这一对没被上游放行过，
  // 稳定 3012。这里预加载钩子，把 plan 请求换成缓存里的画像（app 版本 + harness 成对）。
  // 用 argv 的 `--require` 而不是 NODE_OPTIONS：路径含空格时不需要转义。
  const profileHookPath = normalizeText(input.profileHookPath);
  const harnessStorePath = normalizeText(input.harnessStorePath);
  const childEnv = profileHookPath && harnessStorePath
    ? { ...env, AIH_ZCODE_HARNESS_STORE: harnessStorePath }
    : env;
  // CLI bundle 首次 require('node:sqlite') 会打 ExperimentalWarning；它是子进程的
  // 运行时噪音，不能混进 `-p` 的输出。环境里已由启动层注入 NODE_NO_WARNINGS=1，
  // 这里再显式声明一次，覆盖直接调用 driver（测试/其他宿主）的场景。
  const childArgs = profileHookPath
    ? ['--disable-warning=ExperimentalWarning', '--require', profileHookPath, cliPath, 'app-server', '--stdio']
    : ['--disable-warning=ExperimentalWarning', cliPath, 'app-server', '--stdio'];
  const child = spawnImpl(process.execPath, childArgs, {
    env: childEnv, stdio: ['pipe', 'pipe', 'pipe']
  });
  let seq = 0;
  let buffer = '';
  let sessionId = '';
  const pending = new Map();
  // 服务端**通知**（没有 id 的报文）是唯一能说清「为什么没跑起来」的来源
  // （例如 Provider Registry 丢弃了 overlay、模型不可用、turn 失败）。
  // 只留最近若干条，失败时随错误一起上报，不往正常输出里掺日志。
  // turn 的终态只从 v4 遥测通知里读：`turn.terminal` 带 status/errorCode/errorMessage，
  // 是「上游到底为什么没出答案」的唯一结构化来源（例如 3012 节流、1113 无资源包）。
  // 没有它就只能等满 timeout，把「有原因的失败」变成「无原因的静默超时」。
  let turnTerminal = null;
  const serverEvents = [];
  // 流式答案走 v4 会话帧（DB 只在 turn 结束时落盘）；onText 由调用方消费增量。
  const conversationStream = createZcodeConversationStream({
    onText: typeof input.onText === 'function' ? input.onText : null
  });
  const recordEvent = (message) => {
    serverEvents.push({
      method: String(message && message.method || ''),
      params: message && message.params ? message.params : null
    });
    while (serverEvents.length > 12) serverEvents.shift();
  };
  const summarizeEvents = () => {
    if (serverEvents.length === 0) return 'no_server_events';
    const last = serverEvents[serverEvents.length - 1];
    let detail = '';
    try {
      detail = JSON.stringify(last.params || {}).slice(0, 240);
    } catch (_error) {
      detail = '';
    }
    return `${last.method}:${detail}`;
  };
  const send = (method, params) => {
    const id = ++seq;
    const promise = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  };
  const reply = (id, payload) => {
    try {
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch (_error) {
      // 子进程已退出（例如 turn 已失败）：应答丢失不影响已返回的结果。
    }
  };
  const onLine = (line) => {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      return;
    }
    if (message.method && message.id !== undefined) {
      // 宿主侧必须应答的反向请求。
      if (message.method === 'session/requestRuntimePreferences') {
        sessionId = sessionId || normalizeText(message.params && message.params.sessionId);
        reply(message.id, { result: RUNTIME_PREFERENCES });
      } else if (message.method === 'interaction/requestProviderRuntimeHeaders') {
        // 每次 turn/重试都会问一次；带 rejectedProjectTokenFingerprint 时重新签发。
        resolveRuntimeAuth(message.params || {}).then((auth) => {
          if (auth && normalizeText(auth.apiKey)) {
            reply(message.id, { result: { headersApplied: true, requestAuth: auth } });
          } else {
            reply(message.id, {
              result: {
                headersApplied: false,
                errorMessage: `zcode request auth unavailable: ${authState.error || 'unknown'}`
              }
            });
          }
        }).catch(() => {
          reply(message.id, {
            result: { headersApplied: false, errorMessage: 'zcode request auth failed' }
          });
        });
      } else if (message.method === 'interaction/requestPermission') {
        reply(message.id, { result: { decision: 'allow' } });
      } else {
        reply(message.id, { error: { code: -32601, message: 'unsupported' } });
      }
      return;
    }
    if (message.method && message.id === undefined) {
      // 服务端通知：只记录，失败时上报（见 recordEvent）。
      recordEvent(message);
      if (message.method === 'v4/conversation/frame') {
        conversationStream.acceptFrame(message.params && message.params.frame);
      }
      if (message.method === 'v4/telemetry/event') {
        const params = message.params || {};
        if (normalizeText(params.kind) === 'turn.terminal') {
          turnTerminal = {
            status: normalizeText(params.status),
            errorCode: normalizeText(params.errorCode),
            errorMessage: normalizeText(params.errorMessage)
          };
        }
      }
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  });
  return driveZcodeAppServer({
    child, send, timeoutMs, cliDbPath, prompt, providerId, modelId, workspacePath, builtinRevision,
    accountConfig: input.accountConfig,
    summarizeEvents,
    conversationStream,
    emitText: typeof input.onText === 'function' ? input.onText : null,
    getSessionId: () => sessionId,
    getTurnTerminal: () => turnTerminal,
    getAuthError: () => authState.error
  });
}

// 协议时序（与官方桌面宿主一致；`session/setMode` 缺了 turn 不会启动）。
async function driveZcodeAppServer(ctx) {
  const { child, send, timeoutMs, cliDbPath, prompt, providerId, modelId, workspacePath, builtinRevision, getSessionId } = ctx;
  const summarizeEvents = typeof ctx.summarizeEvents === 'function' ? ctx.summarizeEvents : () => 'no_server_events';
  const deadline = Date.now() + timeoutMs;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // RPC 返回里的 `error` 不能吞：账号 provider overlay 被注册表拒绝时，后续每一步都会
  // 以更难定位的方式失败（实测 turn 直接不启动）。这里就地报出来。
  const sendChecked = async (method, params) => {
    const response = await send(method, params);
    if (response && response.error) {
      const message = response.error.message || JSON.stringify(response.error);
      throw new Error(`${method} 被拒: ${String(message).slice(0, 200)}`);
    }
    return response;
  };
  // v4 command 通道：**桌面端真正用来建会话/发消息的那条路**。普通 RPC 的
  // `session/send` 会回 `accepted:true` 却**不启动 runtime**（真机 2026-10-28：只走 RPC 时
  // 一个 `session.*` 事件都不来、会话库不落答案），必须用 v4 command 才会跑。
  const clientId = `aih-client-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const connectionId = `aih-rpc-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const sendCommand = (type, payload, sessionIdForCommand) => send('v4/command', {
    commandId: `aih-cmd-${Math.random().toString(16).slice(2, 10)}-${Date.now()}`,
    clientId,
    sessionId: sessionIdForCommand || null,
    type,
    issuedAt: Date.now(),
    payload
  });
  const modelSelection = { providerId, modelId, options: { reasoningLevel: 'low' } };
  let clockTimer = null;
  try {
    // 账号 provider overlay：调用方给了完整载荷就用它（真机抓包形状，见
    // lib/cli/services/ai-cli/zcode-builtin-release.js），否则退回最小形态。
    await sendChecked('provider/updateAccountConfig', ctx.accountConfig || {
      revision: `aih-${Date.now()}`,
      basedOnZCodeBuiltinRevision: builtinRevision,
      providers: { [providerId]: { builtinModelIds: [modelId], access: { type: 'zhipu-account', entitled: true } } },
      states: { [providerId]: { availability: 'available', entitled: true, current: true } }
    });
    await sendChecked('provider/refreshRegistry', { reason: 'aih_headless' });
    const ownSessionId = `session_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const created = await sendCommand('createSession', {
      workspaceId: workspacePath,
      config: {
        modelSelection, provider: providerId, model: modelId,
        thought: 'low', followupMode: 'queue', mode: 'yolo', planEnabled: false
      },
      dynamicWorkflowEnabled: true,
      dynamicWorkflowMode: 'alwaysOn',
      sessionId: ownSessionId,
      additionalDirectories: [],
      offPeakToolEnabled: true
    });
    assertV4CommandAckOk('createSession', created);
    const sessionId = getSessionId() || ownSessionId;
    await send('v4/conversation/subscribe', {
      topic: `conversation/${sessionId}`,
      connectionId,
      clientMode: 'desktop-continuous',
      workflowRunDeltas: true,
      historyFirst: true,
      workspace: { workspaceKey: workspacePath, workspacePath },
      additionalDirectories: []
    });
    await send('session/resume', { sessionId });
    await send('session/setMode', { sessionId, mode: 'yolo' });
    const accepted = await sendCommand('sendText', {
      text: prompt, modelSelection, mode: 'yolo', planEnabled: false, inputOrigin: 'desktop'
    }, sessionId);
    assertV4CommandAckOk('sendText', accepted);
    // 时钟心跳：桌面端持续上报 clock，缺它 runtime 不推进（与 v4 command 同一条通道）。
    clockTimer = setInterval(() => {
      send('v4/commands/query', { commands: [{ sessionId: null, commandId: `ttft-clock-${Date.now()}` }], clock: true })
        .catch(() => {});
    }, 1500);
    // 答案有两条来源：v4 会话帧（实时增量）与会话库（turn 结束后的权威全文）。
    // 帧到达时立即 onText；DB 仍做兜底轮询（协议缺帧时不至于丢答案）。
    const readTurnTerminal = typeof ctx.getTurnTerminal === 'function' ? ctx.getTurnTerminal : () => null;
    const readAuthError = typeof ctx.getAuthError === 'function' ? ctx.getAuthError : () => '';
    const stream = ctx.conversationStream || null;
    const emitText = typeof ctx.emitText === 'function' ? ctx.emitText : null;
    let lastDbRead = 0;
    let successSince = 0;
    const readAssistantText = () => {
      let messages = [];
      try {
        messages = readZcodeSessionMessages(cliDbPath, sessionId) || [];
      } catch (_error) {
        messages = [];
      }
      const assistant = messages.filter((m) => m.role === 'assistant' && normalizeText(m.content));
      return assistant.length > 0 ? String(assistant[assistant.length - 1].content).trim() : '';
    };
    const finalize = () => {
      const streamed = stream ? stream.getText() : '';
      const dbText = readAssistantText();
      if (dbText && streamed && dbText.startsWith(streamed)) {
        // 流式阶段少最后一小段（帧丢/被截断）时补上，不重复输出。
        const rest = dbText.slice(streamed.length);
        if (rest && emitText) emitText(rest);
        return { ok: true, text: dbText, sessionId, error: '' };
      }
      if (dbText && !streamed) {
        if (emitText) emitText(dbText);
        return { ok: true, text: dbText, sessionId, error: '' };
      }
      if (streamed) return { ok: true, text: streamed, sessionId, error: '' };
      return null;
    };
    while (Date.now() < deadline) {
      await wait(250);
      const terminal = readTurnTerminal();
      // `turn.terminal.status` 只有 success/interrupted/failed 三值（bundle 枚举）；
      // 只有 success 才继续等文本，其余一律立刻带原因返回。
      if (terminal && terminal.status && terminal.status !== 'success') {
        const code = terminal.errorCode ? `[${terminal.errorCode}]` : '';
        const message = terminal.errorMessage || terminal.status;
        const authDetail = readAuthError();
        return {
          ok: false,
          text: '',
          sessionId,
          error: `zcode_app_server_turn_failed:${code}${String(message).slice(0, 200)}${authDetail ? `:${authDetail}` : ''}`
        };
      }
      const now = Date.now();
      const streamComplete = Boolean(stream && stream.isComplete());
      if (terminal && terminal.status === 'success') {
        if (!successSince) successSince = now;
        // 给最后一条 row.upserted（state=complete）一点落地时间。
        if (streamComplete || now - successSince >= 800) {
          const final = finalize();
          if (final) return final;
        }
      } else if (streamComplete) {
        // terminal 帧偶尔晚到；行已 complete 就不必再等。
        const final = finalize();
        if (final) return final;
      }
      // 流式帧不动 DB：有流式文本时降频兜底，避免每秒读一次库。
      const interval = stream && stream.hasText() ? 3000 : 1200;
      if (now - lastDbRead >= interval) {
        lastDbRead = now;
        const final = finalize();
        if (final) return final;
      }
    }
    return { ok: false, text: '', sessionId, error: `zcode_app_server_timeout:${summarizeEvents()}` };
  } catch (error) {
    return { ok: false, text: '', sessionId: '', error: `zcode_app_server_failed:${error && error.message}` };
  } finally {
    if (clockTimer) {
      try { clearInterval(clockTimer); } catch (_error) { /* 忽略 */ }
      clockTimer = null;
    }
    try {
      child.kill();
    } catch (_error) { /* 忽略 */ }
  }
}

module.exports = {
  ACCEPTED_V4_COMMAND_STATUSES,
  RUNTIME_PREFERENCES,
  assertV4CommandAckOk,
  buildZcodeAccountScope,
  parseProjectAccessTokenIdentity,
  resolveZcodeProviderRequestAuth,
  runZcodeAppServerPrompt
};
