package webuisshapi

// Go 版远程工作区工具执行器：MCP stdio server 和 /v0/webui/internal/remote-tools
// 共用同一个实现。语义对齐 lib/remote-workspace/session-tools.js：
//   - 路径一律相对工作区根，绝对路径 / .. / 盘符拒绝；
//   - 写文件按内容 sha256 前 32 位做版本校验，原子替换；
//   - 命令在工作区根执行，有超时与输出上限。
//
// 当前实现只支持 POSIX 远端；Windows 远端会明确返回 unsupported_remote，
// 不用半套语义冒充完整支持。

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"golang.org/x/crypto/ssh"
)

const (
	remoteReadMaxBytes     = 512 * 1024
	remoteCommandMaxOutput = 256 * 1024
	remoteCmdTimeout       = 120 * time.Second
	remoteMaxCmdTimeout    = 30 * time.Minute
	remoteDialTimeout      = 12 * time.Second
)

// RemoteToolOptions 定位一次远端工具调用。
type RemoteToolOptions struct {
	AIHomeDir   string
	HostHomeDir string
	WorkspaceID string
}

// CallRemoteTool 执行一次工具调用，返回 MCP tools/call 的结果形状。
func CallRemoteTool(ctx context.Context, options RemoteToolOptions, name string, args map[string]any) map[string]any {
	if args == nil {
		args = map[string]any{}
	}
	config, root, err := loadRemoteToolHost(ctx, options)
	if err != nil {
		return remoteToolFailure(err)
	}
	client, err := sshremote.Dial(ctx, config, remoteDialTimeout)
	if err != nil {
		return remoteToolFailure(err)
	}
	defer func() { _ = client.Close() }()
	dialect := detectRemoteDialect(ctx, client)
	if dialect == "" {
		return remoteToolError("unsupported_remote", "无法识别远端系统（需要 POSIX sh 或 Windows PowerShell）")
	}
	host := &remoteToolHost{client: client, root: root, dialect: dialect}
	switch name {
	case "read_file":
		return host.readFile(ctx, args)
	case "write_file":
		return host.writeFile(ctx, args)
	case "edit_file":
		return host.editFile(ctx, args)
	case "list_directory":
		return host.listDirectory(ctx, args)
	case "search":
		return host.search(ctx, args)
	case "run_command":
		return host.runCommand(ctx, args)
	}
	return remoteToolFailure(fmt.Errorf("未知工具：%s", name))
}

// RemoteToolDefinitions 返回 MCP tools/list 的定义（与 Node 版一致）。
func RemoteToolDefinitions() []any {
	return []any{
		map[string]any{
			"name":        "read_file",
			"description": "读取远程工作区内的文本文件。返回带行号的内容和 version（写回时作为 expected_version，防止覆盖别人的修改）。",
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
		map[string]any{
			"name":        "write_file",
			"description": "写入（覆盖或新建）远程工作区内的文件，原子替换。修改已有文件时必须传 read_file 返回的 expected_version；新建文件传空字符串。",
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
		map[string]any{
			"name":        "edit_file",
			"description": "在远程文件中把 old_string 精确替换为 new_string（old_string 必须唯一，除非 replace_all=true）。自动做版本校验。",
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
		map[string]any{
			"name":        "list_directory",
			"description": "列出远程工作区内某个目录的条目（目录在前）。",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string", "description": "相对路径，根目录用空字符串"}},
			},
		},
		map[string]any{
			"name":        "search",
			"description": "在远程工作区内按正则搜索文件内容（远端 rg 优先，否则 grep），返回 path:line:text。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"pattern":     map[string]any{"type": "string"},
					"max_results": map[string]any{"type": "integer"},
				},
				"required": []any{"pattern"},
			},
		},
		map[string]any{
			"name":        "run_command",
			"description": "在远程工作区根目录执行一条 shell 命令（POSIX sh），返回退出码与输出。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command":    map[string]any{"type": "string"},
					"timeout_ms": map[string]any{"type": "integer"},
				},
				"required": []any{"command"},
			},
		},
	}
}

