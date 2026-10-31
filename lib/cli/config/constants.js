'use strict';

// Snapshot freshness, scheduler windows, and schema/source ids for usage tracking.
const USAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const USAGE_REFRESH_STALE_MS = 5 * 60 * 1000;
const USAGE_INDEX_STALE_REFRESH_MS = 3 * 60 * 1000;
const USAGE_INDEX_BG_REFRESH_LIMIT = 400;
const USAGE_SNAPSHOT_SCHEMA_VERSION = 2;
const USAGE_SOURCE_GEMINI = 'gemini_refresh_user_quota';
const USAGE_SOURCE_CODEX = 'codex_app_server';
const USAGE_SOURCE_CLAUDE_OAUTH = 'claude_oauth_usage_api';
const USAGE_SOURCE_CLAUDE_AUTH_TOKEN = 'claude_auth_token_usage_api';
const USAGE_SOURCE_AGY_CODE_ASSIST = 'agy_fetch_available_models';
const { USAGE_SOURCE_KIMI } = require('../../account/usage-remaining');

// Generic CLI output and backup envelope constants.
const LIST_PAGE_SIZE = 10;
const EXPORT_MAGIC = 'AIH_EXPORT_V2:';
const EXPORT_VERSION = 2;
const AGE_SSH_KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa']);

// Claude launch --settings files (0600, hold gateway credentials): files not rewritten by any
// launch for this long are pruned on the next write, so rotated keys do not linger on disk.
// Long enough that a running Claude session never loses the file it was started with.
const CLAUDE_LAUNCH_SETTINGS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 跨 Provider harness 启动时写进 Claude Code `modelPicker` 的模型行上限：目录里最大的账号
// 约 120 个模型（实测），上限只作为病态目录（上游回了一份超长清单）的兜底。
const CLAUDE_MODEL_PICKER_ROW_LIMIT = 200;

// Egress pool node ledger (lib/runtime/egress-pool-node-health.js): per-node cooldowns after an
// exit-bound failure, the recovery probe cadence, and how much history is kept.
//   - FREE_LIMIT: 429 FreeUsageLimitError is counted per (exit IP x model); upstream resets it in
//     minutes to hours, so a limited exit is skipped for a while instead of being re-hit.
//   - GATE: the free-tier gate flips per exit within minutes (measured 2026-10-18).
//   - NETWORK: unreachable node; doubles per consecutive failure up to the cap, and a successful
//     recovery probe clears it early.
//   - IP_BLOCKED: 403 FreeTierError "detected abusive traffic from this IP address" — the exit IP
//     is blacklisted upstream; it does not flip within minutes and a reachability probe cannot
//     prove it lifted, so the node is skipped for hours (manual clear in the WebUI still works).
const EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const EGRESS_POOL_NODE_GATE_COOLDOWN_MS = 2 * 60 * 1000;
const EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS = 60 * 1000;
const EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const EGRESS_POOL_NODE_MAX_COOLDOWN_MS = 30 * 60 * 1000;
const EGRESS_POOL_PROBE_INTERVAL_MS = 60 * 1000;
// 探测并发与批量（2026-10-21）：2w 节点规模下，串行探测一轮要几十小时，节点状态永远追不上现实。
// 探测只走出站、入站只回环，并发互不干扰；上限取「够快」与「别把出口打满」的折中。
const EGRESS_POOL_PROBE_CONCURRENCY = 8;
const EGRESS_POOL_PROBE_BATCH = 64;
// 位置查询要经节点出网一次，同样按并发跑。
const EGRESS_POOL_GEO_CONCURRENCY = 8;
const EGRESS_POOL_PROBE_TIMEOUT_MS = 5000;
const EGRESS_POOL_EVENT_HISTORY = 200;
// Egress pool lanes (lib/runtime/egress-pool-runtime.js): fixed per-core listener slots so each
// pool-bound account (or shared upstream x node scope) gets its own exit without reloading mihomo.
// Ports: mixed, controller, probe, then LANE_SLOTS lane ports, all consecutive on 127.0.0.1.
//   - UPSTREAM_PROBE_TIMEOUT: a credential-free request to an upstream through one node; a reset
//     or timeout while the neutral probe succeeds is how a region block shows up (measured
//     2026-10-19: HK nodes -> api.anthropic.com reset, US/JP/SG -> 401).
//   - GEO_TTL: how long a node's looked-up exit location is trusted before re-lookup.
//   - LOCAL_GEO_TTL: cache for the host's own exit location (network guard for unpooled accounts).
const EGRESS_POOL_LANE_SLOTS = 16;
const EGRESS_POOL_UPSTREAM_PROBE_TIMEOUT_MS = 10000;
const EGRESS_POOL_NODE_GEO_TTL_MS = 24 * 60 * 60 * 1000;
const EGRESS_LOCAL_GEO_TTL_MS = 5 * 60 * 1000;
const EGRESS_POOL_PLAN_INTERVAL_MS = 60 * 1000;
// Per-session pool strategy: lanes reserved for one account so each concurrent local CLI
// session (e.g. several `aih opencode 3` windows) exits through a different node. Sessions beyond
// this count share lanes round-robin. Reduced automatically when lane slots run short.
const EGRESS_POOL_SESSION_LANES = 4;

