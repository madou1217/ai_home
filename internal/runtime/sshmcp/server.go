// Package sshmcp 承载旧版 `aih __ssh_mcp__` stdio 协议。
//
// 新客户端使用 webuisshapi 的 __mcp-remote-tools（工作区 ID + 更丰富的工具）；
// 这个入口只保留给仍按 `--target/--remote-root` 启动的旧 PTY 会话。它通过系统
// ssh 客户端执行远端命令，工具名与旧 Node 实现一致，额外提供 Go 版的路径校验。
package sshmcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path"
	"strings"
	"time"
)

const commandTimeout = 2 * time.Minute

type server struct {
	target string
	root   string
}

// Run 在 stdin/stdout 上服务旧版 MCP 协议，直到 stdin 关闭。
func Run(target, root string, stdin io.Reader, stdout, stderr io.Writer) error {
	target = strings.TrimSpace(target)
	root = strings.TrimRight(strings.TrimSpace(root), "/")
	if target == "" || root == "" {
		return fmt.Errorf("missing sshTarget or remoteRoot")
	}
	instance := &server{target: target, root: root}
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		reply := instance.handle(line)
		if reply == nil {
			continue
		}
		if err := encoder.Encode(reply); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func (s *server) handle(line []byte) map[string]any {
	var request map[string]any
	if err := json.Unmarshal(line, &request); err != nil {
		return map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Parse error"}}
	}
	id := request["id"]
	method, _ := request["method"].(string)
	switch method {
	case "initialize":
		version := "2025-06-18"
		if params, ok := request["params"].(map[string]any); ok {
			if candidate, ok := params["protocolVersion"].(string); ok && strings.TrimSpace(candidate) != "" {
				version = candidate
			}
		}
		return map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"result": map[string]any{
				"protocolVersion": version,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "aih-ssh-mcp-server", "version": "1.0.0"},
			},
		}
	case "notifications/initialized":
		return nil
	case "ping":
		return map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{}}
	case "tools/list":
		return map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"tools": toolDefinitions()}}
	case "tools/call":
		params, _ := request["params"].(map[string]any)
		name, _ := params["name"].(string)
		arguments, _ := params["arguments"].(map[string]any)
		text, isError := s.callTool(name, arguments)
		return map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"result":  map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": isError},
		}
	}
	if id == nil {
		return nil
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "Method not found"}}
}

func toolDefinitions() []any {
	return []any{
		map[string]any{
			"name":        "view_file",
			"description": "Read the complete content of a remote file from workspace",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string", "description": "Relative path of the file from remote workspace root"}},
				"required":   []any{"path"},
			},
		},
		map[string]any{
			"name":        "edit_file",
			"description": "Write or replace complete file content on remote workspace",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string", "description": "Relative path of the file"}, "content": map[string]any{"type": "string", "description": "Complete content to write"}},
				"required":   []any{"path", "content"},
			},
		},
		map[string]any{
			"name":        "run_command",
			"description": "Execute a bash command in the remote workspace",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"command": map[string]any{"type": "string", "description": "The bash command line to run"}},
				"required":   []any{"command"},
			},
		},
		map[string]any{
			"name":        "list_directory",
			"description": "List contents of a directory in the remote workspace",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string", "description": "Relative path of the directory"}},
				"required":   []any{"path"},
			},
		},
	}
}

func (s *server) callTool(name string, arguments map[string]any) (string, bool) {
	switch name {
	case "view_file":
		relative, ok := safeRelative(arguments["path"])
		if !ok {
			return "invalid path", true
		}
		output, err := s.remote("cat " + shellQuote(s.remotePath(relative)))
		if err != nil {
			return err.Error(), true
		}
		return output, false
	case "edit_file":
		relative, ok := safeRelative(arguments["path"])
		if !ok {
			return "invalid path", true
		}
		content, _ := arguments["content"].(string)
		remotePath := s.remotePath(relative)
		command := "mkdir -p " + shellQuote(path.Dir(remotePath)) + " && cat > " + shellQuote(remotePath)
		if err := s.remoteWithInput(command, strings.NewReader(content)); err != nil {
			return err.Error(), true
		}
		return "Successfully wrote and verified file: " + relative, false
	case "run_command":
		command, _ := arguments["command"].(string)
		if strings.TrimSpace(command) == "" {
			return "empty command", true
		}
		output, err := s.remote("cd " + shellQuote(s.root) + " && (" + command + ")")
		if err != nil {
			return err.Error(), true
		}
		return output, false
	case "list_directory":
		relative, ok := safeRelative(arguments["path"])
		if !ok {
			return "invalid path", true
		}
		directory := s.root
		if relative != "" {
			directory = s.remotePath(relative)
		}
		output, err := s.remote("cd " + shellQuote(directory) + " && ls -1Ap")
		if err != nil {
			return err.Error(), true
		}
		lines := strings.Split(strings.TrimSpace(output), "\n")
		entries := make([]string, 0, len(lines))
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if strings.HasSuffix(line, "/") {
				entries = append(entries, "[DIRECTORY] "+strings.TrimSuffix(line, "/"))
			} else {
				entries = append(entries, "[FILE] "+line)
			}
		}
		if len(entries) == 0 {
			return "(empty)", false
		}
		return strings.Join(entries, "\n"), false
	default:
		return "Unknown tool: " + name, true
	}
}

func safeRelative(value any) (string, bool) {
	text, _ := value.(string)
	text = strings.ReplaceAll(strings.TrimSpace(text), "\\", "/")
	text = strings.TrimPrefix(text, "/")
	if text == "" {
		return "", true
	}
	cleaned := path.Clean(text)
	if cleaned == "." {
		return "", true
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		return "", false
	}
	return cleaned, true
}

func (s *server) remotePath(relative string) string {
	if relative == "" {
		return s.root
	}
	return s.root + "/" + relative
}

func (s *server) remote(command string) (string, error) {
	return s.remoteCommand(command, nil)
}

func (s *server) remoteWithInput(command string, input io.Reader) error {
	_, err := s.remoteCommand(command, input)
	return err
}

func (s *server) remoteCommand(command string, input io.Reader) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ssh", s.target, command)
	if input != nil {
		cmd.Stdin = input
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	output := strings.TrimSpace(stdout.String())
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("远程执行失败(Exit Code %d): %s", exitCode(err), detail)
	}
	return output, nil
}

func exitCode(err error) int {
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return 1
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
