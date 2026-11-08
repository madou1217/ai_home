// Package sessionchat 承载「一次 Chat 请求 → 官方 CLI 原生会话命令」的纯构造逻辑。
//
// 迁移来源（Node，行为逐字段对齐）：
//   - lib/server/native-session-chat-command.js    命令构造、失败码、tmux 包装、续接参数
//   - lib/server/native-session-chat-transport.js  传输描述符（headless / pty / acp / desktop）
//   - lib/server/native-session-chat-env.js        环境投影的纯决策部分
//   - lib/server/native-session-chat-failure.js    失败分类与账号运行态阻塞
//   - lib/server/native-run-tmux.js                run socket / shell 命令组装
//
// 包内不做文件系统、进程、账号库或 CLI 探测：凡是 Node 侧需要 I/O 的入口
// （gemini 会话文件、opencode 布局探测、tmux 可用性、当前时间）都改为参数注入，
// 由调用方解析后传入。这样同一份输入在 Node 与 Go 两侧可逐字段对拍。
package sessionchat

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// CodeError 是带稳定错误码的构造失败，对应 Node 的 error.code。
type CodeError struct {
	Code    string
	Message string
}

// Error 返回人类可读消息；没有消息时退回错误码，与 Node 的 new Error(code) 一致。
func (err *CodeError) Error() string {
	if err.Message != "" {
		return err.Message
	}
	return err.Code
}

// NewCodeError 构造一个带稳定错误码的失败。
func NewCodeError(code string, message string) *CodeError {
	return &CodeError{Code: code, Message: message}
}

