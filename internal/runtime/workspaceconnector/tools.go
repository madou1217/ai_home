package workspaceconnector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	maxToolReadBytes    = 512 * 1024
	maxToolLines        = 4000
	maxToolCommandBytes = 64 * 1024
)

// ToolDefinitions is the provider-facing contract shared by the MCP bridge and
// the internal tool endpoint. run_command is synchronous and only advertised
// when the live connector declares the capability; durable jobs and approvals
// remain unimplemented.
func ToolDefinitions() []map[string]any {
	return []map[string]any{
		{
			"name":        "read_file",
			"description": "读取本地工作区内的文本文件。返回 version；写回时作为 expected_version，防止覆盖别人的修改。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":   map[string]any{"type": "string", "description": "相对工作区根目录的路径"},
					"offset": map[string]any{"type": "integer", "description": "起始行（从 1 开始，可选）"},
					"limit":  map[string]any{"type": "integer", "description": "最多读取的行数（可选）"},
				},
				"required": []any{"path"},
			},
		},
		{
			"name":        "write_file",
			"description": "写入（覆盖或新建）本地工作区文件，先校验版本再替换。修改已有文件时必须传 read_file 返回的 expected_version；新建文件传空字符串。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":             map[string]any{"type": "string"},
					"content":          map[string]any{"type": "string"},
					"expected_version": map[string]any{"type": "string", "description": "read_file 返回的 version；新建文件传空字符串"},
				},
				"required": []any{"path", "content", "expected_version"},
			},
		},
		{
			"name":        "edit_file",
			"description": "把文件中的 old_string 精确替换为 new_string（old_string 必须唯一，除非 replace_all=true）。自动做版本校验。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":        map[string]any{"type": "string"},
					"old_string":  map[string]any{"type": "string"},
					"new_string":  map[string]any{"type": "string"},
					"replace_all": map[string]any{"type": "boolean"},
				},
				"required": []any{"path", "old_string", "new_string"},
			},
		},
		{
			"name":        "list_directory",
			"description": "列出本地工作区内某个目录的条目（目录在前）。",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string", "description": "相对路径，根目录用空字符串"}},
			},
		},
		{
			"name":        "search",
			"description": "按正则搜索本地工作区文件内容，返回 path:line:text；只扫描有界文本文件。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"pattern":     map[string]any{"type": "string"},
					"max_results": map[string]any{"type": "integer"},
				},
				"required": []any{"pattern"},
			},
		},
		{
			"name":        "run_command",
			"description": "在本地工作区执行一条 shell 命令（macOS/Linux 用 sh -c，Windows 用 PowerShell），返回退出码、stdout 和 stderr。cwd 必须是工作区内的相对路径；命令以本机当前用户权限运行，不是 OS 沙箱。超时会终止整个进程组。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command":    map[string]any{"type": "string", "description": "要执行的 shell 命令"},
					"cwd":        map[string]any{"type": "string", "description": "相对工作区根的工作目录（可选，默认工作区根）"},
					"timeout_ms": map[string]any{"type": "integer", "description": "超时毫秒，默认 120000，上限 600000"},
				},
				"required": []any{"command"},
			},
		},
	}
}

// ToolDefinitionsFor filters the contract down to the capabilities the live
// connector actually declared, so a connector started with --no-command never
// advertises run_command to the provider.
func ToolDefinitionsFor(capabilities remoteconnector.Capabilities) []map[string]any {
	normalized := remoteconnector.NormalizeCapabilities(capabilities)
	tools := ToolDefinitions()
	if normalized.RunCommand {
		return tools
	}
	filtered := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		if tool["name"] != "run_command" {
			filtered = append(filtered, tool)
		}
	}
	return filtered
}

// CallTool maps the provider-facing tool names onto connector RPC. The result
// uses the MCP tools/call shape so both the stdio bridge and HTTP callers can
// return it unchanged.
func CallTool(ctx context.Context, hub *Hub, workspaceID, name string, arguments map[string]any) map[string]any {
	if hub == nil {
		return toolError(remoteconnector.CodeWorkspaceOffline, "workspace connector hub is unavailable")
	}
	if arguments == nil {
		arguments = map[string]any{}
	}
	switch strings.TrimSpace(name) {
	case "read_file":
		return callReadFile(ctx, hub, workspaceID, arguments)
	case "write_file":
		return callWriteFile(ctx, hub, workspaceID, arguments)
	case "edit_file":
		return callEditFile(ctx, hub, workspaceID, arguments)
	case "list_directory":
		return callListDirectory(ctx, hub, workspaceID, arguments)
	case "search":
		return callSearch(ctx, hub, workspaceID, arguments)
	case "run_command":
		return callRunCommand(ctx, hub, workspaceID, arguments)
	default:
		return toolError(remoteconnector.CodeUnsupportedOperation, "unknown workspace tool: "+name)
	}
}

