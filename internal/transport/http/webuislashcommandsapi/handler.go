// Package webuislashcommandsapi 提供 WebUI 输入框的 slash 命令自动补全契约。
//
// 契约边界（对齐 Node GET /v0/webui/slash-commands）：
//   - 响应键固定为 ok / provider / commands / slashPassthrough；commands 的每一项固定为
//     command / description / argumentHint / aliases / source（别名数组永远不是 null）。
//   - 内置清单是 lib/server/native-slash-command-catalog.js 的逐条移植（见 catalog_data.go），
//     仅供 autocomplete；权威始终是各 provider 的真实 CLI。
//   - claude 额外合并用户自定义命令目录（<HOME>/.claude/commands/**/*.md，或 CLAUDE_CONFIG_DIR
//     指向的配置根下的 commands/），按 Node 的 `目录:文件名` 规则生成 /<dir>:<name>。
//   - 排序沿用 Node：claude 按命令名升序（Node 用 localeCompare，这里用字节序，命令名是 ASCII
//     时两者一致）；其余 provider 保持清单原顺序。
//
// 与 Node 的对齐及差异：
//   - provider 缺失返回 400 missing_provider；未知但非空的 provider 直接返回 200 + 空清单（与 Node
//     一致，便于路由层零回退直通 Go），同时绝不触发任何文件系统扫描。
//   - 用户自定义命令会读 frontmatter 的 description / argument-hint；Node 固定写死
//     「用户自定义命令」与空 hint。没有 frontmatter 时回落到 Node 的原值，键与类型不变。
//   - 扫描有上限（条目数 / 深度 / 单文件大小），触顶时响应带 truncated=true；正常情况该键省略。
//
// 扫描安全边界：不跟随符号链接（Node 的 Dirent 语义同样把符号链接排除在 isFile/isDirectory
// 之外），根目录解析成真实路径后作为越界判定基线，任何逃出根目录的路径都不读。
package webuislashcommandsapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// Path 是 slash 命令自动补全的 WebUI 契约路径。
//
//	GET /v1/management/webui/slash-commands?provider=claude
const Path = "/v1/management/webui/slash-commands"

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或宿主 HOME。
var ErrInvalidDependencies = errors.New("slash 命令接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 slash 命令接口的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主 HOME；用户自定义命令在 <HostHomeDir>/.claude/commands 下。
	HostHomeDir string
}

// Command 是一条 slash 命令。字段名与 Node 的 autocomplete 条目一一对应。
type Command struct {
	Command      string   `json:"command"`
	Description  string   `json:"description"`
	ArgumentHint string   `json:"argumentHint"`
	Aliases      []string `json:"aliases"`
	Source       string   `json:"source"`
}

type response struct {
	OK               bool      `json:"ok"`
	Provider         string    `json:"provider"`
	Commands         []Command `json:"commands"`
	SlashPassthrough bool      `json:"slashPassthrough"`
	// Truncated 只在扫描触顶时出现，避免调用方把「被截断的清单」当成全量。
	Truncated bool `json:"truncated,omitempty"`
}

// errorResponse 沿用 Node 本接口的扁平错误形状（ok + error 字符串）。
type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// Handler 是 slash 命令自动补全的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	// builtin 是 provider -> 内置清单；值在构造时拷贝，请求路径只读。
	builtin map[string][]Command
	// passthrough 记录「未匹配命令也放行给 CLI」的 provider（Node 口径：
	// clients.cli 为真且声明了 CLI 启动合同）。
	passthrough map[string]bool
	// known 是已注册 provider 全集，用于 provider 参数校验。
	known map[string]bool
}