type remoteToolHost struct {
	client  *sshremote.Client
	root    string
	dialect string
}

func loadRemoteToolHost(ctx context.Context, options RemoteToolOptions) (sshremote.Config, string, error) {
	workspaceID := strings.TrimSpace(options.WorkspaceID)
	if !isWorkspaceID(workspaceID) {
		return sshremote.Config{}, "", errors.New("invalid remote workspace invocation")
	}
	source, err := OpenSource(options.AIHomeDir)
	if err != nil {
		return sshremote.Config{}, "", err
	}
	rawWorkspaces, found, err := source.ReadWorkspaces(ctx)
	if err != nil {
		return sshremote.Config{}, "", fmt.Errorf("读取远程工作区失败: %w", err)
	}
	workspace, ok, err := findObjectByID(rawWorkspaces, found, workspaceID)
	if err != nil {
		return sshremote.Config{}, "", fmt.Errorf("ssh_workspaces 不是合法 JSON: %w", err)
	}
	if !ok {
		return sshremote.Config{}, "", errors.New("workspace_not_found")
	}
	rawConnections, connFound, err := source.ReadConnections(ctx)
	if err != nil {
		return sshremote.Config{}, "", fmt.Errorf("读取 SSH 连接失败: %w", err)
	}
	connectionsByID, err := parseConnectionsMap(rawConnections, connFound)
	if err != nil {
		return sshremote.Config{}, "", fmt.Errorf("ssh_connections 不是合法 JSON: %w", err)
	}
	connection, ok := connectionsByID[trimmedString(workspace["connectionId"])]
	if !ok {
		return sshremote.Config{}, "", errors.New("connection_not_found")
	}
	config, ok := buildSSHConfigChain(connection, connectionsByID, options.HostHomeDir)
	if !ok {
		return sshremote.Config{}, "", errors.New("egress_connection_invalid")
	}
	if reason, message := validateKeyFiles(config, options.HostHomeDir); reason != "" {
		return sshremote.Config{}, "", fmt.Errorf("%s: %s", reason, message)
	}
	if err := validateSSHConfigChain(config); err != nil {
		return sshremote.Config{}, "", err
	}
	config.HostKeyCallback = appStateHostKeyCallback(options.AIHomeDir)
	return config, trimmedString(workspace["remoteRoot"]), nil
}

// appStateHostKeyCallback 用 app-state 的 ssh_known_hosts 做 TOFU 校验。
// Node 维护的指纹与 ~/.ssh/known_hosts 可能是两套（远端换过 key 时更常见），
// 工具执行必须与 WebUI 的 SSH 面板看同一份记录。
func appStateHostKeyCallback(aiHomeDir string) ssh.HostKeyCallback {
	records := map[string]string{}
	if databasePath, err := appstate.DatabasePath(aiHomeDir); err == nil {
		if raw, found, readErr := appstate.ReadKV(context.Background(), databasePath, "ssh_known_hosts"); readErr == nil && found {
			var stored map[string]struct {
				Fingerprint string `json:"fingerprint"`
			}
			if json.Unmarshal([]byte(raw), &stored) == nil {
				for id, record := range stored {
					if strings.TrimSpace(record.Fingerprint) != "" {
						records[strings.ToLower(id)] = record.Fingerprint
					}
				}
			}
		}
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		port := 22
		if remote != nil {
			if _, portText, err := net.SplitHostPort(remote.String()); err == nil {
				if parsed, convErr := strconv.Atoi(portText); convErr == nil {
					port = parsed
				}
			}
		}
		identifier := sshhost.HostID(hostname, port)
		actual := sshhost.FingerprintSHA256(key.Marshal())
		expected, found := records[identifier]
		if !found {
			return nil
		}
		if expected != actual {
			return fmt.Errorf("SSH 主机密钥与 ssh_known_hosts 记录不一致: %s", identifier)
		}
		return nil
	}
}

