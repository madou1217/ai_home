package webuisshapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/terminals"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

const (
	// WorkspaceTerminalPath 是打开/复用远程工作区终端的管理契约路径。
	WorkspaceTerminalPath = WorkspacesPath + "/{id}/terminal"

	maxTerminalBodyBytes = 256 * 1024
	maxJumpDepth         = 5
)

// TerminalLaunchRequest 是 Go 终端服务打开/复用会话的请求。
type TerminalLaunchRequest struct {
	SessionKey string
	Cwd        string
	File       string
	Args       []string
	Env        []string
	Cols       int
	Rows       int
	Persistent bool
	Remote     *terminalsession.RemoteSpec
}

// TerminalLaunchResult 是终端启动成功的返回值。
type TerminalLaunchResult struct {
	TermID     string
	SessionKey string
	Durable    bool
	Reused     bool
}

// TerminalLaunchError 是终端启动失败的结构化错误。
type TerminalLaunchError struct {
	Status  int
	Code    string
	Message string
}

// TerminalLauncher 抽象 Go 进程内的 PTY 管理器（由 webuiterminalapi.Handler 适配）。
type TerminalLauncher interface {
	LaunchTerminal(ctx context.Context, req TerminalLaunchRequest) (TerminalLaunchResult, *TerminalLaunchError)
}

// ClientTerminalOpener 拉起宿主本地客户端终端窗口（默认调用 terminals.OpenClientTerminal）。
type ClientTerminalOpener func(req terminals.OpenRequest) terminals.OpenResult

// TerminalDependencies 汇总工作区终端入口依赖。
type TerminalDependencies struct {
	Authorizer   Authorizer
	Connections  Store
	Workspaces   WorkspaceStore
	AIHomeDir    string
	HostHomeDir  string
	Launcher     TerminalLauncher
	ClientOpener ClientTerminalOpener
	RepoRoot     string
	NodeExecPath string
	DesktopHost  *bool
}

// WorkspaceTerminalHandler 处理 POST /v1/management/webui/ssh-workspaces/{id}/terminal。
type WorkspaceTerminalHandler struct {
	authorizer   Authorizer
	connections  Store
	workspaces   WorkspaceStore
	aiHomeDir    string
	hostHomeDir  string
	launcher     TerminalLauncher
	clientOpener ClientTerminalOpener
	repoRoot     string
	nodeExecPath string
	desktopHost  *bool
}

// NewWorkspaceTerminalHandler 创建默认失败关闭的工作区终端 Handler。
func NewWorkspaceTerminalHandler(dependencies TerminalDependencies) (*WorkspaceTerminalHandler, error) {
	if dependencies.Authorizer == nil || dependencies.Connections == nil || dependencies.Workspaces == nil {
		return nil, ErrInvalidDependencies
	}
	clientOpener := dependencies.ClientOpener
	if clientOpener == nil {
		clientOpener = func(req terminals.OpenRequest) terminals.OpenResult {
			return terminals.OpenClientTerminal(req, terminals.Options{})
		}
	}
	return &WorkspaceTerminalHandler{
		authorizer:   dependencies.Authorizer,
		connections:  dependencies.Connections,
		workspaces:   dependencies.Workspaces,
		aiHomeDir:    strings.TrimSpace(dependencies.AIHomeDir),
		hostHomeDir:  strings.TrimSpace(dependencies.HostHomeDir),
		launcher:     dependencies.Launcher,
		clientOpener: clientOpener,
		repoRoot:     strings.TrimSpace(dependencies.RepoRoot),
		nodeExecPath: strings.TrimSpace(dependencies.NodeExecPath),
		desktopHost:  dependencies.DesktopHost,
	}, nil
}

type clientPeer struct {
	RemoteAddr     string `json:"remoteAddr"`
	ForwardedFor   string `json:"forwardedFor"`
	RealIP         string `json:"realIp"`
	CfConnectingIP string `json:"cfConnectingIp"`
	Forwarded      string `json:"forwarded"`
	AihServerID    string `json:"aihServerId"`
}

