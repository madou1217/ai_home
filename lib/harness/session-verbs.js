'use strict';

const { getExternalHarness } = require('./catalog');

/**
 * 外部 harness（pi / dsh / dsh-tui）的统一动词：`aih <harness> resume|fork [<id>]`。
 *
 * 为什么要这一层：外部 harness **不是** AIH Gateway provider（没有上游协议、没有账号池），
 * 它们走 runExternalHarnessCommand 直接起原生二进制，因此 provider 那套
 * `lib/runtime/provider-resume.js` 的策略表根本不会经过它们 —— `aih pi resume <id>`
 * 曾经把 "resume" 当成**首条消息**发给 pi（pi 收到的是 prompt，不是续接）。
 *
 * 事实来源是 catalog 里每个 harness 描述符的 `sessions` 字段（原生 resume/fork 形态），
 * 本模块只做「动词 → 原生参数」的翻译，不猜：没有声明 sessions 的 harness 明确拒绝。
 *
 * 已核对（pi 1.4.0 `pi --help`）：
 *   --continue, -c        续接最近一段（同项目）
 *   --session <path|id>   精确续接（完整或部分 UUID）
 *   --fork <path|id>      从指定会话分叉出新会话（**必须**带身份，没有 picker）
 */

const HARNESS_SESSION_VERB_HELP = `用法：
  aih <harness> resume [<id>] [额外原生参数...]   # 续接：<id> 省略时用该 harness 的「最近一段」
  aih <harness> fork [<id>]                       # 从上一段对话分叉出新会话（原对话不动）
  aih <harness> -- <任意原生参数...>               # 逃生门：-- 之后原样交给原生 harness
各 harness 的原生形态（事实来自 lib/harness/catalog.js 的 sessions 字段）：
  pi   resume: --session <id> | --continue       fork: --fork <id>（无 id 报错）
其余外部 harness 尚未声明会话边界：aih 不猜参数，直接 aih <harness> -- <原生参数>。`;

function normalizeIdentity(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  // 身份里出现空白/控制字符一律当非法：宁可报错，也不要拼出一个会打到别的会话的参数。
  return /[\s\0]/.test(text) ? null : text;
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function harnessLabel(harness) {
  return String((harness && (harness.label || harness.id)) || '').trim();
}

// 一条 verb 声明：{ idArgs: ['--session'], latestArgs: ['--continue'] }。
// 有身份 → idArgs + <id>；无身份 → latestArgs（没有就是「必须精确身份」）。
function buildVerbArgs(declaration, identity, extra) {
  const spec = declaration && typeof declaration === 'object' ? declaration : null;
  if (!spec) return null;
  if (identity) {
    const idArgs = normalizeList(spec.idArgs);
    return idArgs.length ? [...idArgs, identity, ...extra] : null;
  }
  const latestArgs = normalizeList(spec.latestArgs);
  return latestArgs.length ? [...latestArgs, ...extra] : null;
}

/**
 * `aih <harness> resume|fork [<id>] [额外原生参数...]`（也支持 `aih <harness> <账号> resume ...`）。
 *
 * 返回：
 *   null                            没有统一动词，调用方照原样透传
 *   { ok: true, args }              改写后的完整 args（含 harness id）
 *   { ok: false, reason, message }  明确拒绝（未声明 / 缺精确身份 / 身份非法）
 */
function rewriteHarnessNativeVerb(harnessId, args = []) {
  const tokens = Array.isArray(args) ? args.map((value) => String(value)) : [];
  if (tokens.length < 2) return null;
  const harness = getExternalHarness(harnessId);
  if (!harness) return null;

  const verbAt = (index) => tokens[index] === 'resume' || tokens[index] === 'fork';
  // aih <harness> <verb> ... 或 aih <harness> <账号> <verb> ...（账号位不能是 - 开头）
  let verbIndex = -1;
  if (verbAt(1)) verbIndex = 1;
  else if (tokens.length > 2 && verbAt(2) && !tokens[1].startsWith('-')) verbIndex = 2;
  if (verbIndex < 0) return null;
  const verb = tokens[verbIndex];
  const label = harnessLabel(harness);

  const rest = tokens.slice(verbIndex + 1);
  // `aih pi resume --help`：打印统一用法，而不是把它当成原生参数发出去。
  if (rest.some((token) => token === '--help' || token === '-h')) {
    return { ok: false, reason: 'verb_help', message: HARNESS_SESSION_VERB_HELP };
  }

  const sessions = harness.sessions && typeof harness.sessions === 'object' ? harness.sessions : null;
  if (!sessions) {
    return {
      ok: false,
      reason: 'harness_sessions_undeclared',
      message: `${label} 尚未声明会话续接/分叉入口，aih 不猜参数；请直接用原生命令：aih ${harness.id} -- <原生参数>。`
    };
  }

  const first = rest[0];
  const sessionId = first && !first.startsWith('-') ? first : '';
  const extraArgs = sessionId ? rest.slice(1) : rest;
  const identity = normalizeIdentity(sessionId);
  if (identity === null) {
    return {
      ok: false,
      reason: 'resume_identity_invalid',
      message: `会话身份不能包含空白或控制字符：${JSON.stringify(String(sessionId))}`
    };
  }

  // 声明了 sessions 但该动词为 null：不是「漏做」，是**已核实没有原生入口**
  // （dsh 的 web profile 就没有任何会话旗标）。把 note 原样告诉用户，别让他以为是 bug。
  if (!sessions[verb]) {
    const note = String(sessions.note || '').trim();
    return {
      ok: false,
      reason: 'harness_session_verb_unavailable',
      message: note
        ? `${label} 没有${verb === 'fork' ? '分叉' : '续接'}入口：${note}。`
        : `${label} 未声明${verb === 'fork' ? '分叉' : '续接'}入口。`
    };
  }

  const built = buildVerbArgs(sessions[verb], identity, extraArgs);
  if (!built) {
    return {
      ok: false,
      reason: 'resume_identity_required',
      message: verb === 'fork'
        ? `${label} 只能按精确会话 id 分叉（没有「最近一段」这种安全退路）：先 aih ${harness.id} resume 挑一段，再 aih ${harness.id} fork <id>。`
        : `${label} 只能按精确会话 id 续接（它没有「最近一段」这种安全退路）。`
    };
  }

  return { ok: true, args: [...tokens.slice(0, verbIndex), ...built] };
}

module.exports = {
  HARNESS_SESSION_VERB_HELP,
  buildVerbArgs,
  rewriteHarnessNativeVerb
};