// ErrorCode 取出 CodeError 的错误码；非本类型返回空串。
func ErrorCode(err error) string {
	var target *CodeError
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

// Command 是一次 CLI 会话的命令名与参数，字段与 Node 返回值同名。
type Command struct {
	CommandName string
	Args        []string
}

// codexHeadlessExecArgs 是 codex headless（webUI 聊天轮）的公共 exec 参数。
//
// mcp_servers={} 是稳健性开关：远端 config 里的 mcp_servers 常指向失效路径且
// startup_timeout_sec 很长，误触即挂 120s；聊天轮用不到这些 MCP 工具。
var codexHeadlessExecArgs = []string{
	"exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
	"-c", "mcp_servers={}",
}

// officialNativeSessionProviders 与 Node 的 OFFICIAL_NATIVE_SESSION_PROVIDERS 同集合。
// 注意 zcode 在集合内但没有命令分支（走桌面会话 runner），最终仍报 unsupported。
var officialNativeSessionProviders = map[string]bool{
	"codex": true, "claude": true, "gemini": true, "agy": true, "opencode": true,
	"grok": true, "zcode": true, "qoder": true, "qodercn": true, "cline": true,
	"codebuddy": true, "codebuddycn": true, "workbuddy": true, "workbuddycn": true,
}

// familyProviders 是 CodeBuddy 家族四支（与 lib/runtime/codebuddy-family-layouts 同名单）。
var familyProviders = map[string]bool{
	"codebuddy": true, "codebuddycn": true, "workbuddy": true, "workbuddycn": true,
}

// NormalizeProvider 归一化 Provider 身份：去首尾空白并转小写。
func NormalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// IsOfficialNativeSessionProvider 判断该 Provider 是否声明了原生会话入口。
func IsOfficialNativeSessionProvider(provider string) bool {
	return officialNativeSessionProviders[NormalizeProvider(provider)]
}

// IsCodebuddyFamilyProvider 判断是否 CodeBuddy 家族四支。
func IsCodebuddyFamilyProvider(provider string) bool {
	return familyProviders[NormalizeProvider(provider)]
}

// normalizeString 等价 Node 的 normalizeString：去首尾空白。
func normalizeString(value string) string {
	return strings.TrimSpace(value)
}

// normalizeImagePaths 等价 Node 的 imagePaths 归一化：逐项转字符串、去空白、丢弃空项。
func normalizeImagePaths(paths []string) []string {
	result := make([]string, 0, len(paths))
	for _, item := range paths {
		value := normalizeString(item)
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

// agyCLINameByID 是 agy 内部模型 id → CLI 显示名映射（唯一真值见 lib/runtime/agy-model-names.js）。
var agyCLINameByID = map[string]string{
	"gemini-3.8-flash-high":    "Gemini 3.8 Flash (High)",
	"gemini-3.8-flash-medium":  "Gemini 3.8 Flash (Medium)",
	"gemini-3.8-flash-tiered":  "Gemini 3.8 Flash (Medium)",
	"gemini-3.8-flash-low":     "Gemini 3.8 Flash (Low)",
	"claude-sonnet-4-6":        "Claude Sonnet 4.6 (Thinking)",
	"claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
	"gpt-oss-120b-medium":      "GPT-OSS 120B (Medium)",
}

// agyCLINames 是全部合法显示名集合。
var agyCLINames = func() map[string]bool {
	names := make(map[string]bool, len(agyCLINameByID))
	for _, name := range agyCLINameByID {
		names[name] = true
	}
	return names
}()

// ResolveAgyCliModelName 把内部模型 id 译成 CLI 显示名；已是显示名原样返回；无法识别返回空串。
func ResolveAgyCliModelName(model string) string {
	value := normalizeString(model)
	if value == "" {
		return ""
	}
	if name, found := agyCLINameByID[value]; found {
		return name
	}
	if agyCLINames[value] {
		return value
	}
	return ""
}

// imageGenerationModelPattern 匹配生图模型（gemini image / nano banana / flash-image）。
var imageGenerationModelPattern = regexp.MustCompile("(?i)(^|[-_/])image($|[-_])|nano-?banana|flash-image")

// IsImageGenerationModel 判断模型是否生图模型（agy CLI 不支持，提前拒绝）。
func IsImageGenerationModel(model string) bool {
	return imageGenerationModelPattern.MatchString(strings.ToLower(normalizeString(model)))
}

// OpenCodeLayout 是 opencode 命令行布局，字段与 lib/runtime/opencode-run-layouts.js 对齐。
type OpenCodeLayout struct {
	ID             string
	DirectoryFlag  string
	StandaloneFlag string
	PWDDirectory   bool
}

// OpenCodeLayoutV2 是 v2 布局：run 无 --dir（目录由 PWD/cwd 表达），run/TUI 需 --standalone。
var OpenCodeLayoutV2 = OpenCodeLayout{ID: "v2", StandaloneFlag: "--standalone", PWDDirectory: true}

// OpenCodeLayoutV1 是 v1 布局：run 有 --dir，TUI 无后台 service。
var OpenCodeLayoutV1 = OpenCodeLayout{ID: "v1", DirectoryFlag: "--dir"}

// ResolveOpenCodeLayout 解析布局：环境变量钉选优先，否则回落最新布局（v2）。
// 真实探测（opencode run --help）留在 Node：它需要读盘与 spawn，不属于纯构造。
func ResolveOpenCodeLayout(envValue string) OpenCodeLayout {
	forced := strings.ToLower(ReadOpencodeContextField(envValue, "runLayout"))
	switch forced {
	case "v1":
		return OpenCodeLayoutV1
	case "v2":
		return OpenCodeLayoutV2
	default:
		return OpenCodeLayoutV2
	}
}

// ParseOpencodeContext 解析 key=value 逗号串，值按 URL 转义还原（同 Node parseOpencodeContext）。
func ParseOpencodeContext(value string) map[string]string {
	fields := map[string]string{}
	for _, part := range strings.Split(value, ",") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		key := strings.TrimSpace(part[:index])
		rawValue := strings.TrimSpace(part[index+1:])
		if key == "" || rawValue == "" {
			continue
		}
		// Node 用 decodeURIComponent：只解百分号转义，'+' 原样保留。
		if decoded, err := urlPathUnescape(rawValue); err == nil {
			fields[key] = decoded
		} else {
			fields[key] = rawValue
		}
	}
	return fields
}

// ReadOpencodeContextField 读取运行时上下文的一个字段。
func ReadOpencodeContextField(value string, key string) string {
	return ParseOpencodeContext(value)[key]
}

// OpenCodeRunDirectoryArgs 返回 run 的目录旗标参数（v1: --dir <dir>；v2: 空）。
func OpenCodeRunDirectoryArgs(layout OpenCodeLayout, directory string) []string {
	dir := normalizeString(directory)
	if layout.DirectoryFlag == "" || dir == "" {
		return nil
	}
	return []string{layout.DirectoryFlag, dir}
}

// OpenCodeRunStandaloneArgs 返回私有 server 旗标参数（v2: --standalone；v1: 空）。
func OpenCodeRunStandaloneArgs(layout OpenCodeLayout) []string {
	if layout.StandaloneFlag == "" {
		return nil
	}
	return []string{layout.StandaloneFlag}
}

// StartOptions 是新会话命令的输入。Platform 为空时取当前 GOOS。
type StartOptions struct {
	Prompt         string
	SessionID      string
	Model          string
	ImagePaths     []string
	InteractiveCLI bool
	ProjectPath    string
	Layout         OpenCodeLayout
	Platform       string
}

// ResumeOptions 是续接会话命令的输入。
//
//   - SessionPath：调用方已解析的会话文件路径（家族 IDE 会话判定用）
//   - GeminiSessionFile：调用方已确认存在的 gemini 会话文件绝对路径；
//     非空时用 --session-file（绕开按 cwd 的项目发现），否则回落 --resume <id>
type ResumeOptions struct {
	Prompt            string
	SessionID         string
	Model             string
	ImagePaths        []string
	InteractiveCLI    bool
	ProjectDirName    string
	SessionPath       string
	GeminiSessionFile string
	Layout            OpenCodeLayout
	Platform          string
}

// PushClaudeHeadlessStreamArgs 追加 claude headless 的公共 stream-json 输出参数。
func PushClaudeHeadlessStreamArgs(args []string) []string {
	return append(args, "--print", "--verbose", "--output-format", "stream-json")
}

// ClaudeUsesStreamJSONInput 判断 claude headless 是否经 stdin 送 stream-json 用户消息。
//
// POSIX 下常开：stdin 常开才能做 mid-run steer；Windows 无 sh cat-pipe，回退位置参数。
func ClaudeUsesStreamJSONInput(provider string, interactiveCLI bool, platform string) bool {
	return NormalizeProvider(provider) == "claude" && !interactiveCLI && normalizeNodePlatform(platform) != "win32"
}

// BuildStartCommand 把「新建会话」翻译成 CLI 命令。错误码与 Node 一致。
func BuildStartCommand(provider string, options StartOptions) (Command, error) {
	normalized := NormalizeProvider(provider)
	prompt := options.Prompt
	model := normalizeString(options.Model)
	imagePaths := normalizeImagePaths(options.ImagePaths)
	interactive := options.InteractiveCLI

	if !IsOfficialNativeSessionProvider(normalized) {
		return Command{}, NewCodeError("native_session_start_unsupported", "")
	}
	if !interactive && strings.TrimSpace(prompt) == "" {
		return Command{}, NewCodeError("empty_prompt", "")
	}

	switch normalized {
	case "gemini":
		if interactive {
			args := make([]string, 0, 6)
			if options.SessionID != "" {
				args = append(args, "--session-id", normalizeString(options.SessionID))
			}
			if strings.TrimSpace(prompt) != "" {
				args = append(args, "--prompt-interactive", prompt)
			}
			if model != "" {
				args = append(args, "--model", model)
			}
			return Command{CommandName: "gemini", Args: args}, nil
		}
		args := []string{"--prompt-interactive", prompt}
		if options.SessionID != "" {
			args = append([]string{"--session-id", normalizeString(options.SessionID)}, args...)
		}
		if model != "" {
			args = append(args, "--model", model)
		}
		return Command{CommandName: "gemini", Args: args}, nil

	case "codex":
		if interactive {
			args := make([]string, 0, 8)
			if model != "" {
				args = append(args, "-m", model)
			}
			for _, imagePath := range imagePaths {
				args = append(args, "-i", imagePath)
			}
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: "codex", Args: args}, nil
		}
		args := append([]string(nil), codexHeadlessExecArgs...)
		if model != "" {
			args = append(args, "-m", model)
		}
		for _, imagePath := range imagePaths {
			args = append(args, "-i", imagePath)
		}
		if options.ProjectPath != "" {
			args = append(args, "-C", normalizeString(options.ProjectPath))
		}
		args = append(args, prompt)
		return Command{CommandName: "codex", Args: args}, nil

	case "claude":
		if interactive {
			args := make([]string, 0, 6)
			if model != "" {
				args = append(args, "--model", model)
			}
			if options.SessionID != "" {
				args = append(args, "--session-id", normalizeString(options.SessionID))
			}
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: "claude", Args: args}, nil
		}
		args := make([]string, 0, 12)
		if model != "" {
			args = append(args, "--model", model)
		}
		args = PushClaudeHeadlessStreamArgs(args)
		if options.SessionID != "" {
			args = append(args, "--session-id", normalizeString(options.SessionID))
		}
		if ClaudeUsesStreamJSONInput("claude", interactive, options.Platform) {
			// 图片与 prompt 经 stdin 的 stream-json 消息送达，不再做位置参数。
			args = append(args, "--input-format", "stream-json")
		} else {
			args = append(args, prompt)
		}
		return Command{CommandName: "claude", Args: args}, nil

	case "qoder", "qodercn":
		args := make([]string, 0, 10)
		if model != "" {
			args = append(args, "--model", model)
		}
		if interactive {
			if options.SessionID != "" {
				args = append(args, "--session-id", normalizeString(options.SessionID))
			}
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: normalized, Args: args}, nil
		}
		args = append(args, "--print", "--output-format", "stream-json", "--include-partial-messages")
		if options.SessionID != "" {
			args = append(args, "--session-id", normalizeString(options.SessionID))
		}
		args = append(args, prompt)
		return Command{CommandName: normalized, Args: args}, nil

	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		// 新建会话用预生成的 uuid 固定 --session-id，便于随后按文件定位并续聊。
		args := make([]string, 0, 8)
		if model != "" {
			args = append(args, "--model", model)
		}
		if interactive {
			if options.SessionID != "" {
				args = append(args, "--session-id", normalizeString(options.SessionID))
			}
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: normalized, Args: args}, nil
		}
		args = append(args, "--print", "--output-format", "stream-json")
		if options.SessionID != "" {
			args = append(args, "--session-id", normalizeString(options.SessionID))
		}
		args = append(args, prompt)
		return Command{CommandName: normalized, Args: args}, nil

	case "agy":
		if model != "" && IsImageGenerationModel(model) {
			return Command{}, NewCodeError("agy_image_model_unsupported",
				fmt.Sprintf("agy CLI does not support image generation model %s", model))
		}
		// agy 不接受预先指定 conversation id（自动生成）：新会话只走 headless --print。
		args := []string{"--print", prompt, "--dangerously-skip-permissions"}
		if cliModel := ResolveAgyCliModelName(model); cliModel != "" {
			args = append(args, "--model", cliModel)
		}
		return Command{CommandName: "agy", Args: args}, nil

	case "opencode":
		layout := options.Layout
		if layout.ID == "" {
			layout = OpenCodeLayoutV2
		}
		if interactive {
			args := make([]string, 0, 8)
			if model != "" {
				args = append(args, "--model", model)
			}
			if strings.TrimSpace(prompt) != "" {
				args = append(args, "--prompt", prompt)
			}
			args = append(args, OpenCodeRunStandaloneArgs(layout)...)
			return Command{CommandName: "opencode", Args: args}, nil
		}
		args := []string{"run", "--format", "json", "--dangerously-skip-permissions"}
		if model != "" {
			args = append(args, "--model", model)
		}
		args = append(args, OpenCodeRunDirectoryArgs(layout, options.ProjectPath)...)
		args = append(args, OpenCodeRunStandaloneArgs(layout)...)
		args = append(args, prompt)
		return Command{CommandName: "opencode", Args: args}, nil

	case "cline":
		// cline 没有 --print：位置参数即一次性 prompt；--json 后 stdout 是 NDJSON。
		args := make([]string, 0, 4)
		if model != "" {
			args = append(args, "--model", model)
		}
		if interactive {
			args = append(args, "-i")
			return Command{CommandName: "cline", Args: args}, nil
		}
		args = append(args, "--json", prompt)
		return Command{CommandName: "cline", Args: args}, nil

	case "grok":
		args := []string{"--single", prompt, "--output-format", "streaming-json"}
		if options.SessionID != "" {
			args = append(args, "--session-id", normalizeString(options.SessionID))
		}
		if model != "" {
			args = append(args, "--model", model)
		}
		return Command{CommandName: "grok", Args: args}, nil
	}

	return Command{}, NewCodeError("native_session_start_unsupported", "")
}

