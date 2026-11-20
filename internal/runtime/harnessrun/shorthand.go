package harnessrun

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
)

// `aih <harness> …` 简写：Node 旧入口的 ai-cli 路由把它当作外部 harness 的
// 一等命令（不是 Provider）。Go 接管后语义必须逐字一致：
//
//	aih <harness> [<accountRef>] [--model <m>] [--model-alias <x>] [-- <原生参数…>]
//	aih <harness> resume|fork [<id>] [额外原生参数…]
//
// 与 `aih harness <id> --provider <p>` 的差别只有参数形态：简写不显式带
// Provider，钉选账号时归属由账号事实决定，省略账号时走网关账号池。

const harnessSessionVerbHelp = `用法：
  aih <harness> resume [<id>] [额外原生参数...]   # 续接：<id> 省略时用该 harness 的「最近一段」
  aih <harness> fork [<id>]                       # 从上一段对话分叉出新会话（原对话不动）
  aih <harness> -- <任意原生参数...>               # 逃生门：-- 之后原样交给原生 harness
各 harness 的原生形态（事实来自 core/harnesses 的 Sessions 字段）：
  pi   resume: --session <id> | --continue       fork: --fork <id>（无 id 报错）
其余外部 harness 尚未声明会话边界：aih 不猜参数，直接 aih <harness> -- <原生参数>。`

// controlledShorthandFlags 是 harness 必须由 aih 控制的身份/模型旗标：
// 放给 Pi/DSH 会让它们绕过账号钉选直连别的上游。
var controlledShorthandFlags = []string{"--provider", "--api-key", "--base-url", "--profile"}

type shorthandArgs struct {
	AccountRef string
	Model      string
	ModelAlias string
	NativeArgs []string
	Help       bool
	Escaped    bool
	ErrorCode  string
	ErrorFlag  string
}

// parseShorthandArgs 复刻 Node parseExternalHarnessArgs 的边界行为。
func parseShorthandArgs(arguments []string) shorthandArgs {
	result := shorthandArgs{NativeArgs: []string{}}
	input := arguments
	if len(input) > 0 {
		input = input[1:]
	}
	for index := 0; index < len(input); index++ {
		token := input[index]
		if !result.Escaped && token == "--" {
			result.Escaped = true
			continue
		}
		if !result.Escaped && (token == "--help" || token == "-h") {
			result.Help = true
			return result
		}
		if !result.Escaped && isAccountRef(token) && result.AccountRef == "" {
			result.AccountRef = token
			continue
		}
		if !result.Escaped && (token == "--model" || strings.HasPrefix(token, "--model=")) {
			if token == "--model" {
				next := ""
				if index+1 < len(input) {
					next = input[index+1]
				}
				if next == "" || strings.HasPrefix(next, "--") {
					result.ErrorCode = "model_value_missing"
					return result
				}
				result.Model = strings.TrimSpace(next)
				index++
			} else {
				result.Model = strings.TrimSpace(strings.TrimPrefix(token, "--model="))
			}
			continue
		}
		if !result.Escaped && (token == "--model-alias" || strings.HasPrefix(token, "--model-alias=")) {
			if token == "--model-alias" {
				next := ""
				if index+1 < len(input) {
					next = input[index+1]
				}
				if next == "" || strings.HasPrefix(next, "--") {
					result.ErrorCode = "model_alias_value_missing"
					return result
				}
				result.ModelAlias = strings.TrimSpace(next)
				index++
			} else {
				result.ModelAlias = strings.TrimSpace(strings.TrimPrefix(token, "--model-alias="))
			}
			if result.ModelAlias == "" {
				result.ErrorCode = "model_alias_value_missing"
				return result
			}
			continue
		}
		if !result.Escaped {
			if flag := controlledFlag(token); flag != "" {
				result.ErrorCode = "external_harness_controlled_flag"
				result.ErrorFlag = flag
				return result
			}
		}
		result.NativeArgs = append(result.NativeArgs, token)
	}
	return result
}