func callReadFile(ctx context.Context, hub *Hub, workspaceID string, args map[string]any) map[string]any {
	path := toolString(args["path"])
	if path == "" {
		return toolError(remoteconnector.CodeInvalidPayload, "path is required")
	}
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationReadFile, remoteconnector.ReadFileRequest{
		Path: path, MaxBytes: maxToolReadBytes,
	})
	if err != nil {
		return toolFailure(err)
	}
	var result remoteconnector.ReadFileResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned an invalid read result")
	}
	content, err := base64.StdEncoding.DecodeString(result.Content)
	if err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned invalid file content")
	}
	if !utf8.Valid(content) || strings.ContainsRune(string(content), 0) {
		return toolText(fmt.Sprintf("version: %s\n（二进制文件，%d 字节，未显示内容）", result.Version, len(content)))
	}
	body, total, start, end := numberToolLines(string(content), toolInt(args["offset"]), toolInt(args["limit"]))
	return toolText(fmt.Sprintf("version: %s\nlines: %d-%d / %d\n%s", result.Version, start, end, total, body))
}

func callWriteFile(ctx context.Context, hub *Hub, workspaceID string, args map[string]any) map[string]any {
	path := toolString(args["path"])
	if path == "" {
		return toolError(remoteconnector.CodeInvalidPayload, "path is required")
	}
	content, ok := args["content"].(string)
	if !ok {
		return toolError(remoteconnector.CodeInvalidPayload, "content is required")
	}
	expected := toolString(args["expected_version"])
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationWriteFile, remoteconnector.WriteFileRequest{
		Path: path, Content: base64.StdEncoding.EncodeToString([]byte(content)),
		Encoding: "base64", ExpectedVersion: expected,
	})
	if err != nil {
		return toolFailure(err)
	}
	var result remoteconnector.WriteFileResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned an invalid write result")
	}
	return toolText(fmt.Sprintf("已写入 %s（version: %s）", result.Path, result.Version))
}

func callEditFile(ctx context.Context, hub *Hub, workspaceID string, args map[string]any) map[string]any {
	path := toolString(args["path"])
	oldText, okOld := args["old_string"].(string)
	newText, okNew := args["new_string"].(string)
	if path == "" || !okOld || !okNew || oldText == "" {
		return toolError(remoteconnector.CodeInvalidPayload, "path, old_string and new_string are required")
	}
	replaceAll := toolBool(args["replace_all"])
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationReadFile, remoteconnector.ReadFileRequest{
		Path: path, MaxBytes: maxToolReadBytes,
	})
	if err != nil {
		return toolFailure(err)
	}
	var read remoteconnector.ReadFileResult
	if err := json.Unmarshal(raw, &read); err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned an invalid read result")
	}
	contentBytes, err := base64.StdEncoding.DecodeString(read.Content)
	if err != nil || !utf8.Valid(contentBytes) {
		return toolError(remoteconnector.CodeNotAFile, "edit_file only supports UTF-8 text files")
	}
	content := string(contentBytes)
	count := strings.Count(content, oldText)
	switch {
	case count == 0:
		return toolError(remoteconnector.CodePathNotFound, "old_string was not found")
	case count > 1 && !replaceAll:
		return toolError(remoteconnector.CodeInvalidPayload, "old_string is ambiguous; set replace_all=true")
	}
	updated := content
	if replaceAll {
		updated = strings.ReplaceAll(content, oldText, newText)
	} else {
		updated = strings.Replace(content, oldText, newText, 1)
	}
	writeRaw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationWriteFile, remoteconnector.WriteFileRequest{
		Path: path, Content: base64.StdEncoding.EncodeToString([]byte(updated)),
		Encoding: "base64", ExpectedVersion: read.Version,
	})
	if err != nil {
		return toolFailure(err)
	}
	var result remoteconnector.WriteFileResult
	if err := json.Unmarshal(writeRaw, &result); err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned an invalid write result")
	}
	return toolText(fmt.Sprintf("已修改 %s（version: %s）", result.Path, result.Version))
}

func callListDirectory(ctx context.Context, hub *Hub, workspaceID string, args map[string]any) map[string]any {
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationListDirectory, remoteconnector.ListDirectoryRequest{
		Path: toolString(args["path"]), Limit: toolInt(args["limit"]),
	})
	if err != nil {
		return toolFailure(err)
	}
	var result remoteconnector.ListDirectoryResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned an invalid directory result")
	}
	lines := make([]string, 0, len(result.Entries))
	for _, entry := range result.Entries {
		switch entry.Type {
		case "dir":
			lines = append(lines, "dir  "+entry.Name)
		case "symlink":
			lines = append(lines, "link "+entry.Name)
		default:
			lines = append(lines, fmt.Sprintf("file %s (%d B)", entry.Name, entry.Size))
		}
	}
	if len(lines) == 0 {
		return toolText("(empty directory " + result.Path + ")")
	}
	return toolText(strings.Join(lines, "\n"))
}