// BuildResumeCommand 把「续接已有会话」翻译成 CLI 命令（含 session 续接参数）。
func BuildResumeCommand(provider string, options ResumeOptions) (Command, error) {
	normalized := NormalizeProvider(provider)
	sessionID := normalizeString(options.SessionID)
	prompt := options.Prompt
	model := normalizeString(options.Model)
	imagePaths := normalizeImagePaths(options.ImagePaths)
	interactive := options.InteractiveCLI

	if !IsOfficialNativeSessionProvider(normalized) {
		return Command{}, NewCodeError("native_session_resume_unsupported", "")
	}
	if sessionID == "" {
		return Command{}, NewCodeError("missing_session_id", "")
	}
	if !interactive && strings.TrimSpace(prompt) == "" {
		return Command{}, NewCodeError("empty_prompt", "")
	}

	switch normalized {
	case "gemini":
		// gemini 的 --resume 按 cwd→projectHash 发现会话，对 WebUI 不可靠；
		// 优先 --session-file 直接按绝对路径加载，解析不到时回退 --resume。
		resumeArgs := []string{"--resume", sessionID}
		if options.GeminiSessionFile != "" {
			resumeArgs = []string{"--session-file", options.GeminiSessionFile}
		}
		if interactive {
			args := append([]string(nil), resumeArgs...)
			if strings.TrimSpace(prompt) != "" {
				args = append(args, "--prompt-interactive", prompt)
			}
			if model != "" {
				args = append(args, "--model", model)
			}
			return Command{CommandName: "gemini", Args: args}, nil
		}
		args := append([]string(nil), resumeArgs...)
		args = append(args, "--prompt-interactive", prompt)
		if model != "" {
			args = append(args, "--model", model)
		}
		return Command{CommandName: "gemini", Args: args}, nil

	case "codex":
		if interactive {
			args := []string{"resume"}
			if model != "" {
				args = append(args, "-m", model)
			}
			for _, imagePath := range imagePaths {
				args = append(args, "-i", imagePath)
			}
			args = append(args, sessionID)
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: "codex", Args: args}, nil
		}
		args := append([]string(nil), codexHeadlessExecArgs...)
		args = append(args, "resume")
		if model != "" {
			args = append(args, "-m", model)
		}
		for _, imagePath := range imagePaths {
			args = append(args, "-i", imagePath)
		}
		args = append(args, sessionID, prompt)
		return Command{CommandName: "codex", Args: args}, nil

	case "claude":
		if interactive {
			args := make([]string, 0, 6)
			if model != "" {
				args = append(args, "--model", model)
			}
			args = append(args, "--resume", sessionID)
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: "claude", Args: args}, nil
		}
		args := make([]string, 0, 12)
		if model != "" {
			args = append(args, "--model", model)
		}
		args = PushClaudeHeadlessStreamArgs(args)
		if ClaudeUsesStreamJSONInput("claude", interactive, options.Platform) {
			args = append(args, "--input-format", "stream-json", "--resume", sessionID)
		} else {
			args = append(args, "--resume", sessionID, prompt)
		}
		return Command{CommandName: "claude", Args: args}, nil

	case "qoder", "qodercn":
		args := make([]string, 0, 10)
		if model != "" {
			args = append(args, "--model", model)
		}
		if interactive {
			args = append(args, "--resume", sessionID)
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: normalized, Args: args}, nil
		}
		args = append(args, "--print", "--output-format", "stream-json", "--include-partial-messages", "--resume", sessionID, prompt)
		return Command{CommandName: normalized, Args: args}, nil

	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		// IDE 会话（ide-* 项目或 index.json）用独立存储，CLI 续不了，必须回到官方桌面端。
		if strings.HasPrefix(options.ProjectDirName, "ide-") ||
			(options.SessionPath != "" && filepath.Base(options.SessionPath) == "index.json") {
			return Command{}, NewCodeError("native_session_resume_unsupported",
				"CodeBuddy IDE 会话使用独立存储，请在官方 Desktop 中续聊；WebUI 已同步其历史与用量。")
		}
		args := make([]string, 0, 10)
		if model != "" {
			args = append(args, "--model", model)
		}
		if interactive {
			args = append(args, "--resume", sessionID)
			if strings.TrimSpace(prompt) != "" {
				args = append(args, prompt)
			}
			return Command{CommandName: normalized, Args: args}, nil
		}
		args = append(args, "--print", "--output-format", "stream-json", "--resume", sessionID, prompt)
		return Command{CommandName: normalized, Args: args}, nil

	case "grok":
		args := []string{"--single", prompt, "--output-format", "streaming-json", "--resume", sessionID}
		if model != "" {
			args = append(args, "--model", model)
		}
		return Command{CommandName: "grok", Args: args}, nil

	case "agy":
		if model != "" && IsImageGenerationModel(model) {
			return Command{}, NewCodeError("agy_image_model_unsupported",
				fmt.Sprintf("agy CLI does not support image generation model %s", model))
		}
		args := []string{"--conversation", sessionID, "--dangerously-skip-permissions"}
		if strings.TrimSpace(prompt) != "" {
			args = append(args, "--print", prompt)
		}
		if cliModel := ResolveAgyCliModelName(model); cliModel != "" {
			args = append(args, "--model", cliModel)
		}
		return Command{CommandName: "agy", Args: args}, nil

	case "opencode":
		layout := options.Layout
		if layout.ID == "" {
			layout = OpenCodeLayoutV2
		}
		if interactive {
			args := make([]string, 0, 6)
			if model != "" {
				args = append(args, "--model", model)
			}
			args = append(args, "--session", sessionID)
			args = append(args, OpenCodeRunStandaloneArgs(layout)...)
			return Command{CommandName: "opencode", Args: args}, nil
		}
		args := []string{"run", "--format", "json", "--dangerously-skip-permissions", "--session", sessionID}
		if model != "" {
			args = append(args, "--model", model)
		}
		args = append(args, OpenCodeRunStandaloneArgs(layout)...)
		if strings.TrimSpace(prompt) != "" {
			args = append(args, prompt)
		}
		return Command{CommandName: "opencode", Args: args}, nil

	case "cline":
		// cline --id <id> 续接必须 TTY：交互式加 -i；非交互形态保留 --json（CLI 自行报错）。
		args := make([]string, 0, 6)
		if model != "" {
			args = append(args, "--model", model)
		}
		args = append(args, "--id", sessionID)
		if interactive {
			args = append(args, "-i")
			return Command{CommandName: "cline", Args: args}, nil
		}
		args = append(args, "--json", prompt)
		return Command{CommandName: "cline", Args: args}, nil
	}

	return Command{}, NewCodeError("native_session_resume_unsupported", "")
}