type terminalBody struct {
	Cols       any         `json:"cols"`
	Rows       any         `json:"rows"`
	Fresh      bool        `json:"fresh"`
	Agent      string      `json:"agent"`
	Transport  string      `json:"transport"`
	TerminalID string      `json:"terminalId"`
	ClientPeer *clientPeer `json:"clientPeer"`
}

// ServeHTTP 只接受 POST。
func (handler *WorkspaceTerminalHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.connections == nil || handler.workspaces == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_workspace_terminal_unavailable", "SSH 工作区终端服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}

	workspaceID := extractWorkspaceIDFromTerminalPath(request)
	if workspaceID == "" {
		writeError(response, http.StatusNotFound, "workspace_not_found", "远程工作区不存在。")
		return
	}

	body, code, msg := decodeTerminalBody(response, request)
	if code != "" {
		writeError(response, http.StatusBadRequest, code, msg)
		return
	}

	rawWorkspaces, wsFound, err := handler.workspaces.ReadWorkspaces(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_workspaces_read_failed", "")
		return
	}
	wsObj, ok, err := findObjectByID(rawWorkspaces, wsFound, workspaceID)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_workspaces_invalid", "ssh_workspaces 不是合法 JSON")
		return
	}
	if !ok {
		writeError(response, http.StatusNotFound, "workspace_not_found", "远程工作区不存在。")
		return
	}

	connID := trimmedString(wsObj["connectionId"])
	rawConnections, connFound, err := handler.connections.ReadConnections(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_read_failed", "")
		return
	}
	connsByID, err := parseConnectionsMap(rawConnections, connFound)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_invalid", "ssh_connections 不是合法 JSON")
		return
	}
	connObj, ok := connsByID[connID]
	if !ok {
		writeError(response, http.StatusConflict, "connection_not_found", "工作区关联的 SSH 连接已被删除。")
		return
	}

	wsLabel := trimmedString(wsObj["label"])
	if wsLabel == "" {
		wsLabel = trimmedString(wsObj["name"])
	}
	remoteRoot := trimmedString(wsObj["remoteRoot"])
	hostDisplay := formatHostDisplay(connObj)

	agent := trimmedString(body.Agent)
	if agent == "claude" || agent == "codex" {
		handler.openAgentTerminal(response, request, workspaceID, wsLabel, remoteRoot, hostDisplay, agent, body)
		return
	}
	if strings.EqualFold(trimmedString(body.Transport), "native") {
		handler.openNativeTerminal(response, request, workspaceID, wsLabel, remoteRoot, connObj, body)
		return
	}
	handler.openRemoteSSHTerminal(response, request, workspaceID, wsLabel, remoteRoot, hostDisplay, connObj, connsByID, body)
}

