package sessionchat

import (
	"fmt"
	"path/filepath"
	"strings"
)

// commandParams 是命令构造的规范化公共输入。
type commandParams struct {
	Provider    string
	Prompt      string
	Model       string
	ImagePaths  []string
	Interactive bool
}

// startCommandParams 是新建会话命令的输入。
type startCommandParams struct {
	commandParams
	// SessionID 保留原值：既有逻辑用「原值非空」决定是否拼 --session-id，
	// 再对拼进去的值做 normalize，不能提前归一。
	SessionID   string
	ProjectPath string
	Platform    string
	Layout      OpenCodeLayout
}

// resumeCommandParams 是续接会话命令的输入。
type resumeCommandParams struct {
	commandParams
	SessionID         string
	GeminiSessionFile string
	ProjectDirName    string
	SessionPath       string
	Platform          string
	Layout            OpenCodeLayout
}

type startCommandBuilder func(startCommandParams) (Command, error)
type resumeCommandBuilder func(resumeCommandParams) (Command, error)

// startCommandBuilders 按 Provider 登记新建会话的命令构造器。
//
// 命令构造是「行为」（交互/headless、resume/新建、模型与图片参数各有分支），
// 不属于 manifest 的声明事实；这里只把 Provider→构造器的分派收进注册表。
var startCommandBuilders = map[string]startCommandBuilder{
	"gemini":      buildGeminiStartCommand,
	"codex":       buildCodexStartCommand,
	"claude":      buildClaudeStartCommand,
	"qoder":       buildQoderStartCommand,
	"qodercn":     buildQoderStartCommand,
	"codebuddy":   buildFamilyStartCommand,
	"codebuddycn": buildFamilyStartCommand,
	"workbuddy":   buildFamilyStartCommand,
	"workbuddycn": buildFamilyStartCommand,
	"agy":         buildAgyStartCommand,
	"opencode":    buildOpenCodeStartCommand,
	"cline":       buildClineStartCommand,
	"grok":        buildGrokStartCommand,
}

var resumeCommandBuilders = map[string]resumeCommandBuilder{
	"gemini":      buildGeminiResumeCommand,
	"codex":       buildCodexResumeCommand,
	"claude":      buildClaudeResumeCommand,
	"qoder":       buildQoderResumeCommand,
	"qodercn":     buildQoderResumeCommand,
	"codebuddy":   buildFamilyResumeCommand,
	"codebuddycn": buildFamilyResumeCommand,
	"workbuddy":   buildFamilyResumeCommand,
	"workbuddycn": buildFamilyResumeCommand,
	"grok":        buildGrokResumeCommand,
	"agy":         buildAgyResumeCommand,
	"opencode":    buildOpenCodeResumeCommand,
	"cline":       buildClineResumeCommand,
}

func buildGeminiStartCommand(params startCommandParams) (Command, error) {
	if params.Interactive {
		args := make([]string, 0, 6)
		if params.SessionID != "" {
			args = append(args, "--session-id", normalizeString(params.SessionID))
		}
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, "--prompt-interactive", params.Prompt)
		}
		if params.Model != "" {
			args = append(args, "--model", params.Model)
		}
		return Command{CommandName: "gemini", Args: args}, nil
	}
	args := []string{"--prompt-interactive", params.Prompt}
	if params.SessionID != "" {
		args = append([]string{"--session-id", normalizeString(params.SessionID)}, args...)
	}
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	return Command{CommandName: "gemini", Args: args}, nil
}

func buildCodexStartCommand(params startCommandParams) (Command, error) {
	if params.Interactive {
		args := make([]string, 0, 8)
		if params.Model != "" {
			args = append(args, "-m", params.Model)
		}
		for _, imagePath := range params.ImagePaths {
			args = append(args, "-i", imagePath)
		}
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: "codex", Args: args}, nil
	}
	args := append([]string(nil), codexHeadlessExecArgs...)
	if params.Model != "" {
		args = append(args, "-m", params.Model)
	}
	for _, imagePath := range params.ImagePaths {
		args = append(args, "-i", imagePath)
	}
	if params.ProjectPath != "" {
		args = append(args, "-C", normalizeString(params.ProjectPath))
	}
	args = append(args, params.Prompt)
	return Command{CommandName: "codex", Args: args}, nil
}