// ShellSingleQuote 是 POSIX 单引号转义：把值包进单引号并转义内部的单引号。
func ShellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// BuildInnerCommandFromArgv 把 argv 数组拼成单条安全 shell 命令。
func BuildInnerCommandFromArgv(command string, args []string) string {
	quoted := make([]string, 0, len(args)+1)
	quoted = append(quoted, ShellSingleQuote(command))
	for _, arg := range args {
		quoted = append(quoted, ShellSingleQuote(arg))
	}
	return strings.Join(quoted, " ")
}

// BuildClaudeStreamJSONShellCommand 组装 claude 的 cat-pipe 命令：
// cat '<消息文件>' - | '<cli>' ...，stdin 由消息文件续接 PTY 保持常开。
func BuildClaudeStreamJSONShellCommand(messageFile string, command string, args []string) string {
	return "cat " + ShellSingleQuote(messageFile) + " - | " + BuildInnerCommandFromArgv(command, args)
}

// RunExitMarker 是 tmux run 日志的退出标记前缀（与 Node RUN_EXIT_MARKER 同值）。
const RunExitMarker = "__AIH_RUN_EXIT:"

// BuildRunShellCommand 组装 tmux pane 内执行的 shell 命令：
// 整体重定向到日志，结束后追加退出标记与退出码。
func BuildRunShellCommand(innerShellCommand string, logPath string) string {
	quotedLog := ShellSingleQuote(logPath)
	return "{ " + innerShellCommand + " ; } > " + quotedLog + " 2>&1; printf '\\n" + RunExitMarker + "%s\\n' \"$?\" >> " + quotedLog
}

