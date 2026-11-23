package webuisshapi

// 远程 agent 终端的 Go 启动参数构造。
//
// 与 Node 的 pty-runtime-spawn 对齐：provider CLI 直接启动，MCP server 指向
// 宿主二进制的 __mcp-remote-tools；launch context 只放工作区与 AIH 根目录。
// Claude 用 --mcp-config / --disallowedTools / --append-system-prompt；
// Codex 用 -c TOML 覆盖挂 MCP 并关掉本机 shell 工具。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/mcpscope"
	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/runtime/accountmcps"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

const remoteAgentMCPName = "aih_remote"

var remoteAgentLocalTools = []string{
	"Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
}

const remoteAgentInstructions = "你在一个「远程工作区」里工作：项目文件在远端机器上，不在本机。" +
	"只能用 aih_remote 提供的工具（read_file / write_file / edit_file / list_directory / search / run_command）" +
	"读写文件和执行命令；路径一律相对工作区根目录。修改文件前先 read_file，写回时带上它返回的 version。" +
	"本机当前目录是一个空的占位目录，不要在本机查找项目文件。"

// buildRemoteAgentLaunch 返回 provider 可执行文件和参数。
func buildRemoteAgentLaunch(aiHomeDir, workspaceID, agent string) (string, []string, []string, error) {
	executable, err := os.Executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return "", nil, nil, errors.New("aih-server executable unavailable")
	}
	contextDir := filepath.Join(aiHomeDir, "run", "launch-context")
	if err := os.MkdirAll(contextDir, 0o700); err != nil {
		return "", nil, nil, err
	}
	contextPath := filepath.Join(contextDir, "remote-tools-direct-"+randomHex(6)+".json")
	raw, _ := json.Marshal(map[string]any{
		"aiHomeDir":   aiHomeDir,
		"workspaceId": workspaceID,
	})
	if err := os.WriteFile(contextPath, raw, 0o600); err != nil {
		return "", nil, nil, err
	}
	mcpServer := map[string]any{
		"command": executable,
		"args":    []string{"__mcp-remote-tools"},
		"env":     map[string]string{"AIH_LAUNCH_CONTEXT": contextPath},
	}
	env := []string{"AIH_HOME_DIR=" + aiHomeDir}
	return buildProviderMCPLaunch(agent, mcpServer, env, remoteAgentInstructions)
}

func connectorAgentInstructions(capabilities remoteconnector.Capabilities) string {
	instructions := "你在一个「本地工作区」里工作：项目文件在用户本机，通过 Workspace Connector 访问；模型和你在 AIH Server 上。" +
		"只能用 aih_remote 提供的工具访问项目；路径一律相对工作区根目录。" +
		"修改文件前先 read_file，写回时带上它返回的 version。本机当前目录是一个空的占位目录，不要在本机查找项目文件。"
	normalized := remoteconnector.NormalizeCapabilities(capabilities)
	if normalized.RunCommand {
		instructions += "可以用 run_command 在工作区内执行短命令（如 git status、单个测试）；命令以本机用户权限运行，不是沙箱，避免交互式命令。"
	}
	if normalized.StartJob && normalized.WatchJob && normalized.InterruptJob {
		instructions += "长任务（构建、全量测试、开发服务器）必须用 start_job 启动，再用 watch_job 带上一次返回的 cursor 读取增量输出；需要停止时用 interrupt_job。不要用 run_command 长时间阻塞。"
	}
	return instructions
}

// buildConnectorAgentLaunch builds a provider launch whose MCP bridge forwards
// tool calls to the Server tool endpoint instead of opening SSH. The provider
// still runs on the AIH Server; only the workspace files are local.
// mcpEnabledForAccount applies the account MCP policy at launch time. An empty
// account keeps the current behavior; policy lookup failures fail open so a
// missing database never blocks a session.
func mcpEnabledForAccount(aiHomeDir, accountRef, agent string) bool {
	accountRef = strings.TrimSpace(accountRef)
	if accountRef == "" {
		return true
	}
	store, err := accountmcps.NewStore(aiHomeDir)
	if err != nil {
		return true
	}
	policy, err := store.Get(context.Background(), accountRef)
	if err != nil {
		return true
	}
	resolved, err := mcpscope.Resolve(mcpscope.Builtins(), policy, mcpscope.Context{Provider: agent, WorkspaceBound: true})
	if err != nil {
		return true
	}
	for _, item := range resolved {
		if item.ID == mcpscope.IDRemoteTools {
			return true
		}
	}
	return false
}