func controlledFlag(token string) string {
	for _, flag := range controlledShorthandFlags {
		if token == flag || strings.HasPrefix(token, flag+"=") {
			return flag
		}
	}
	return ""
}

// rewriteShorthandSessionVerb 复刻 Node rewriteHarnessNativeVerb：
// 返回改写后的完整参数、是否命中统一动词，以及拒绝时的用户消息。
func rewriteShorthandSessionVerb(harness harnesses.Harness, arguments []string) ([]string, bool, string) {
	if len(arguments) < 2 {
		return arguments, false, ""
	}
	verbAt := func(index int) bool {
		return arguments[index] == "resume" || arguments[index] == "fork"
	}
	verbIndex := -1
	if verbAt(1) {
		verbIndex = 1
	} else if len(arguments) > 2 && verbAt(2) && !strings.HasPrefix(arguments[1], "-") {
		verbIndex = 2
	}
	if verbIndex < 0 {
		return arguments, false, ""
	}
	verb := arguments[verbIndex]
	rest := arguments[verbIndex+1:]
	for _, token := range rest {
		if token == "--help" || token == "-h" {
			return arguments, true, harnessSessionVerbHelp
		}
	}
	if harness.Sessions == nil {
		return arguments, true, fmt.Sprintf(
			"%s 尚未声明会话续接/分叉入口，aih 不猜参数；请直接用原生命令：aih %s -- <原生参数>。",
			harness.Label, harness.ID,
		)
	}
	sessionID := ""
	extra := rest
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		sessionID = rest[0]
		extra = rest[1:]
	}
	if strings.ContainsAny(sessionID, " \t\r\n\x00") {
		return arguments, true, fmt.Sprintf("会话身份不能包含空白或控制字符：%q", sessionID)
	}
	declaration := harness.Sessions.Resume
	verbLabel := "续接"
	if verb == "fork" {
		declaration = harness.Sessions.Fork
		verbLabel = "分叉"
	}
	if declaration == nil {
		note := strings.TrimSpace(harness.Sessions.Note)
		if note != "" {
			return arguments, true, fmt.Sprintf("%s 没有%s入口：%s。", harness.Label, verbLabel, note)
		}
		return arguments, true, fmt.Sprintf("%s 未声明%s入口。", harness.Label, verbLabel)
	}
	built := buildSessionVerbArgs(declaration, sessionID, extra)
	if built == nil {
		if verb == "fork" {
			return arguments, true, fmt.Sprintf(
				"%s 只能按精确会话 id 分叉（没有「最近一段」这种安全退路）：先 aih %s resume 挑一段，再 aih %s fork <id>。",
				harness.Label, harness.ID, harness.ID,
			)
		}
		return arguments, true, fmt.Sprintf(
			"%s 只能按精确会话 id 续接（它没有「最近一段」这种安全退路）。", harness.Label,
		)
	}
	rewritten := make([]string, 0, len(arguments))
	rewritten = append(rewritten, arguments[:verbIndex]...)
	rewritten = append(rewritten, built...)
	return rewritten, true, ""
}

func buildSessionVerbArgs(declaration *harnesses.SessionVerb, identity string, extra []string) []string {
	if declaration == nil {
		return nil
	}
	if identity != "" {
		if len(declaration.IDArgs) == 0 {
			return nil
		}
		args := append([]string{}, declaration.IDArgs...)
		args = append(args, identity)
		return append(args, extra...)
	}
	if len(declaration.LatestArgs) == 0 {
		return nil
	}
	args := append([]string{}, declaration.LatestArgs...)
	return append(args, extra...)
}