func remoteToolText(value string) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": value}}}
}

func remoteToolFailure(err error) map[string]any {
	code := "remote_tool_failed"
	message := "远程工具调用失败"
	if err != nil {
		message = err.Error()
	}
	return map[string]any{
		"isError": true,
		"content": []any{map[string]any{"type": "text", "text": "[" + code + "] " + message}},
	}
}

func remoteToolError(code, message string) map[string]any {
	return map[string]any{
		"isError": true,
		"content": []any{map[string]any{"type": "text", "text": "[" + code + "] " + message}},
	}
}

func (host *remoteToolHost) resolve(value string) (string, error) {
	if host.dialect == "windows" {
		value = strings.ReplaceAll(value, "\\", "/")
	}
	rel, ok := cleanRemoteRelPath(value)
	if !ok {
		return "", errors.New("路径必须位于工作区根目录内")
	}
	return rel, nil
}

func cleanRemoteRelPath(value string) (string, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", true
	}
	if strings.HasPrefix(text, "/") || strings.HasPrefix(text, "\\") || strings.Contains(text, "\\") {
		return "", false
	}
	if len(text) >= 2 && text[1] == ':' {
		return "", false
	}
	cleaned := path.Clean(text)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || cleaned == "." {
		if cleaned == "." {
			return "", true
		}
		return "", false
	}
	return cleaned, true
}

func (host *remoteToolHost) abs(rel string) string {
	if rel == "" {
		return host.root
	}
	return strings.TrimRight(host.root, "/\\") + "/" + rel
}

func (host *remoteToolHost) readFile(ctx context.Context, args map[string]any) map[string]any {
	rel, err := host.resolve(asString(args["path"]))
	if err != nil {
		return remoteToolFailure(err)
	}
	content, version, err := host.readContent(ctx, rel)
	if err != nil {
		if errors.Is(err, errRemoteNotFound) {
			return remoteToolError("not_found", "远端文件不存在："+rel)
		}
		return remoteToolFailure(err)
	}
	if looksBinary(content) {
		return remoteToolText(fmt.Sprintf("version: %s\n（二进制文件，%d 字节，未显示内容）", version, len(content)))
	}
	body, total, start, end := numberLines(string(content), asInt(args["offset"], 0), asInt(args["limit"], 0))
	return remoteToolText(fmt.Sprintf("version: %s\nlines: %d-%d / %d\n%s", version, start, end, total, body))
}

var errRemoteNotFound = errors.New("remote file not found")

// writeContent 原子写入远端文件；Windows 走 PowerShell + base64 stdin。
func (host *remoteToolHost) writeContent(ctx context.Context, rel string, content []byte) error {
	if host.dialect == "windows" {
		return host.windowsWriteContent(ctx, rel, content)
	}
	temp := rel + ".aih-tmp-" + randomSuffix()
	dir := path.Dir(rel)
	mkdir := ""
	if dir != "." && dir != "" {
		mkdir = "mkdir -p " + sshhost.ShellQuote(dir) + " && "
	}
	command := "cd " + sshhost.ShellQuote(host.root) + " && " + mkdir +
		"cat > " + sshhost.ShellQuote(temp) + " && mv -f " + sshhost.ShellQuote(temp) + " " + sshhost.ShellQuote(rel)
	result, err := host.client.RunWithInput(ctx, command, content, 4096)
	if err != nil {
		return err
	}
	if result.Code != 0 {
		_, _ = host.client.Run(ctx, "cd "+sshhost.ShellQuote(host.root)+" && rm -f "+sshhost.ShellQuote(temp), 1024)
		return errors.New(strings.TrimSpace(string(result.Stderr)))
	}
	return nil
}

func (host *remoteToolHost) readContent(ctx context.Context, rel string) ([]byte, string, error) {
	if host.dialect == "windows" {
		return host.windowsReadContent(ctx, rel)
	}
	return host.readContentPosix(ctx, rel)
}