func (handler *WorkspaceTerminalHandler) openAgentTerminal(
	response http.ResponseWriter,
	request *http.Request,
	workspaceID string,
	wsLabel string,
	remoteRoot string,
	hostDisplay string,
	agent string,
	body terminalBody,
) {
	shadowDir, err := webuiremoteworkspace.EnsureShadowDir(handler.aiHomeDir, workspaceID)
	if err != nil {
		var remoteErr *webuiremoteworkspace.RemoteError
		if errors.As(err, &remoteErr) && remoteErr != nil {
			writeError(response, remoteErr.Status, remoteErr.Code, remoteErr.Message)
			return
		}
		writeError(response, http.StatusInternalServerError, "shadow_directory_failed", err.Error())
		return
	}
	nodePath, cliEntry, errCode, errMsg := handler.resolveNodeAndCLI()
	if errCode != "" {
		writeError(response, http.StatusServiceUnavailable, errCode, errMsg)
		return
	}
	if handler.launcher == nil {
		writeError(response, http.StatusServiceUnavailable, "terminal_launcher_unavailable", "终端管理器未接线，无法打开工作区终端。")
		return
	}
	suffix := ""
	if body.Fresh {
		suffix = ":" + randomHex(4)
	}
	agentKey := "remote-ai:" + workspaceID + ":" + agent + suffix
	res, launchErr := handler.launcher.LaunchTerminal(request.Context(), TerminalLaunchRequest{
		SessionKey: agentKey,
		File:       nodePath,
		Args:       []string{cliEntry, agent, "--remote=" + workspaceID},
		Env:        []string{"AIH_HOME_DIR=" + handler.aiHomeDir},
		Cwd:        shadowDir,
		Cols:       intValue(body.Cols),
		Rows:       intValue(body.Rows),
		Persistent: true,
	})
	if launchErr != nil {
		errOut := strings.TrimSpace(launchErr.Code)
		if errOut == "" {
			errOut = "remote_terminal_open_failed"
		}
		writeError(response, http.StatusServiceUnavailable, errOut, launchErr.Message)
		return
	}
	sessionKey := res.SessionKey
	if sessionKey == "" {
		sessionKey = agentKey
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":         true,
		"sessionKey": sessionKey,
		"termId":     res.TermID,
		"reused":     res.Reused,
		"durable":    res.Durable,
		"label":      wsLabel + " · " + agent,
		"remoteRoot": remoteRoot,
		"host":       hostDisplay,
		"agent":      agent,
	})
}

func (handler *WorkspaceTerminalHandler) openNativeTerminal(
	response http.ResponseWriter,
	request *http.Request,
	workspaceID string,
	wsLabel string,
	remoteRoot string,
	connObj map[string]any,
	body terminalBody,
) {
	if !handler.isDesktopHost() || !isSameMachineRequest(request, body.ClientPeer) {
		writeError(response, http.StatusConflict, "web_terminal_required", "浏览器不在 AIH Server 本机，改用 Web Terminal 打开。")
		return
	}
	nodePath, cliEntry, errCode, errMsg := handler.resolveNodeAndCLI()
	if errCode != "" {
		writeError(response, http.StatusServiceUnavailable, errCode, errMsg)
		return
	}
	nativeKey := sshhost.RemoteSessionKey(workspaceID, "native-"+randomHex(4))
	command := buildNativeRemoteCommand(handler.aiHomeDir, nodePath, cliEntry, workspaceID, nativeKey)
	connHost := trimmedString(connObj["host"])
	res := handler.clientOpener(terminals.OpenRequest{
		TerminalID: trimmedString(body.TerminalID),
		Title:      wsLabel + " · " + connHost,
		Command:    command,
		Transport:  "native",
	})
	status := http.StatusOK
	if !res.OK {
		if res.Error == "web_terminal_required" {
			status = http.StatusConflict
		} else {
			status = http.StatusServiceUnavailable
		}
	}
	payload := map[string]any{
		"ok":         res.OK,
		"transport":  "native",
		"label":      wsLabel,
		"remoteRoot": remoteRoot,
	}
	if res.Error != "" {
		payload["error"] = res.Error
	}
	if res.Message != "" {
		payload["message"] = res.Message
	}
	if res.Status != "" {
		payload["status"] = res.Status
	}
	if res.TerminalID != "" {
		payload["terminalId"] = res.TerminalID
	}
	if res.Executable != "" {
		payload["executable"] = res.Executable
	}
	if res.PID != nil {
		payload["pid"] = *res.PID
	}
	writeJSON(response, status, payload)
}