func buildClaudeStartCommand(params startCommandParams) (Command, error) {
	if params.Interactive {
		args := make([]string, 0, 6)
		if params.Model != "" {
			args = append(args, "--model", params.Model)
		}
		if params.SessionID != "" {
			args = append(args, "--session-id", normalizeString(params.SessionID))
		}
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: "claude", Args: args}, nil
	}
	args := make([]string, 0, 12)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	args = PushClaudeHeadlessStreamArgs(args)
	if params.SessionID != "" {
		args = append(args, "--session-id", normalizeString(params.SessionID))
	}
	if ClaudeUsesStreamJSONInput("claude", params.Interactive, params.Platform) {
		// 图片与 prompt 经 stdin 的 stream-json 消息送达，不再做位置参数。
		args = append(args, "--input-format", "stream-json")
	} else {
		args = append(args, params.Prompt)
	}
	return Command{CommandName: "claude", Args: args}, nil
}

func buildQoderStartCommand(params startCommandParams) (Command, error) {
	args := make([]string, 0, 10)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	if params.Interactive {
		if params.SessionID != "" {
			args = append(args, "--session-id", normalizeString(params.SessionID))
		}
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: params.Provider, Args: args}, nil
	}
	args = append(args, "--print", "--output-format", "stream-json", "--include-partial-messages")
	if params.SessionID != "" {
		args = append(args, "--session-id", normalizeString(params.SessionID))
	}
	args = append(args, params.Prompt)
	return Command{CommandName: params.Provider, Args: args}, nil
}

func buildFamilyStartCommand(params startCommandParams) (Command, error) {
	// 新建会话用预生成的 uuid 固定 --session-id，便于随后按文件定位并续聊。
	args := make([]string, 0, 8)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	if params.Interactive {
		if params.SessionID != "" {
			args = append(args, "--session-id", normalizeString(params.SessionID))
		}
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: params.Provider, Args: args}, nil
	}
	args = append(args, "--print", "--output-format", "stream-json")
	if params.SessionID != "" {
		args = append(args, "--session-id", normalizeString(params.SessionID))
	}
	args = append(args, params.Prompt)
	return Command{CommandName: params.Provider, Args: args}, nil
}

func buildAgyStartCommand(params startCommandParams) (Command, error) {
	if params.Model != "" && IsImageGenerationModel(params.Model) {
		return Command{}, NewCodeError("agy_image_model_unsupported",
			fmt.Sprintf("agy CLI does not support image generation model %s", params.Model))
	}
	// agy 不接受预先指定 conversation id（自动生成）：新会话只走 headless --print。
	args := []string{"--print", params.Prompt, "--output-format", "stream-json", "--dangerously-skip-permissions"}
	if params.Model != "" {
		cliModel := ResolveAgyCliModelName(params.Model)
		if cliModel == "" {
			return Command{}, NewCodeError("agy_model_unsupported", "Selected AGY model has no supported CLI mapping")
		}
		args = append(args, "--model", cliModel)
	}
	return Command{CommandName: "agy", Args: args}, nil
}

func buildOpenCodeStartCommand(params startCommandParams) (Command, error) {
	layout := params.Layout
	if layout.ID == "" {
		layout = OpenCodeLayoutV2
	}
	if params.Interactive {
		args := make([]string, 0, 8)
		if params.Model != "" {
			args = append(args, "--model", params.Model)
		}
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, "--prompt", params.Prompt)
		}
		args = append(args, OpenCodeRunStandaloneArgs(layout)...)
		return Command{CommandName: "opencode", Args: args}, nil
	}
	args := []string{"run", "--format", "json", "--dangerously-skip-permissions"}
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	args = append(args, OpenCodeRunDirectoryArgs(layout, params.ProjectPath)...)
	args = append(args, OpenCodeRunStandaloneArgs(layout)...)
	args = append(args, params.Prompt)
	return Command{CommandName: "opencode", Args: args}, nil
}