func buildConnectorAgentLaunch(
	aiHomeDir, workspaceID, agent, toolsURL, toolToken string,
	capabilities remoteconnector.Capabilities,
	accountRef string,
) (string, []string, []string, error) {
	if !mcpEnabledForAccount(aiHomeDir, accountRef, agent) {
		providerPath, err := exec.LookPath(agent)
		if err != nil {
			return "", nil, nil, fmt.Errorf("找不到 %s CLI: %w", agent, err)
		}
		return providerPath, nil, []string{"AIH_HOME_DIR=" + aiHomeDir}, nil
	}
	switch agent {
	case "codex", "claude":
	case "agy":
		return "", nil, nil, ErrAGYRemoteUnsupported
	default:
		return "", nil, nil, fmt.Errorf("远程工作区不支持 %s", agent)
	}
	if strings.TrimSpace(toolsURL) == "" || strings.TrimSpace(toolToken) == "" {
		return "", nil, nil, errors.New("connector tool endpoint is not configured")
	}
	executable, err := os.Executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return "", nil, nil, errors.New("aih-server executable unavailable")
	}
	contextDir := filepath.Join(aiHomeDir, "run", "launch-context")
	if err := os.MkdirAll(contextDir, 0o700); err != nil {
		return "", nil, nil, err
	}
	contextPath := filepath.Join(contextDir, "connector-tools-"+randomHex(6)+".json")
	raw, _ := json.Marshal(map[string]any{
		"toolsUrl": toolsURL,
		"token":    toolToken,
		"tools":    workspaceconnector.ToolDefinitionsFor(capabilities),
	})
	if err := os.WriteFile(contextPath, raw, 0o600); err != nil {
		return "", nil, nil, err
	}
	mcpServer := map[string]any{
		"command": executable,
		"args":    []string{"__mcp-remote-tools"},
		"env":     map[string]string{"AIH_LAUNCH_CONTEXT": contextPath},
	}
	env := []string{"AIH_HOME_DIR=" + aiHomeDir}
	return buildProviderMCPLaunch(agent, mcpServer, env, connectorAgentInstructions(capabilities))
}

var ErrAGYRemoteUnsupported = errors.New("agy_remote_workspace_unsupported")

func buildProviderMCPLaunch(agent string, mcpServer map[string]any, env []string, instructions string) (string, []string, []string, error) {
	providerPath, err := exec.LookPath(agent)
	if err != nil {
		return "", nil, nil, fmt.Errorf("找不到 %s CLI: %w", agent, err)
	}
	switch agent {
	case "claude":
		configRaw, _ := json.Marshal(map[string]any{
			"mcpServers": map[string]any{remoteAgentMCPName: mcpServer},
		})
		args := []string{
			"--mcp-config", string(configRaw),
			"--disallowedTools", strings.Join(remoteAgentLocalTools, ","),
			"--append-system-prompt", instructions,
		}
		return providerPath, args, env, nil
	case "codex":
		config := map[string]any{
			"features.shell_tool":                                     false,
			"features.unified_exec":                                   false,
			"project_doc_max_bytes":                                   0,
			"developer_instructions":                                  instructions,
			"mcp_servers." + remoteAgentMCPName + ".command":          mcpServer["command"],
			"mcp_servers." + remoteAgentMCPName + ".args":             mcpServer["args"],
			"mcp_servers." + remoteAgentMCPName + ".env":              mcpServer["env"],
			"mcp_servers." + remoteAgentMCPName + ".tool_timeout_sec": 35 * 60,
		}
		keys := make([]string, 0, len(config))
		for key := range config {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		args := make([]string, 0, len(keys)*2)
		for _, key := range keys {
			args = append(args, "-c", key+"="+tomlValue(config[key]))
		}
		return providerPath, args, env, nil
	}
	return "", nil, nil, fmt.Errorf("远程工作区不支持 %s", agent)
}

// tomlValue 与 Node 的 tomlValue 同口径：字符串用 JSON 引号，对象/数组递归。
func tomlValue(value any) string {
	switch typed := value.(type) {
	case string:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	case bool:
		return strconv.FormatBool(typed)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case []string:
		items := make([]string, 0, len(typed))
		for _, item := range typed {
			items = append(items, tomlValue(item))
		}
		return "[" + strings.Join(items, ", ") + "]"
	case map[string]string:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, tomlKey(key)+" = "+tomlValue(typed[key]))
		}
		return "{ " + strings.Join(parts, ", ") + " }"
	}
	return "\"\""
}

func tomlKey(key string) string {
	for _, char := range key {
		if !(char == '_' || char == '-' || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9')) {
			encoded, _ := json.Marshal(key)
			return string(encoded)
		}
	}
	return key
}