func (handler *WorkspaceTerminalHandler) openRemoteSSHTerminal(
	response http.ResponseWriter,
	request *http.Request,
	workspaceID string,
	wsLabel string,
	remoteRoot string,
	hostDisplay string,
	connObj map[string]any,
	connsByID map[string]map[string]any,
	body terminalBody,
) {
	suffix := ""
	if body.Fresh {
		suffix = randomHex(4)
	}
	sessionKey := sshhost.RemoteSessionKey(workspaceID, suffix)

	sshCfg, ok := buildSSHConfigChain(connObj, connsByID, handler.hostHomeDir)
	if !ok {
		writeError(response, http.StatusConflict, "egress_connection_invalid", "该连接依赖的出口/跳板连接不存在或形成环。")
		return
	}
	if reason, msg := validateKeyFiles(sshCfg, handler.hostHomeDir); reason != "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_identity_file",
			"reason":  reason,
			"message": msg,
		})
		return
	}
	if err := validateSSHConfigChain(sshCfg); err != nil {
		writeError(response, http.StatusBadRequest, "ssh_connection_invalid", err.Error())
		return
	}
	if handler.launcher == nil {
		writeError(response, http.StatusServiceUnavailable, "terminal_launcher_unavailable", "终端管理器未接线，无法打开工作区终端。")
		return
	}

	remoteCommand := sshhost.BuildRemoteCommand(remoteRoot, sessionKey)
	res, launchErr := handler.launcher.LaunchTerminal(request.Context(), TerminalLaunchRequest{
		SessionKey: sessionKey,
		Cols:       intValue(body.Cols),
		Rows:       intValue(body.Rows),
		Persistent: true,
		Remote: &terminalsession.RemoteSpec{
			Config:  sshCfg,
			Command: remoteCommand,
		},
	})
	if launchErr != nil {
		errOut := strings.TrimSpace(launchErr.Code)
		if errOut == "" {
			errOut = "remote_terminal_open_failed"
		}
		writeError(response, http.StatusServiceUnavailable, errOut, launchErr.Message)
		return
	}
	outKey := res.SessionKey
	if outKey == "" {
		outKey = sessionKey
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":         true,
		"sessionKey": outKey,
		"termId":     res.TermID,
		"reused":     res.Reused,
		"durable":    res.Durable,
		"label":      wsLabel,
		"remoteRoot": remoteRoot,
		"host":       hostDisplay,
	})
}

func extractWorkspaceIDFromTerminalPath(request *http.Request) string {
	if id := strings.TrimSpace(request.PathValue("id")); id != "" {
		return id
	}
	path := strings.TrimSuffix(request.URL.Path, "/")
	const prefix = WorkspacesPath + "/"
	const suffix = "/terminal"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return ""
	}
	id := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	if id == "" || strings.Contains(id, "/") {
		return ""
	}
	return id
}

func decodeTerminalBody(response http.ResponseWriter, request *http.Request) (terminalBody, string, string) {
	if request.Body == nil {
		return terminalBody{}, "", ""
	}
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxTerminalBodyBytes))
	var raw map[string]any
	if err := decoder.Decode(&raw); err != nil {
		if errors.Is(err, io.EOF) {
			return terminalBody{}, "", ""
		}
		return terminalBody{}, "invalid_json_body", "请求体不是合法 JSON"
	}
	if raw == nil {
		return terminalBody{}, "invalid_request_body", "请求体必须是 JSON 对象"
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return terminalBody{}, "invalid_json_body", "请求体不是合法 JSON"
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return terminalBody{}, "invalid_json_body", "请求体不是合法 JSON"
	}
	var body terminalBody
	if err := json.Unmarshal(encoded, &body); err != nil {
		return terminalBody{}, "invalid_request_body", "请求体格式无效"
	}
	return body, "", ""
}

func findObjectByID(raw string, found bool, targetID string) (map[string]any, bool, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return nil, false, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, false, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return nil, false, nil
	}
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if trimmedString(object["id"]) == targetID {
			return object, true, nil
		}
	}
	return nil, false, nil
}

func parseConnectionsMap(raw string, found bool) (map[string]map[string]any, error) {
	byID := make(map[string]map[string]any)
	if !found || strings.TrimSpace(raw) == "" {
		return byID, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return byID, nil
	}
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if id := trimmedString(object["id"]); id != "" {
			byID[id] = object
		}
	}
	return byID, nil
}

func buildSSHConfigChain(root map[string]any, byID map[string]map[string]any, hostHomeDir string) (sshremote.Config, bool) {
	seen := map[string]bool{}
	if id := trimmedString(root["id"]); id != "" {
		seen[id] = true
	}
	return resolveSSHConfigChain(root, byID, seen, 0, hostHomeDir)
}