func (host *remoteToolHost) readContentPosix(ctx context.Context, rel string) ([]byte, string, error) {
	command := "cd " + sshhost.ShellQuote(host.root) + " && test -f " + sshhost.ShellQuote(rel) +
		" && head -c " + strconv.Itoa(remoteReadMaxBytes+1) + " -- " + sshhost.ShellQuote(rel)
	result, err := host.client.Run(ctx, command, remoteReadMaxBytes+8192)
	if err != nil {
		return nil, "", err
	}
	if result.Code == 1 && len(result.Stdout) == 0 {
		return nil, "", errRemoteNotFound
	}
	if result.Code != 0 {
		return nil, "", fmt.Errorf("读取远端文件失败: %s", strings.TrimSpace(string(result.Stderr)))
	}
	content := result.Stdout
	if len(content) > remoteReadMaxBytes {
		content = content[:remoteReadMaxBytes]
	}
	return content, versionOfContent(content), nil
}

func (host *remoteToolHost) writeFile(ctx context.Context, args map[string]any) map[string]any {
	rel, err := host.resolve(asString(args["path"]))
	if err != nil {
		return remoteToolFailure(err)
	}
	if rel == "" {
		return remoteToolError("invalid_path", "不能写入工作区根目录")
	}
	content := []byte(asString(args["content"]))
	expected, hasExpected := args["expected_version"]
	var expectedVersion *string
	if hasExpected {
		value := asString(expected)
		if value == "" {
			expectedVersion = nil
		} else {
			expectedVersion = &value
		}
	}
	current, _, currentErr := host.readContent(ctx, rel)
	exists := currentErr == nil
	if currentErr != nil && !errors.Is(currentErr, errRemoteNotFound) {
		return remoteToolFailure(currentErr)
	}
	target := versionOfContent(content)
	if exists && expectedVersion != nil && versionOfContent(current) == target {
		return remoteToolText(fmt.Sprintf("已写入 %s（version: %s，内容未变化）", rel, target))
	}
	if hasExpected {
		if !exists && expectedVersion != nil {
			return remoteToolError("version_conflict", "远端文件已被删除："+rel)
		}
		if exists && expectedVersion == nil {
			return remoteToolError("version_conflict", "远端文件已存在："+rel)
		}
		if exists && expectedVersion != nil && versionOfContent(current) != *expectedVersion {
			return remoteToolError("version_conflict", "远端文件已被修改："+rel)
		}
	}
	if err := host.writeContent(ctx, rel, content); err != nil {
		if errors.Is(err, errRemoteNotFound) {
			return remoteToolError("not_found", "远端路径不存在："+rel)
		}
		return remoteToolError("write_failed", strings.TrimSpace(err.Error()))
	}
	return remoteToolText(fmt.Sprintf("已写入 %s（version: %s）", rel, target))
}

func (host *remoteToolHost) editFile(ctx context.Context, args map[string]any) map[string]any {
	rel, err := host.resolve(asString(args["path"]))
	if err != nil {
		return remoteToolFailure(err)
	}
	content, _, err := host.readContent(ctx, rel)
	if err != nil {
		if errors.Is(err, errRemoteNotFound) {
			return remoteToolError("not_found", "远端文件不存在："+rel)
		}
		return remoteToolFailure(err)
	}
	original := string(content)
	oldString := asString(args["old_string"])
	if oldString == "" {
		return remoteToolError("invalid_edit", "old_string 不能为空")
	}
	count := strings.Count(original, oldString)
	if count == 0 {
		return remoteToolError("edit_not_found", "old_string 在文件中不存在")
	}
	replaceAll := asBool(args["replace_all"])
	if count > 1 && !replaceAll {
		return remoteToolError("edit_ambiguous", fmt.Sprintf("old_string 出现了 %d 次，请提供更长的上下文或使用 replace_all", count))
	}
	next := strings.Replace(original, oldString, asString(args["new_string"]), 1)
	if replaceAll {
		next = strings.ReplaceAll(original, oldString, asString(args["new_string"]))
	}
	if err := host.writeContent(ctx, rel, []byte(next)); err != nil {
		return remoteToolError("write_failed", strings.TrimSpace(err.Error()))
	}
	replaced := 1
	if replaceAll {
		replaced = count
	}
	return remoteToolText(fmt.Sprintf("已修改 %s（替换 %d 处，version: %s）", rel, replaced, versionOfContent([]byte(next))))
}