func buildClineStartCommand(params startCommandParams) (Command, error) {
	// cline 没有 --print：位置参数即一次性 prompt；--json 后 stdout 是 NDJSON。
	args := make([]string, 0, 4)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	if params.Interactive {
		args = append(args, "-i")
		return Command{CommandName: "cline", Args: args}, nil
	}
	args = append(args, "--json", params.Prompt)
	return Command{CommandName: "cline", Args: args}, nil
}

func buildGrokStartCommand(params startCommandParams) (Command, error) {
	args := []string{"--single", params.Prompt, "--output-format", "streaming-json"}
	if params.SessionID != "" {
		args = append(args, "--session-id", normalizeString(params.SessionID))
	}
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	return Command{CommandName: "grok", Args: args}, nil
}

func buildGeminiResumeCommand(params resumeCommandParams) (Command, error) {
	// gemini 的 --resume 按 cwd→projectHash 发现会话，对 WebUI 不可靠；
	// 优先 --session-file 直接按绝对路径加载，解析不到时回退 --resume。
	resumeArgs := []string{"--resume", params.SessionID}
	if params.GeminiSessionFile != "" {
		resumeArgs = []string{"--session-file", params.GeminiSessionFile}
	}
	if params.Interactive {
		args := append([]string(nil), resumeArgs...)
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, "--prompt-interactive", params.Prompt)
		}
		if params.Model != "" {
			args = append(args, "--model", params.Model)
		}
		return Command{CommandName: "gemini", Args: args}, nil
	}
	args := append([]string(nil), resumeArgs...)
	args = append(args, "--prompt-interactive", params.Prompt)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	return Command{CommandName: "gemini", Args: args}, nil
}

func buildCodexResumeCommand(params resumeCommandParams) (Command, error) {
	if params.Interactive {
		args := []string{"resume"}
		if params.Model != "" {
			args = append(args, "-m", params.Model)
		}
		for _, imagePath := range params.ImagePaths {
			args = append(args, "-i", imagePath)
		}
		args = append(args, params.SessionID)
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: "codex", Args: args}, nil
	}
	args := append([]string(nil), codexHeadlessExecArgs...)
	args = append(args, "resume")
	if params.Model != "" {
		args = append(args, "-m", params.Model)
	}
	for _, imagePath := range params.ImagePaths {
		args = append(args, "-i", imagePath)
	}
	args = append(args, params.SessionID, params.Prompt)
	return Command{CommandName: "codex", Args: args}, nil
}

func buildClaudeResumeCommand(params resumeCommandParams) (Command, error) {
	if params.Interactive {
		args := make([]string, 0, 6)
		if params.Model != "" {
			args = append(args, "--model", params.Model)
		}
		args = append(args, "--resume", params.SessionID)
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: "claude", Args: args}, nil
	}
	args := make([]string, 0, 12)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	args = PushClaudeHeadlessStreamArgs(args)
	if ClaudeUsesStreamJSONInput("claude", params.Interactive, params.Platform) {
		args = append(args, "--input-format", "stream-json", "--resume", params.SessionID)
	} else {
		args = append(args, "--resume", params.SessionID, params.Prompt)
	}
	return Command{CommandName: "claude", Args: args}, nil
}

func buildQoderResumeCommand(params resumeCommandParams) (Command, error) {
	args := make([]string, 0, 10)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	if params.Interactive {
		args = append(args, "--resume", params.SessionID)
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: params.Provider, Args: args}, nil
	}
	args = append(args, "--print", "--output-format", "stream-json", "--include-partial-messages", "--resume", params.SessionID, params.Prompt)
	return Command{CommandName: params.Provider, Args: args}, nil
}