// kiro CodeWhisperer stream (lib/server/kiro-chat-transport.js): two-stage watchdog instead of a
// whole-turn deadline. FIRST_EVENT bounds time-to-first-byte (large prompts / opus thinking);
// IDLE resets on every received chunk, so long answers and long tool inputs are never cut.
const KIRO_STREAM_FIRST_EVENT_TIMEOUT_MS = 180 * 1000;
const KIRO_STREAM_IDLE_TIMEOUT_MS = 120 * 1000;
// Gateway protocol bridge (lib/server/protocol-fallback-bridge.js): keepalive written to a started
// client stream when the upstream is silent, so client/proxy idle timers do not cut the stream.
const PROTOCOL_STREAM_KEEPALIVE_MS = 15 * 1000;
// Scheduling signals are local pressure estimates, never advertised upstream limits.
const ACCOUNT_SELECTION_RATE_WINDOW_MS = 10 * 1000;
const ACCOUNT_SELECTION_UNKNOWN_WEIGHT = 50;
const ACCOUNT_SELECTION_AFFINITY_LOAD_MARGIN = 2;
const ACCOUNT_SELECTION_LOW_QUOTA_PCT = 5;
// 账号 / (账号, 模型) 冷却的统一口径（2026-10-31）：上游**没有**给出恢复时刻（retry-after 头、
// 正文里的 reset 时间戳、额度快照的 resetAtMs）时，冷却时长一律是猜测；猜测只给这一个短值，
// 到期后由下一次真实请求复核，还失败就再冷却一次。上游明确说了何时恢复，才按那个时刻冷却。
// 旧实现的 5 分钟 / 10 分钟 / 24 小时 / 1 年都是猜测：一次误判（代理抖动、WAF、伪造状态码）
// 就把健康账号摘出池子很久，单账号池直接整池 503。
const ACCOUNT_GUESSED_COOLDOWN_MS = 30 * 1000;
const MODEL_CAPACITY_COOLDOWN_MS = ACCOUNT_GUESSED_COOLDOWN_MS;
// 容量退避：只在同一 (账号, 模型) 连续容量失败、期间没有成功时翻倍，成功即清零。
const MODEL_CAPACITY_MAX_COOLDOWN_MS = 2 * 60 * 1000;

// Daemon identity for platform autostart integrations.
const AIH_SERVER_LAUNCHD_LABEL = 'com.clawdcodex.ai_home';

// zcode 登录时的业务 token（PAT）换取重试（lib/server/zcode-credential-writer.js）。
// 换取失败会静默降级成**原始 OAuth access_token**（约 1 小时寿命），而桌面端启动时用
// `getCustomerInfo` 校验这份凭据：原始 token 必被拒（code 401）→ 广播
// `auth:zcode-jwt-invalid` → 弹「Your session has expired」要求重新登录
// （2026-10-28 账号 11 真机：登录成功但这一步被瞬时失败吞掉，表现为点 desktop 永远要重登）。
// 上游对频繁换取敏感，所以只做少量重试。
const ZCODE_PAT_EXCHANGE_ATTEMPTS = 3;
const ZCODE_PAT_EXCHANGE_RETRY_MS = 800;

module.exports = {
  USAGE_CACHE_MAX_AGE_MS,
  USAGE_REFRESH_STALE_MS,
  USAGE_INDEX_STALE_REFRESH_MS,
  USAGE_INDEX_BG_REFRESH_LIMIT,
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  USAGE_SOURCE_GEMINI,
  USAGE_SOURCE_CODEX,
  USAGE_SOURCE_CLAUDE_OAUTH,
  USAGE_SOURCE_CLAUDE_AUTH_TOKEN,
  USAGE_SOURCE_AGY_CODE_ASSIST,
  USAGE_SOURCE_KIMI,
  LIST_PAGE_SIZE,
  EXPORT_MAGIC,
  EXPORT_VERSION,
  AGE_SSH_KEY_TYPES,
  CLAUDE_LAUNCH_SETTINGS_RETENTION_MS,
  CLAUDE_MODEL_PICKER_ROW_LIMIT,
  EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS,
  EGRESS_POOL_NODE_GATE_COOLDOWN_MS,
  EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS,
  EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS,
  EGRESS_POOL_NODE_MAX_COOLDOWN_MS,
  EGRESS_POOL_PROBE_INTERVAL_MS,
  EGRESS_POOL_PROBE_CONCURRENCY,
  EGRESS_POOL_PROBE_BATCH,
  EGRESS_POOL_GEO_CONCURRENCY,
  EGRESS_POOL_PROBE_TIMEOUT_MS,
  EGRESS_POOL_LANE_SLOTS,
  EGRESS_POOL_UPSTREAM_PROBE_TIMEOUT_MS,
  EGRESS_POOL_NODE_GEO_TTL_MS,
  EGRESS_LOCAL_GEO_TTL_MS,
  EGRESS_POOL_PLAN_INTERVAL_MS,
  EGRESS_POOL_SESSION_LANES,
  EGRESS_POOL_EVENT_HISTORY,
  KIRO_STREAM_FIRST_EVENT_TIMEOUT_MS,
  KIRO_STREAM_IDLE_TIMEOUT_MS,
  PROTOCOL_STREAM_KEEPALIVE_MS,
  ACCOUNT_SELECTION_RATE_WINDOW_MS,
  ACCOUNT_SELECTION_UNKNOWN_WEIGHT,
  ACCOUNT_SELECTION_AFFINITY_LOAD_MARGIN,
  ACCOUNT_SELECTION_LOW_QUOTA_PCT,
  MODEL_CAPACITY_COOLDOWN_MS,
  MODEL_CAPACITY_MAX_COOLDOWN_MS,
  ACCOUNT_GUESSED_COOLDOWN_MS,
  AIH_SERVER_LAUNCHD_LABEL,
  ZCODE_PAT_EXCHANGE_ATTEMPTS,
  ZCODE_PAT_EXCHANGE_RETRY_MS
};