// socketRunIDSanitizer 去掉 socket 名里不安全的字符（同 Node 的 [^A-Za-z0-9]）。
var socketRunIDSanitizer = regexp.MustCompile("[^A-Za-z0-9]")

// SocketForRun 由 runId 派生 tmux socket 名：保留字母数字、截前 12 位，空则 unknown。
func SocketForRun(runID string) string {
	compact := socketRunIDSanitizer.ReplaceAllString(runID, "")
	if len(compact) > 12 {
		compact = compact[:12]
	}
	if compact == "" {
		compact = "unknown"
	}
	return "aih-run-" + compact
}

// ResolveRunsAIHomeDir 解析 run 清单/日志的落盘根：
// 显式注入 > AIH_HOST_HOME > 宿主家目录，再拼 .ai_home。
func ResolveRunsAIHomeDir(injected string, env map[string]string, hostHomeDir string) string {
	if value := normalizeString(injected); value != "" {
		return value
	}
	hostHome := normalizeString(env["AIH_HOST_HOME"])
	if hostHome == "" {
		hostHome = hostHomeDir
	}
	return filepath.Join(hostHome, ".ai_home")
}

// MultiplexerOptions 是 tmux 化 run 的可用性输入。
type MultiplexerOptions struct {
	// MultiplexerEnv 是 AIH_MULTIPLEXER 的值；off 表示显式关闭。
	MultiplexerEnv string
	InteractiveCLI bool
	Platform       string
	// Available 是调用方探测到的多路复用器可用性（tmux 缺失时为 false）。
	Available bool
}

