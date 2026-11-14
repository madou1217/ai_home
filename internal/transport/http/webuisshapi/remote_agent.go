package webuisshapi

// 远程 agent 终端的 Go 启动参数构造。
//
// 与 Node 的 pty-runtime-spawn 对齐：provider CLI 直接启动，MCP server 指向
// 宿主二进制的 __mcp-remote-tools；launch context 只放工作区与 AIH 根目录。
// Claude 用 --mcp-config / --disallowedTools / --append-system-prompt；
// Codex 用 -c TOML 覆盖挂 MCP 并关掉本机 shell 工具。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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
	providerPath, err := exec.LookPath(agent)
	if err != nil {
		return "", nil, nil, fmt.Errorf("找不到 %s CLI: %w", agent, err)
	}
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
	switch agent {
	case "claude":
		configRaw, _ := json.Marshal(map[string]any{
			"mcpServers": map[string]any{remoteAgentMCPName: mcpServer},
		})
		args := []string{
			"--mcp-config", string(configRaw),
			"--disallowedTools", strings.Join(remoteAgentLocalTools, ","),
			"--append-system-prompt", remoteAgentInstructions,
		}
		return providerPath, args, env, nil
	case "codex":
		config := map[string]any{
			"features.shell_tool":                                     false,
			"features.unified_exec":                                   false,
			"project_doc_max_bytes":                                   0,
			"developer_instructions":                                  remoteAgentInstructions,
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