func buildFamilyResumeCommand(params resumeCommandParams) (Command, error) {
	// IDE 会话（ide-* 项目或 index.json）用独立存储，CLI 续不了，必须回到官方桌面端。
	if strings.HasPrefix(params.ProjectDirName, "ide-") ||
		(params.SessionPath != "" && filepath.Base(params.SessionPath) == "index.json") {
		return Command{}, NewCodeError("native_session_resume_unsupported",
			"CodeBuddy IDE 会话使用独立存储，请在官方 Desktop 中续聊；WebUI 已同步其历史与用量。")
	}
	args := make([]string, 0, 10)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	if params.Interactive {
		args = append(args, "--resume", params.SessionID)
		if strings.TrimSpace(params.Prompt) != "" {
			args = append(args, params.Prompt)
		}
		return Command{CommandName: params.Provider, Args: args}, nil
	}
	args = append(args, "--print", "--output-format", "stream-json", "--resume", params.SessionID, params.Prompt)
	return Command{CommandName: params.Provider, Args: args}, nil
}

func buildGrokResumeCommand(params resumeCommandParams) (Command, error) {
	args := []string{"--single", params.Prompt, "--output-format", "streaming-json", "--resume", params.SessionID}
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	return Command{CommandName: "grok", Args: args}, nil
}

func buildAgyResumeCommand(params resumeCommandParams) (Command, error) {
	if params.Model != "" && IsImageGenerationModel(params.Model) {
		return Command{}, NewCodeError("agy_image_model_unsupported",
			fmt.Sprintf("agy CLI does not support image generation model %s", params.Model))
	}
	if strings.TrimSpace(params.Prompt) == "" {
		return Command{}, NewCodeError("agy_headless_prompt_required", "AGY native resume requires a headless prompt")
	}
	args := []string{"--conversation", params.SessionID, "--print", params.Prompt, "--output-format", "stream-json", "--dangerously-skip-permissions"}
	if params.Model != "" {
		cliModel := ResolveAgyCliModelName(params.Model)
		if cliModel == "" {
			return Command{}, NewCodeError("agy_model_unsupported", "Selected AGY model has no supported CLI mapping")
		}
		args = append(args, "--model", cliModel)
	}
	return Command{CommandName: "agy", Args: args}, nil
}

func buildOpenCodeResumeCommand(params resumeCommandParams) (Command, error) {
	layout := params.Layout
	if layout.ID == "" {
		layout = OpenCodeLayoutV2
	}
	if params.Interactive {
		args := make([]string, 0, 6)
		if params.Model != "" {
			args = append(args, "--model", params.Model)
		}
		args = append(args, "--session", params.SessionID)
		args = append(args, OpenCodeRunStandaloneArgs(layout)...)
		return Command{CommandName: "opencode", Args: args}, nil
	}
	args := []string{"run", "--format", "json", "--dangerously-skip-permissions", "--session", params.SessionID}
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	args = append(args, OpenCodeRunStandaloneArgs(layout)...)
	if strings.TrimSpace(params.Prompt) != "" {
		args = append(args, params.Prompt)
	}
	return Command{CommandName: "opencode", Args: args}, nil
}

func buildClineResumeCommand(params resumeCommandParams) (Command, error) {
	// cline --id <id> 续接必须 TTY：交互式加 -i；非交互形态保留 --json（CLI 自行报错）。
	args := make([]string, 0, 6)
	if params.Model != "" {
		args = append(args, "--model", params.Model)
	}
	args = append(args, "--id", params.SessionID)
	if params.Interactive {
		args = append(args, "-i")
		return Command{CommandName: "cline", Args: args}, nil
	}
	args = append(args, "--json", params.Prompt)
	return Command{CommandName: "cline", Args: args}, nil
}