func resolveSSHConfigChain(
	object map[string]any,
	byID map[string]map[string]any,
	seen map[string]bool,
	depth int,
	hostHomeDir string,
) (sshremote.Config, bool) {
	port := intValue(object["port"])
	if port <= 0 || port > 65535 {
		port = sshremote.DefaultPort
	}
	cfg := sshremote.Config{
		Host:         trimmedString(object["host"]),
		Port:         port,
		User:         trimmedString(object["user"]),
		AuthType:     trimmedString(object["authType"]),
		Password:     rawString(object["password"]),
		PrivateKey:   rawString(object["privateKey"]),
		IdentityFile: trimmedString(object["identityFile"]),
		HomeDir:      hostHomeDir,
	}
	egressID := trimmedString(object["egressConnectionId"])
	if egressID == "" {
		return cfg, true
	}
	if seen[egressID] || depth >= maxJumpDepth {
		return sshremote.Config{}, false
	}
	egressObj, ok := byID[egressID]
	if !ok {
		return sshremote.Config{}, false
	}
	nextSeen := make(map[string]bool, len(seen)+1)
	for key, val := range seen {
		nextSeen[key] = val
	}
	nextSeen[egressID] = true
	jumpCfg, ok := resolveSSHConfigChain(egressObj, byID, nextSeen, depth+1, hostHomeDir)
	if !ok {
		return sshremote.Config{}, false
	}
	cfg.Jump = &jumpCfg
	return cfg, true
}

var identityFileMessages = map[string]string{
	sshhost.IdentityFileRequired:           "SSH identity file path is required.",
	sshhost.IdentityFileMustBeAbsolute:     "SSH identity file path must be absolute or start with ~/.",
	sshhost.IdentityFileOutsideSSHDir:      "SSH identity file must be inside the current server user SSH directory.",
	sshhost.IdentityFileNotFound:           "SSH identity file was not found.",
	sshhost.IdentityFileNotRegularFile:     "SSH identity file must be a regular file.",
	sshhost.IdentityFilePermissionsTooOpen: "SSH identity file permissions must not allow group or other access.",
}

func validateKeyFiles(cfg sshremote.Config, hostHomeDir string) (string, string) {
	for cur := &cfg; cur != nil; cur = cur.Jump {
		if strings.TrimSpace(cur.AuthType) != sshhost.KeyFileAuthType {
			continue
		}
		if strings.TrimSpace(cur.IdentityFile) == "" {
			code := sshhost.IdentityFileRequired
			return code, identityFileMessages[code]
		}
		if strings.TrimSpace(hostHomeDir) == "" {
			continue
		}
		if _, err := sshhost.ResolveIdentityFilePath(cur.IdentityFile, sshhost.IdentityOptions{HomeDir: hostHomeDir}); err != nil {
			var idErr *sshhost.IdentityFileError
			if errors.As(err, &idErr) && idErr != nil {
				msg := identityFileMessages[idErr.Code]
				if msg == "" {
					msg = "SSH identity file is invalid."
				}
				return idErr.Code, msg
			}
			return "identity_file_invalid", "SSH identity file is invalid."
		}
	}
	return "", ""
}