// NewHandler 校验依赖并创建 Handler。
//
// provider 全集来自 core/providers 的内置合同，不在这里另写白名单：
// 新增 provider 只需在合同里登记，本接口自动识别，不会误报 400。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if dependencies.Authorizer == nil || hostHomeDir == "" {
		return nil, ErrInvalidDependencies
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	known := make(map[string]bool, len(catalog.List()))
	for _, definition := range catalog.List() {
		known[definition.ID] = true
	}
	handler := &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: hostHomeDir,
		builtin:     builtinCommandsByProvider(),
		passthrough: make(map[string]bool, len(known)),
	}
	for _, definition := range catalog.List() {
		// Node: definition.clients.cli && definition.cli。
		handler.passthrough[definition.ID] = definition.Clients.CLI && definition.CLI != nil
	}
	// 静态清单覆盖的 provider 一定算已注册：清单本身就是这些 provider 的合同证据。
	for providerID := range handler.builtin {
		known[providerID] = true
	}
	handler.known = known
	return handler, nil
}

// ServeHTTP 只接受 GET，且必须先通过鉴权。
func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_slash_commands_unavailable", "slash 命令服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取命令清单")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("provider")))
	if provider == "" {
		writeError(responseWriter, http.StatusBadRequest, "missing_provider", "缺少 provider 参数")
		return
	}
	// 未知 provider 不触发任何文件系统扫描，直接按 Node 语义返回 200 + 空清单。
	if !handler.known[provider] {
		writeJSON(responseWriter, http.StatusOK, response{
			OK:               true,
			Provider:         provider,
			Commands:         []Command{},
			SlashPassthrough: handler.passthrough[provider],
		})
		return
	}
	commands, truncated := handler.commandsFor(provider)
	writeJSON(responseWriter, http.StatusOK, response{
		OK:               true,
		Provider:         provider,
		Commands:         commands,
		SlashPassthrough: handler.passthrough[provider],
		Truncated:        truncated,
	})
}

// commandsFor 返回某 provider 的完整清单；truncated 表示用户命令目录扫描触顶。
func (handler *Handler) commandsFor(provider string) ([]Command, bool) {
	builtin := handler.builtin[provider]
	if provider != providerClaude {
		return cloneCommands(builtin), false
	}
	// 用户命令按 provider 派生目录，目前只有 claude 有权威的本地命令目录。
	scanned, truncated := scanUserCommands(handler.claudeCommandsDir())
	merged := make([]Command, 0, len(builtin)+len(scanned))
	seen := make(map[string]struct{}, len(builtin)+len(scanned))
	for _, candidate := range append(cloneCommands(builtin), scanned...) {
		if _, duplicated := seen[candidate.Command]; duplicated {
			continue
		}
		seen[candidate.Command] = struct{}{}
		merged = append(merged, candidate)
	}
	sort.Slice(merged, func(left, right int) bool {
		return merged[left].Command < merged[right].Command
	})
	return merged, truncated
}

// builtinCommandsByProvider 把静态清单按 provider 分组。
func builtinCommandsByProvider() map[string][]Command {
	return map[string][]Command{
		providerClaude:   claudeBuiltinCommands,
		providerCodex:    codexBuiltinCommands,
		providerOpenCode: opencodeBuiltinCommands,
		providerAgy:      agyBuiltinCommands,
		providerGemini:   geminiBuiltinCommands,
	}
}

// cloneCommands 返回防御性副本：别名数组必须非 nil，保证 JSON 输出 [] 而不是 null。
func cloneCommands(commands []Command) []Command {
	cloned := make([]Command, 0, len(commands))
	for _, command := range commands {
		aliases := make([]string, len(command.Aliases))
		copy(aliases, command.Aliases)
		command.Aliases = aliases
		cloned = append(cloned, command)
	}
	return cloned
}

func writeJSON(responseWriter http.ResponseWriter, status int, payload any) {
	responseWriter.Header().Set("Content-Type", "application/json; charset=utf-8")
	responseWriter.Header().Set("Cache-Control", "no-store")
	responseWriter.WriteHeader(status)
	_ = json.NewEncoder(responseWriter).Encode(payload)
}

func writeError(responseWriter http.ResponseWriter, status int, code, message string) {
	writeJSON(responseWriter, status, errorResponse{OK: false, Error: code, Message: message})
}