func (host *remoteToolHost) listDirectory(ctx context.Context, args map[string]any) map[string]any {
	rel, err := host.resolve(asString(args["path"]))
	if err != nil {
		return remoteToolFailure(err)
	}
	var raw []byte
	if host.dialect == "windows" {
		listed, listErr := host.windowsListRaw(ctx, rel)
		if listErr != nil {
			if errors.Is(listErr, errRemoteNotFound) {
				return remoteToolError("not_found", "远端目录不存在："+rel)
			}
			return remoteToolError("list_failed", strings.TrimSpace(listErr.Error()))
		}
		raw = listed
	} else {
		abs := host.abs(rel)
		command := "cd " + sshhost.ShellQuote(abs) + " && for f in * .[!.]*; do " +
			"if [ -e \"$f\" ] || [ -L \"$f\" ]; then " +
			"if [ -d \"$f\" ]; then t=d; elif [ -L \"$f\" ]; then t=l; else t=-; fi; " +
			"s=$(wc -c < \"$f\" 2>/dev/null || echo 0); " +
			"printf '%s\\t%s\\t%s\\n' \"$t\" \"$s\" \"$f\"; fi; done"
		result, runErr := host.client.Run(ctx, command, 4*1024*1024)
		if runErr != nil {
			return remoteToolFailure(runErr)
		}
		if result.Code != 0 {
			return remoteToolError("list_failed", strings.TrimSpace(string(result.Stderr)))
		}
		raw = result.Stdout
	}
	type entry struct {
		kind string
		size int64
		name string
	}
	entries := make([]entry, 0)
	for _, line := range strings.Split(strings.TrimRight(string(raw), "\n"), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		size, _ := strconv.ParseInt(parts[1], 10, 64)
		entries = append(entries, entry{kind: parts[0], size: size, name: parts[2]})
	}
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].kind == "d") != (entries[j].kind == "d") {
			return entries[i].kind == "d"
		}
		return entries[i].name < entries[j].name
	})
	lines := make([]string, 0, len(entries))
	for _, item := range entries {
		label := "-"
		if item.kind == "d" || item.kind == "l" {
			label = item.kind
		}
		suffix := ""
		if item.kind == "d" {
			suffix = "/"
		}
		lines = append(lines, fmt.Sprintf("%s %10d  %s%s", label, item.size, item.name, suffix))
	}
	display := rel
	if display == "" {
		display = "."
	}
	return remoteToolText(fmt.Sprintf("%s（%d 项）\n%s", display, len(entries), strings.Join(lines, "\n")))
}