func validateSSHConfigChain(cfg sshremote.Config) error {
	for cur := &cfg; cur != nil; cur = cur.Jump {
		if err := cur.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func (handler *WorkspaceTerminalHandler) resolveNodeAndCLI() (string, string, string, string) {
	nodePath := handler.nodeExecPath
	if nodePath == "" {
		found, err := exec.LookPath("node")
		if err != nil {
			return "", "", "node_unavailable", "当前宿主机未找到 Node.js，无法启动工作区代理终端。"
		}
		nodePath = found
	}
	root := handler.repoRoot
	if root == "" {
		root = discoverRepoRoot()
	}
	if root == "" {
		return "", "", "cli_entry_unavailable", "未找到 bin/ai-home.js，无法启动工作区代理终端。"
	}
	entry := filepath.Join(root, "bin", "ai-home.js")
	if info, err := os.Stat(entry); err != nil || info.IsDir() {
		return "", "", "cli_entry_unavailable", "未找到 bin/ai-home.js，无法启动工作区代理终端。"
	}
	return nodePath, entry, "", ""
}

func discoverRepoRoot() string {
	candidates := make([]string, 0, 2)
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(executable))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	for _, start := range candidates {
		dir := start
		for depth := 0; depth < 6; depth++ {
			if info, err := os.Stat(filepath.Join(dir, "bin", "ai-home.js")); err == nil && !info.IsDir() {
				return dir
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func buildNativeRemoteCommand(aiHomeDir, nodePath, cliEntry, workspaceID, sessionKey string) string {
	if runtime.GOOS == "windows" {
		quoteWin := func(v string) string {
			return `"` + strings.ReplaceAll(v, `"`, `\"`) + `"`
		}
		return `set "AIH_HOME_DIR=` + strings.ReplaceAll(aiHomeDir, `"`, `\"`) + `" && ` +
			quoteWin(nodePath) + ` ` + quoteWin(cliEntry) + ` __remote_ws__ ` + quoteWin(workspaceID) + ` ` + quoteWin(sessionKey)
	}
	return "AIH_HOME_DIR=" + sshhost.ShellQuote(aiHomeDir) + " " +
		sshhost.ShellQuote(nodePath) + " " +
		sshhost.ShellQuote(cliEntry) + " __remote_ws__ " +
		sshhost.ShellQuote(workspaceID) + " " +
		sshhost.ShellQuote(sessionKey)
}

func (handler *WorkspaceTerminalHandler) isDesktopHost() bool {
	if handler.desktopHost != nil {
		return *handler.desktopHost
	}
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		return true
	}
	return strings.TrimSpace(os.Getenv("DISPLAY")) != "" || strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) != ""
}

var proxyHeaderNames = []string{
	"X-Forwarded-For",
	"X-Real-IP",
	"CF-Connecting-IP",
	"Forwarded",
	"X-Aih-Server-Id",
}

func isSameMachineRequest(request *http.Request, peer *clientPeer) bool {
	if request == nil || !isLoopbackAddress(request.RemoteAddr) {
		return false
	}
	for _, header := range proxyHeaderNames {
		if strings.TrimSpace(request.Header.Get(header)) != "" {
			return false
		}
	}
	if peer != nil {
		if !isLoopbackAddress(peer.RemoteAddr) {
			return false
		}
		if strings.TrimSpace(peer.ForwardedFor) != "" ||
			strings.TrimSpace(peer.RealIP) != "" ||
			strings.TrimSpace(peer.CfConnectingIP) != "" ||
			strings.TrimSpace(peer.Forwarded) != "" ||
			strings.TrimSpace(peer.AihServerID) != "" {
			return false
		}
	}
	return true
}

func isLoopbackAddress(raw string) bool {
	address := strings.ToLower(strings.TrimSpace(raw))
	if address == "" {
		return false
	}
	if host, _, err := net.SplitHostPort(address); err == nil {
		address = host
	}
	address = strings.Trim(address, "[]")
	normalized := strings.TrimPrefix(address, "::ffff:")
	return normalized == "::1" || strings.HasPrefix(normalized, "127.")
}

func formatHostDisplay(conn map[string]any) string {
	user := trimmedString(conn["user"])
	host := trimmedString(conn["host"])
	if user != "" {
		return user + "@" + host
	}
	return host
}

func trimmedString(raw any) string {
	value, _ := raw.(string)
	return strings.TrimSpace(value)
}

func rawString(raw any) string {
	value, _ := raw.(string)
	return value
}

func intValue(raw any) int {
	switch typed := raw.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil {
			return parsed
		}
		return 0
	default:
		return 0
	}
}

func randomHex(bytesLen int) string {
	buf := make([]byte, bytesLen)
	if _, err := rand.Read(buf); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(buf)
}
