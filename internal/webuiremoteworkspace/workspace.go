// Package webuiremoteworkspace 提供 WebUI 远程工作区的元数据读取、SSH 跳板解析与远端文件/Git 命令执行。
package webuiremoteworkspace

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

const (
	workspacesKey       = "ssh_workspaces"
	connectionsKey      = "ssh_connections"
	remoteWorkspacesDir = "remote-workspaces"
	maxJumpDepth        = 5
)

// WorkspaceIDPattern 与 Node remote-session-bridge.js 的 WORKSPACE_ID 完全一致。
var WorkspaceIDPattern = regexp.MustCompile(`^ws_[a-f0-9]{16}$`)

// WorkspaceRecord 表示 ssh_workspaces 里的一条远程工作区。
type WorkspaceRecord struct {
	ID           string
	ConnectionID string
	RemoteRoot   string
	Label        string
	Dialect      string
	CreatedAt    int64
	ShadowPath   string
	Host         string
	HostLabel    string
}

// Connection 表示 ssh_connections 展开跳板链后的连接配置。
type Connection struct {
	ID                 string
	Label              string
	Host               string
	User               string
	Port               int
	AuthType           string
	Password           string
	PrivateKey         string
	IdentityFile       string
	EgressConnectionID string
	Jump               *Connection
	HasReverseTunnel   bool
}

// IsWorkspaceID 检查字符串是否为合法远程工作区 ID。
func IsWorkspaceID(value string) bool {
	return WorkspaceIDPattern.MatchString(strings.TrimSpace(value))
}

// ShadowDir 返回工作区在本机的影子目录路径（不自动建目录）。
func ShadowDir(aiHomeDir, workspaceID string) (string, error) {
	id := strings.TrimSpace(workspaceID)
	if !IsWorkspaceID(id) {
		return "", &RemoteError{Status: http.StatusBadRequest, Code: "invalid_remote_workspace", Message: "远程工作区 ID 无效"}
	}
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return "", &RemoteError{Status: http.StatusInternalServerError, Code: "invalid_ai_home_dir", Message: "未配置 ai_home 状态目录"}
	}
	return filepath.Join(root, "run", remoteWorkspacesDir, id), nil
}

