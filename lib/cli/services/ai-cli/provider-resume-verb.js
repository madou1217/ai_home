'use strict';

const { buildProviderResumeVerbArgs } = require('../../../runtime/provider-resume');

const RESUME_VERB_HELP = `用法：
  aih <cli> resume [<id>] [额外原生参数...]     # 续接：<id> 省略时用该 provider 的「最近一段」（没有则明确报错）
  aih <cli> <账号> resume [<id>]                # 指定账号续接
各 provider 的原生形态（事实来自 contracts/providers/manifest.json 的 sessions.flags）：
  codex     resume [<SESSION_ID>]      无 id = 原生 picker
  claude    --resume <session-id>      无 id = --continue（同 cwd 最近一段）
  cline     --id <session-id>          无 id 报错（只有精确身份一条路）
  gemini    --resume <index|latest>    无 id = --resume latest
  agy       --conversation <id>        无 id = --continue
  grok      --resume <id>              无 id = --continue
  opencode  --session <id>             无 id = --continue
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
function rewriteProviderResumeVerb(cliName, args = []) {
  const tokens = Array.isArray(args) ? args.map((value) => String(value)) : [];
  if (tokens.length < 2) return null;

  let verbIndex = -1;
  // aih <cli> resume ...
  if (tokens[1] === 'resume') verbIndex = 1;
  // aih <cli> <账号/别名> resume ...
  else if (tokens.length > 2 && tokens[2] === 'resume' && !tokens[1].startsWith('-')) verbIndex = 2;
  if (verbIndex < 0) return null;

  const rest = tokens.slice(verbIndex + 1);
  // `aih <cli> resume --help`：打印统一用法，而不是把它当成原生参数发出去。
  if (rest.some((token) => token === '--help' || token === '-h')) {
    return { ok: false, reason: 'resume_help', message: RESUME_VERB_HELP };
  }
  const first = rest[0];
  const sessionId = first && !first.startsWith('-') ? first : '';
  const extraArgs = sessionId ? rest.slice(1) : rest;

  const resolved = buildProviderResumeVerbArgs(cliName, { sessionId, extraArgs });
  if (!resolved.ok) return resolved;

  const head = tokens.slice(0, verbIndex);
  return { ok: true, args: [...head, ...resolved.args] };
}

module.exports = {
  RESUME_VERB_HELP,
  rewriteProviderResumeVerb
};