// formatShorthandUsage 与 Node showExternalHarnessUsage 的输出逐字一致。
func formatShorthandUsage(harness harnesses.Harness) string {
	lines := []string{
		fmt.Sprintf("%s (%s) 通过 AIH Gateway 使用账号模型：", harness.Label, harness.ID),
		"",
		fmt.Sprintf("  aih %s [<accountRef>] [--model <model>] [-- <原生参数…>]", harness.ID),
		fmt.Sprintf("  aih %s models [accountRef] [--json]  只读目标 Server 模型目录，不启动", harness.ID),
		"",
	}
	hasResumeVerb := harness.Sessions != nil && harness.Sessions.Resume != nil
	if hasResumeVerb {
		lines = append(lines,
			fmt.Sprintf("  aih %s resume [<id>]      续接上一段对话（无 id = 最近一段）", harness.ID),
			fmt.Sprintf("  aih %s fork [<id>]        从上一段对话分叉（原对话不动）", harness.ID),
			"",
		)
	}
	lines = append(lines,
		"  <accountRef>   钉选账号（acct_…）；省略时走网关账号池",
		"  --model <id>   选择模型；省略时使用网关模型目录的第一个模型",
		"  --model-alias <id>  本次会话改用 <id>（临时规则，不落库；与 --model 同时给表示只改写那一个）",
		fmt.Sprintf("  --             之后的参数原样交给 %s", harness.Label),
		"",
		"示例：",
		fmt.Sprintf("  aih %s acct_xxxxxxxx --model gpt-5.6-luna", harness.ID),
		fmt.Sprintf("  aih %s --model claude-sonnet-4-5", harness.ID),
	)
	if hasResumeVerb {
		lines = append(lines, fmt.Sprintf("  aih %s resume 01a18c27-6bb1-72c4-b1d0-44918b5bcd2d", harness.ID))
	}
	return strings.Join(lines, "\n")
}

// RunShorthand 执行一次 `aih <harness> …`，返回进程退出码。
//
// 解析完成后复用 Run：简写只是把「账号/模型/原生参数」翻译成 harness 合同的
// 显式参数，不复制第二套选账号或投影逻辑。
func RunShorthand(arguments []string, rt Runtime) int {
	rt = normalizeRuntime(rt)
	harnessID := ""
	if len(arguments) > 0 {
		harnessID = harnesses.NormalizeID(arguments[0])
	}
	harness, found := harnesses.Get(harnessID)
	if !found {
		_, _ = fmt.Fprintf(rt.Stderr, "\x1b[31m[aih] Unknown external harness: %s\x1b[0m\n", harnessID)
		return 1
	}

	effective := arguments
	if parsed := parseShorthandArgs(arguments); !parsed.Escaped {
		rewritten, hit, message := rewriteShorthandSessionVerb(harness, arguments)
		if hit {
			if message == harnessSessionVerbHelp {
				_, _ = fmt.Fprintln(rt.Stdout, message)
				return 0
			}
			if message != "" {
				_, _ = fmt.Fprintf(rt.Stderr, "\x1b[31m[aih]\x1b[0m 不支持该统一动词：%s\n", message)
				return 1
			}
			effective = rewritten
		}
	}

	parsed := parseShorthandArgs(effective)
	if parsed.Help {
		_, _ = fmt.Fprintln(rt.Stdout, formatShorthandUsage(harness))
		return 0
	}
	if parsed.ErrorCode != "" {
		suffix := ""
		if parsed.ErrorFlag != "" {
			suffix = " (" + parsed.ErrorFlag + ")"
		}
		_, _ = fmt.Fprintf(
			rt.Stderr,
			"\x1b[31m[aih] %s 启动参数无效%s: %s\x1b[0m\n",
			harness.Label, suffix, parsed.ErrorCode,
		)
		return 1
	}

	// Run 接收的是 `aih harness` 之后的参数：第一项就是 harness id。
	contractArgs := []string{harness.ID}
	if parsed.AccountRef != "" {
		contractArgs = append(contractArgs, "--account", parsed.AccountRef)
	}
	if parsed.Model != "" {
		contractArgs = append(contractArgs, "--model", parsed.Model)
	}
	if parsed.ModelAlias != "" {
		contractArgs = append(contractArgs, "--model-alias", parsed.ModelAlias)
	}
	if len(parsed.NativeArgs) > 0 {
		contractArgs = append(contractArgs, "--")
		contractArgs = append(contractArgs, parsed.NativeArgs...)
	}
	return Run(contractArgs, rt)
}