// ShouldUseTmuxNativeRun 判断本轮是否走 tmux 化 run。
//
// 仅 claude/codex/opencode/agy 的 headless 普通轮；交互式（PTY 全屏）、Windows
// 与探测不可用时一律回退 node-pty。
func ShouldUseTmuxNativeRun(provider string, options MultiplexerOptions) bool {
	if strings.ToLower(normalizeString(options.MultiplexerEnv)) == "off" {
		return false
	}
	switch NormalizeProvider(provider) {
	case "claude", "codex", "opencode", "agy":
	default:
		return false
	}
	if options.InteractiveCLI {
		return false
	}
	if normalizeNodePlatform(options.Platform) == "win32" {
		return false
	}
	return options.Available
}

// ApplyProviderConfigDirArgs 在参数前插入 Provider 声明的账号目录旗标。
//
// 旗标来自 Provider 合同（当前只有 qoder/qodercn 声明 --config-dir）；
// 未声明、目录为空或参数里已有该旗标时原样返回副本。
func ApplyProviderConfigDirArgs(provider string, args []string, runtimeDir string) []string {
	current := append([]string(nil), args...)
	flag := providerConfigDirFlag(provider)
	dir := normalizeString(runtimeDir)
	if flag == "" || dir == "" || containsString(current, flag) {
		return current
	}
	return append([]string{flag, dir}, current...)
}

// containsString 判断切片是否包含指定字符串。
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