// EnsureShadowDir 确保工作区在本机的影子目录存在（权限 0700）。
func EnsureShadowDir(aiHomeDir, workspaceID string) (string, error) {
	dir, err := ShadowDir(aiHomeDir, workspaceID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// WorkspaceIDFromProjectPath 将影子目录路径还原为工作区 ID；不是影子目录返回空串。
func WorkspaceIDFromProjectPath(aiHomeDir, projectPath string) string {
	base := strings.TrimSpace(aiHomeDir)
	if base == "" {
		return ""
	}
	root := filepath.Clean(filepath.Join(base, "run", remoteWorkspacesDir)) + string(filepath.Separator)
	cleanTarget := strings.TrimRight(filepath.Clean(strings.TrimSpace(projectPath)), `/\`)
	if !strings.HasPrefix(cleanTarget, root) {
		return ""
	}
	rest := strings.TrimRight(strings.TrimPrefix(cleanTarget, root), `/\`)
	if !IsWorkspaceID(rest) {
		return ""
	}
	return rest
}

// LoadWorkspaces 读取 ssh_workspaces 并关联 ssh_connections 的展示信息。
func LoadWorkspaces(ctx context.Context, aiHomeDir string) ([]WorkspaceRecord, error) {
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	rawWorkspaces, found, err := appstate.ReadKV(ctx, dbPath, workspacesKey)
	if err != nil || !found || strings.TrimSpace(rawWorkspaces) == "" {
		return nil, err
	}
	var decoded any
	if err := json.Unmarshal([]byte(rawWorkspaces), &decoded); err != nil {
		return nil, nil
	}
	list, ok := decoded.([]any)
	if !ok {
		return nil, nil
	}

	rawConns, connsFound, _ := appstate.ReadKV(ctx, dbPath, connectionsKey)
	connByID := parseConnectionsMap(rawConns, connsFound)

	records := make([]WorkspaceRecord, 0, len(list))
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := stringField(object, "id")
		if !IsWorkspaceID(id) {
			continue
		}
		shadow, shadowErr := ShadowDir(aiHomeDir, id)
		if shadowErr != nil {
			continue
		}
		connID := stringField(object, "connectionId")
		conn := connByID[connID]
		label := stringField(object, "label")
		if label == "" {
			label = stringField(object, "name")
		}
		hostDisplay := ""
		hostLabel := ""
		if conn != nil {
			user := stringField(conn, "user")
			host := stringField(conn, "host")
			if user != "" && host != "" {
				hostDisplay = user + "@" + host
			} else {
				hostDisplay = host
			}
			hostLabel = firstNonEmpty(stringField(conn, "label"), stringField(conn, "name"), host)
		}
		records = append(records, WorkspaceRecord{
			ID:           id,
			ConnectionID: connID,
			RemoteRoot:   stringField(object, "remoteRoot"),
			Label:        label,
			Dialect:      normalizeDialect(stringField(object, "dialect")),
			CreatedAt:    int64Field(object, "createdAt"),
			ShadowPath:   shadow,
			Host:         hostDisplay,
			HostLabel:    hostLabel,
		})
	}
	return records, nil
}

// FindWorkspace 按 workspaceID 查找远程工作区；找不到时 ok=false。
func FindWorkspace(ctx context.Context, aiHomeDir, workspaceID string) (WorkspaceRecord, bool, error) {
	if !IsWorkspaceID(workspaceID) {
		return WorkspaceRecord{}, false, nil
	}
	records, err := LoadWorkspaces(ctx, aiHomeDir)
	if err != nil {
		return WorkspaceRecord{}, false, err
	}
	for _, record := range records {
		if record.ID == workspaceID {
			return record, true, nil
		}
	}
	return WorkspaceRecord{}, false, nil
}

// LoadConnection 按 connectionID 读取并展开跳板链。
func LoadConnection(ctx context.Context, aiHomeDir, connectionID string) (Connection, bool, error) {
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return Connection{}, false, err
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, connectionsKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return Connection{}, false, err
	}
	byID := parseConnectionsMap(raw, true)
	target, ok := byID[strings.TrimSpace(connectionID)]
	if !ok {
		return Connection{}, false, nil
	}
	conn := connectionFromObject(target)
	if resolved, ok := resolveJumpChain(conn, byID, map[string]bool{conn.ID: true}, 0); ok {
		conn = resolved
	}
	return conn, true, nil
}

// ToSSHConfig 将 Connection 转为 sshremote.Config，并在遇到不支持的反向隧道或断链跳板时失败关闭。
func ToSSHConfig(connection Connection, hostHomeDir string) (sshremote.Config, error) {
	if connection.HasReverseTunnel {
		return sshremote.Config{}, &RemoteError{
			Status:  http.StatusBadRequest,
			Code:    "ssh_tunnel_unsupported",
			Message: "该连接使用反向隧道，Go 侧暂未承接。",
		}
	}
	if strings.TrimSpace(connection.EgressConnectionID) != "" && connection.Jump == nil {
		return sshremote.Config{}, &RemoteError{
			Status:  http.StatusBadRequest,
			Code:    "ssh_egress_unresolved",
			Message: "该连接的出口连接不存在或跳板链无效。",
		}
	}
	cfg := sshremote.Config{
		Host:         connection.Host,
		Port:         connection.Port,
		User:         connection.User,
		AuthType:     connection.AuthType,
		Password:     connection.Password,
		PrivateKey:   connection.PrivateKey,
		IdentityFile: connection.IdentityFile,
		HomeDir:      hostHomeDir,
	}
	if connection.Jump != nil {
		jump, err := ToSSHConfig(*connection.Jump, hostHomeDir)
		if err != nil {
			return sshremote.Config{}, err
		}
		cfg.Jump = &jump
	}
	return cfg, nil
}

func parseConnectionsMap(raw string, found bool) map[string]map[string]any {
	byID := make(map[string]map[string]any)
	if !found || strings.TrimSpace(raw) == "" {
		return byID
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return byID
	}
	list, ok := decoded.([]any)
	if !ok {
		return byID
	}
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := stringField(object, "id")
		if id != "" {
			byID[id] = object
		}
	}
	return byID
}

func resolveJumpChain(connection Connection, byID map[string]map[string]any, seen map[string]bool, depth int) (Connection, bool) {
	if connection.EgressConnectionID == "" {
		return connection, true
	}
	if depth >= maxJumpDepth || seen[connection.EgressConnectionID] {
		return connection, false
	}
	object, ok := byID[connection.EgressConnectionID]
	if !ok {
		return connection, false
	}
	seen[connection.EgressConnectionID] = true
	jump := connectionFromObject(object)
	resolvedJump, ok := resolveJumpChain(jump, byID, seen, depth+1)
	if !ok {
		return connection, false
	}
	connection.Jump = &resolvedJump
	return connection, true
}

func connectionFromObject(object map[string]any) Connection {
	port := int(int64Field(object, "port"))
	if port <= 0 || port > 65535 {
		port = 22
	}
	hasTunnel := false
	if tunnel, ok := object["reverseTunnel"].(map[string]any); ok && len(tunnel) > 0 {
		enabled, hasEnabled := tunnel["enabled"].(bool)
		if !hasEnabled || enabled {
			hasTunnel = true
		}
	}
	return Connection{
		ID:                 stringField(object, "id"),
		Label:              stringField(object, "label"),
		Host:               stringField(object, "host"),
		User:               stringField(object, "user"),
		Port:               port,
		AuthType:           stringField(object, "authType"),
		Password:           rawStringField(object, "password"),
		PrivateKey:         rawStringField(object, "privateKey"),
		IdentityFile:       stringField(object, "identityFile"),
		EgressConnectionID: stringField(object, "egressConnectionId"),
		HasReverseTunnel:   hasTunnel,
	}
}

func normalizeDialect(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case DialectPOSIX:
		return DialectPOSIX
	case DialectPowerShell, "windows":
		return DialectPowerShell
	default:
		return ""
	}
}

func stringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return strings.TrimSpace(value)
}

func rawStringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func int64Field(object map[string]any, key string) int64 {
	switch value := object[key].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case json.Number:
		parsed, _ := value.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		return parsed
	default:
		return 0
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// IsNotFoundError 判断错误是否为 RemoteError{Code: "not_found"}。
func IsNotFoundError(err error) bool {
	var remoteErr *RemoteError
	return errors.As(err, &remoteErr) && remoteErr.Code == "not_found"
}