func (host *remoteToolHost) search(ctx context.Context, args map[string]any) map[string]any {
	pattern := asString(args["pattern"])
	if pattern == "" {
		return remoteToolError("invalid_pattern", "pattern 不能为空")
	}
	maxResults := asInt(args["max_results"], 200)
	if maxResults < 1 {
		maxResults = 1
	}
	if maxResults > 1000 {
		maxResults = 1000
	}
	var stdout []byte
	if host.dialect == "windows" {
		found, searchErr := host.windowsSearchRaw(ctx, pattern, maxResults)
		if searchErr != nil {
			return remoteToolError("search_failed", strings.TrimSpace(searchErr.Error()))
		}
		stdout = found
	} else {
		quoted := sshhost.ShellQuote(pattern)
		command := "cd " + sshhost.ShellQuote(host.root) +
			" && if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never -e " + quoted +
			" . | head -n " + strconv.Itoa(maxResults) +
			"; else grep -rn -e " + quoted + " . | head -n " + strconv.Itoa(maxResults) + "; fi"
		result, runErr := host.client.Run(ctx, command, 4*1024*1024)
		if runErr != nil {
			return remoteToolFailure(runErr)
		}
		if result.Code != 0 && len(result.Stdout) == 0 {
			return remoteToolError("search_failed", strings.TrimSpace(string(result.Stderr)))
		}
		stdout = result.Stdout
	}
	matches := make([]string, 0)
	for _, line := range strings.Split(strings.TrimRight(string(stdout), "\n"), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		first := strings.Index(line, ":")
		if first <= 0 {
			continue
		}
		second := strings.Index(line[first+1:], ":")
		if second < 0 {
			continue
		}
		file := line[:first]
		file = strings.TrimPrefix(file, "./")
		lineNo := line[first+1 : first+1+second]
		text := line[first+1+second+1:]
		matches = append(matches, file+":"+lineNo+":"+text)
	}
	truncated := len(matches) >= maxResults
	suffix := ""
	if truncated {
		suffix = "（已截断）"
	}
	return remoteToolText(fmt.Sprintf("%d 处匹配%s\n%s", len(matches), suffix, strings.Join(matches, "\n")))
}

func (host *remoteToolHost) runCommand(ctx context.Context, args map[string]any) map[string]any {
	command := asString(args["command"])
	timeoutMS := asInt(args["timeout_ms"], 0)
	timeout := remoteCmdTimeout
	if timeoutMS > 0 {
		timeout = time.Duration(timeoutMS) * time.Millisecond
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	if timeout > remoteMaxCmdTimeout {
		timeout = remoteMaxCmdTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var result sshremote.Result
	var err error
	if host.dialect == "windows" {
		result, err = host.windowsRun(runCtx, command, timeoutMS)
	} else {
		remote := "cd " + sshhost.ShellQuote(host.root) + " && sh -lc " + sshhost.ShellQuote(command)
		result, err = host.client.Run(runCtx, remote, remoteCommandMaxOutput)
	}
	if err != nil {
		return remoteToolFailure(err)
	}
	parts := []string{fmt.Sprintf("exit code: %d", result.Code)}
	if result.Truncated {
		parts[0] += "（输出已截断）"
	}
	if len(result.Stdout) > 0 {
		parts = append(parts, "stdout:\n"+string(result.Stdout))
	}
	if len(result.Stderr) > 0 {
		parts = append(parts, "stderr:\n"+string(result.Stderr))
	}
	output := map[string]any{"content": []any{map[string]any{"type": "text", "text": strings.Join(parts, "\n")}}}
	if result.Code != 0 {
		output["isError"] = true
	}
	return output
}

func versionOfContent(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])[:32]
}

func looksBinary(content []byte) bool {
	limit := len(content)
	if limit > 8000 {
		limit = 8000
	}
	for _, item := range content[:limit] {
		if item == 0 {
			return true
		}
	}
	return false
}

func numberLines(content string, offset, limit int) (string, int, int, int) {
	lines := strings.Split(content, "\n")
	start := offset
	if start < 1 {
		start = 1
	}
	end := len(lines)
	if limit > 0 && start+limit-1 < end {
		end = start + limit - 1
	}
	if start > len(lines) {
		start = len(lines)
	}
	out := make([]string, 0, end-start+1)
	for index := start; index <= end; index++ {
		out = append(out, fmt.Sprintf("%6d\t%s", index, lines[index-1]))
	}
	return strings.Join(out, "\n"), len(lines), start, end
}

func randomSuffix() string {
	buffer := make([]byte, 6)
	if _, err := rand.Read(buffer); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buffer)
}

func asString(value any) string {
	if value == nil {
		return ""
	}
	text, _ := value.(string)
	return text
}

func asInt(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			return int(parsed)
		}
	}
	return fallback
}

func asBool(value any) bool {
	flag, _ := value.(bool)
	return flag
}
