'use strict';

const { buildProviderForkVerbArgs, buildProviderResumeVerbArgs } = require('../../../runtime/provider-resume');

const RESUME_VERB_HELP = `用法：
  aih <cli> resume [<id>] [额外原生参数...]     # 续接：<id> 省略时用该 provider 的「最近一段」（没有则明确报错）
  aih <cli> <账号> resume [<id>]                # 指定账号续接
  aih <cli> fork [<id>]                         # 从上一段对话分叉出新会话（原对话不动）
  aih <cli> -- <任意原生参数...>                 # 逃生门：-- 之后原样交给原生 CLI，不受 aih 保留字影响
各 provider 的原生形态（事实来自 contracts/providers/manifest.json 的 sessions.flags）：
  codex     resume [<SESSION_ID>]      无 id = 原生 picker
  claude    --resume <session-id>      无 id = --continue（同 cwd 最近一段）
  cline     --id <session-id>          无 id 报错（只有精确身份一条路）
  gemini    --resume <index|latest>    无 id = --resume latest
  agy       --conversation <id>        无 id = --continue
  grok      --resume <id>              无 id = --continue
  opencode  --session <id>             无 id = --continue
  zcode     --resume <sess_…>          无 id = --continue
  codebuddy 家族  --resume <id>        无 id = --continue
  kimi / kiro    TUI 内 slash 命令（无「带参数重启即恢复」入口）
其余 provider 未声明会话边界：aih 不猜参数，直接透传原生命令。`;

/**
 * `aih <cli> resume [<id>] [额外原生参数...]`（也支持 `aih <cli> <账号> resume ...`）
 * → 改写成该 provider 的原生续接参数，交回既有派发链（账号选择、沙箱、持久会话全都照旧）。
 *
 * 只做**动词→原生参数**这一步翻译，真正的 provider 事实在 lib/runtime/provider-resume.js。
 * 返回：
 *   null                        没有 resume 动词，调用方照原样继续
 *   { ok: true, args }          改写后的完整 args（含 cli 名）
 *   { ok: false, reason, message } 明确拒绝（未声明/只在 TUI/缺精确身份），调用方报错退出
 */
/**
 * aih 的统一**原生动词**翻译：`resume` / `fork`（+ `--` 逃生门）。
 * 也支持 `aih <cli> <账号> resume|fork ...`：改写的只是动词，账号 token 原样保留。
 * 返回 null 表示「没有统一动词」，调用方照原样继续（完整透传）。
 */

const VERBS = Object.freeze({
  resume: buildProviderResumeVerbArgs,
  fork: buildProviderForkVerbArgs
});

/**
 * `aih <cli> -- <任意原生参数...>`：**逃生门**。
 * `--` 之后的每个 token 原样交给原生 CLI —— 这是「所有原生命令都能透传」的硬保证：
 * 即使 token 撞上 aih 自己的保留字（ls / login / delete / sessions / resume …）也照原样发出去。
 */
function extractNativeEscape(args = []) {
  const tokens = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const index = tokens.indexOf('--', 1);
  if (index < 0) return { escaped: false, args: tokens };
  return { escaped: true, args: [tokens[0], ...tokens.slice(index + 1)] };
}

function rewriteProviderNativeVerb(cliName, args = []) {
  const tokens = Array.isArray(args) ? args.map((value) => String(value)) : [];
  if (tokens.length < 2) return null;

  // aih <cli> <verb> ... 或 aih <cli> <账号> <verb> ...（账号位不能是 - 开头）
  let verbIndex = -1;
  if (VERBS[tokens[1]]) verbIndex = 1;
  else if (tokens.length > 2 && VERBS[tokens[2]] && !tokens[1].startsWith('-')) verbIndex = 2;
  if (verbIndex < 0) return null;
  const verb = tokens[verbIndex];

  const rest = tokens.slice(verbIndex + 1);
  // `aih <cli> resume --help`：打印统一用法，而不是把它当成原生参数发出去。
  if (rest.some((token) => token === '--help' || token === '-h')) {
    return { ok: false, reason: 'verb_help', message: RESUME_VERB_HELP };
  }
  const first = rest[0];
  const sessionId = first && !first.startsWith('-') ? first : '';
  const extraArgs = sessionId ? rest.slice(1) : rest;

  const resolved = VERBS[verb](cliName, { sessionId, extraArgs });
  if (!resolved.ok) return resolved;

  const head = tokens.slice(0, verbIndex);
  return { ok: true, args: [...head, ...resolved.args] };
}

module.exports = {
  RESUME_VERB_HELP,
  extractNativeEscape,
  rewriteProviderNativeVerb,
  rewriteProviderResumeVerb: rewriteProviderNativeVerb
};