func callSearch(ctx context.Context, hub *Hub, workspaceID string, args map[string]any) map[string]any {
	pattern := toolString(args["pattern"])
	if pattern == "" {
		return toolError(remoteconnector.CodeInvalidQuery, "pattern is required")
	}
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationSearch, remoteconnector.SearchRequest{
		Query: pattern, Mode: remoteconnector.SearchModeContent, MaxResults: toolInt(args["max_results"]),
	})
	if err != nil {
		return toolFailure(err)
	}
	var result remoteconnector.SearchResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned an invalid search result")
	}
	if len(result.Matches) == 0 {
		return toolText("no matches")
	}
	lines := make([]string, 0, len(result.Matches))
	for _, match := range result.Matches {
		lines = append(lines, fmt.Sprintf("%s:%d:%s", match.Path, match.Line, match.Text))
	}
	if result.Truncated {
		lines = append(lines, "(truncated)")
	}
	return toolText(strings.Join(lines, "\n"))
}

func callRunCommand(ctx context.Context, hub *Hub, workspaceID string, args map[string]any) map[string]any {
	command, ok := args["command"].(string)
	if !ok || strings.TrimSpace(command) == "" {
		return toolError(remoteconnector.CodeInvalidPayload, "command is required")
	}
	if len(command) > maxToolCommandBytes {
		return toolError(remoteconnector.CodeInvalidPayload, "command is larger than the command limit")
	}
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationRunCommand, remoteconnector.RunCommandRequest{
		Command: command, Cwd: toolString(args["cwd"]), TimeoutMS: toolInt(args["timeout_ms"]),
	})
	if err != nil {
		return toolFailure(err)
	}
	var result remoteconnector.RunCommandResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned an invalid command result")
	}
	stdout, err := base64.StdEncoding.DecodeString(result.Stdout)
	if err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned invalid stdout")
	}
	stderr, err := base64.StdEncoding.DecodeString(result.Stderr)
	if err != nil {
		return toolError(remoteconnector.CodeProtocolError, "connector returned invalid stderr")
	}
	header := "cwd: " + result.Cwd
	if result.Truncated {
		header += "（输出已截断）"
	}
	status := fmt.Sprintf("exit code: %d", result.ExitCode)
	if result.TimedOut {
		status = "exit code: -1（超时，进程组已终止）"
	}
	parts := []string{header, status, fmt.Sprintf("duration: %dms", result.DurationMS)}
	if len(stdout) > 0 {
		parts = append(parts, "stdout:\n"+string(strings.ToValidUTF8(string(stdout), "\uFFFD")))
	}
	if len(stderr) > 0 {
		parts = append(parts, "stderr:\n"+string(strings.ToValidUTF8(string(stderr), "\uFFFD")))
	}
	output := toolText(strings.Join(parts, "\n"))
	if result.ExitCode != 0 || result.TimedOut {
		output["isError"] = true
	}
	return output
}

func numberToolLines(content string, offset, limit int) (string, int, int, int) {
	lines := strings.Split(content, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	total := len(lines)
	if total == 0 {
		return "", 0, 0, 0
	}
	if offset <= 0 {
		offset = 1
	}
	if offset > total {
		offset = total
	}
	if limit <= 0 || limit > maxToolLines {
		limit = maxToolLines
	}
	end := offset + limit - 1
	if end > total {
		end = total
	}
	body := make([]string, 0, end-offset+1)
	for index := offset; index <= end; index++ {
		body = append(body, fmt.Sprintf("%d|%s", index, lines[index-1]))
	}
	return strings.Join(body, "\n"), total, offset, end
}

func toolText(text string) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}
}

func toolError(code, message string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": code + ": " + message}},
		"isError": true,
	}
}

func toolFailure(err error) map[string]any {
	code := remoteconnector.ErrorCode(err)
	message := ""
	var protocolErr *remoteconnector.ProtocolError
	if errors.As(err, &protocolErr) && protocolErr != nil {
		message = protocolErr.Message
	}
	if message == "" {
		message = "workspace tool call failed"
	}
	return toolError(code, message)
}

func toolString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func toolInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	default:
		return 0
	}
}

func toolBool(value any) bool {
	flag, _ := value.(bool)
	return flag
}
